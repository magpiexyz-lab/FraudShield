# STATE 3: REPRODUCE

**PRECONDITIONS:**
- User approved triage (STATE 2 POSTCONDITIONS met)
- At least one actionable issue remains

**ACTIONS:**

Read `resolve-context.json` and check the `mode` field.

**If `mode == "refine"` AND current issue label is `refine` (trace-derived):**

Do NOT run validators or find a traditional divergence_point. Instead:

1. Read the `trace_summary` entry for this issue's `(skill, state_id)` from resolve-context.json
2. Read the target state file content and analyze:
   - Are instructions ambiguous? (e.g., "check preconditions" vs "check these 8 specific preconditions")
   - Is the VERIFY command too weak? (`"true"` or file-existence-only without content checks)
   - Are PRECONDITIONS missing or underspecified?
3. Write `.runs/resolve-reproduction.json` (format-compatible with normal mode):
   ```json
   {
     "reproductions": [{
       "issue": 0,
       "divergence_point": "<state-file-path>:0",
       "expected": "<clear instructions with strong VERIFY>",
       "actual": "<ambiguous instructions or weak VERIFY>",
       "reproduced": true,
       "reproduction_method": "trace_analysis",
       "evidence": {"failure_rate": 0.35, "sample_size": 20, "team_members_affected": 3}
     }],
     "pre_fix_baseline": {"frontmatter": 0, "semantics": 0, "consistency": 0}
   }
   ```
   Still run validators for `pre_fix_baseline` (needed by later states).

**If `mode == "refine"` AND current issue label is `observation`:**
Use the normal reproduction flow below (no change).

**If `mode` is not `"refine"`:** use the normal reproduction flow below.

For each actionable issue (after user approval of triage):

**Step 0 — Stack Knowledge verification_snippet pre-check (M3 — short-circuit
when upstream fix already exists):**

Before doing the full reproduction, derive a *preliminary* `composite_identity`
from the issue body keywords (root_cause_class, divergence_pattern, stack_scope)
and compute its hash via `compute_hash` from `scripts/lib/stack_knowledge_parser.py`.
Search all SK entries (across `.claude/stacks/**/*.md` + `.claude/scripts/lib/README.md`)
for a matching `composite_identity_hash`. If a match exists AND the matched entry
has a `verification_snippet`, run it and branch on the trinary exit code:

```bash
PRELIM_HASH=$(python3 -c "
import sys
sys.path.insert(0, 'scripts/lib')
from stack_knowledge_parser import compute_hash
ci = {
    'root_cause_class': '<derived from issue body>',
    'divergence_pattern': '<derived from issue body>',
    'stack_scope': '<derived from issue title / cited file path>',
}
print(compute_hash(ci))
")

# Find the matching SK entry
MATCH=$(python3 -c "
import sys, glob, yaml, re
sys.path.insert(0, 'scripts/lib')
from stack_knowledge_parser import iter_stack_knowledge_files, parse_stack_knowledge_file
for sf in iter_stack_knowledge_files():
    for entry in parse_stack_knowledge_file(sf):
        if entry.get('composite_identity_hash') == '$PRELIM_HASH':
            snip = entry.get('verification_snippet')
            if snip:
                print(sf, '||', entry.get('id'), '||', snip)
                sys.exit(0)
")

if [ -n "$MATCH" ]; then
    SNIPPET=$(echo "$MATCH" | awk -F '\\|\\|' '{print $3}' | sed 's/^ *//')
    bash -c "$SNIPPET"
    case $? in
        0) echo "[STATE 3 Step 0] verification_snippet exit 0 — bug present; proceed with reproduction" ;;
        1) echo "[STATE 3 Step 0] verification_snippet exit 1 — bug ABSENT; closing issue as Stale"
           gh issue comment "<N>" --body "verification_snippet from SK entry exits 1 — root cause appears resolved by upstream change. Closing as Stale; reopen if still reproducible on your environment."
           gh issue close "<N>"
           # Skip this issue, continue with next
           continue
           ;;
        2) echo "[STATE 3 Step 0] verification_snippet exit 2 — preconditions not met; proceed with normal reproduction" ;;
        *) echo "[STATE 3 Step 0] WARNING: verification_snippet exit $? — snippet broken; flag for SK maintenance" >&2 ;;
    esac
fi
```

If no SK match or no verification_snippet, proceed with the standard
reproduction flow below. This step is purely an optimization — when an
upstream package fix has resolved the root cause, /resolve closes the
issue automatically without re-running the full STATE 3 → STATE 5d cycle.

Reproduce the issue by tracing through the template as if you were Claude
executing the skill:

1. Read the skill/pattern file cited in the issue
2. Walk through each step, evaluating conditionals against the configuration
   that triggers the bug
3. Identify the exact step and line where behavior diverges from expectation
4. Record: `divergence_point` (file:line), `expected` behavior, `actual` behavior

> **`divergence_point` format contract (machine-enforced by VERIFY below):**
> Each reproduction record MUST have `divergence_point` of the form
> `<file>:<line_token>`, where:
>
> - `<file>` is a single repo-relative path. The file portion must not
>   contain whitespace or embedded separators like ` and `, ` & `, ` vs `,
>   ` + `, or `;`. If an observation cites multiple files, emit one
>   reproduction record per file — downstream analyzers do not split
>   bundles (they extract the first integer only and flag the rest as
>   unanalyzed).
> - `<line_token>` is one of: a single 1-based integer (`34`), a range
>   (`34-55`), or a CSV of integers (`180,217,261`). A parenthesized
>   annotation is allowed (`144 (G6)`) and is ignored by the line parser.
>
> `.claude/scripts/resolve-causal-analyzer.py::parse_line_part` extracts
> the first integer from range/CSV forms and attaches a `line_parse_note`
> on the analysis record so the graceful degradation stays observable in
> downstream artifacts (including the PR body — see state-11-commit-pr.md).
> Producers MUST NOT rely on this fallback: bundled multi-file forms with
> embedded separators are rejected by the VERIFY regex below. Prior to
> this contract, non-integer line parts silently skipped 66% of records
> (see issue #985).

5. **Validator baseline** (machine-verifiable per-issue scaffold):
   Run all 3 validators and capture output as `pre_fix_baseline`:
   - `python3 scripts/validate-frontmatter.py 2>&1`
   - `python3 scripts/validate-semantics.py 2>&1`
   - `bash scripts/consistency-check.sh 2>&1`

6. **Reproduction tier + evidence** (REQUIRED — root-cause empirical verification):
   Each reproduction record MUST include `reproduction` (one of the 4 tiers below)
   AND `evidence` (a concrete artifact ≥30 chars, not a hand-wave from the stoplist).
   Pick the cheapest tier that isolates the claim — avoid escalating beyond what
   proves the cause produces the effect, but do NOT settle for less than what
   proves it. If you cannot produce concrete evidence, drop the issue from
   actionable scope (see "Cannot reproduce" path below) rather than fake it.

   | `reproduction` (tier) | When to use | `evidence` shape |
   |---|---|---|
   | `cite` | Claim is a public standard / 3rd-party doc (W3C, OWASP, RFC, vendor docs) | URL + quoted paragraph (≥30 chars) |
   | `grep` | Claim is "pattern X exists/missing in file Y" | The rg/grep command + ≥30-char excerpt of the result |
   | `exec` | Claim is runtime/version-specific behavior (package semantics, sandbox denial, bundle size) | The isolated repro command (e.g., `cd /tmp && npm install X && node -e "..."`) and the observed output |
   | `validator-fed` | Claim is "validator V rejects input I" | Literal `python3 scripts/validate-X.py` invocation + exit code + first error line |

   Stoplist (rejected by VERIFY in subsequent commits — do NOT use these as evidence):
   `["N/A", "see above", "trace shows", "I traced", "I read the file", "as described", "obvious from"]`.
   These are hand-waves, not evidence. The whole point of this step is empirical
   verification — if you can't write a concrete artifact, drop the issue from
   actionable scope rather than fake an evidence string.

   **Legacy enum (DEPRECATED — accepted with stderr warning for one release cycle, then dropped):**
   - `reproduction = "validator-confirmed"` (legacy alias for `validator-fed`)
   - `reproduction = "simulation-only"` (legacy gray-zone — corresponds to no real evidence; do NOT emit on new runs)

   **Why this matters (issue surfaced post-PR #1397):** the previous gray `simulation-only`
   value let "I read the file" pass as evidence. One /resolve run accepted unverified
   root-cause stories on 7/8 issues; only the critic round-1 caught the one (#1382)
   where the root-cause story was internally inconsistent. The 4-tier enum + concrete
   evidence field replaces critic-as-tripwire with structured proof at the right layer.

**Cannot reproduce:** If the simulation completes without finding a divergence
point, the issue may have been fixed indirectly (e.g., by a refactor or a
related fix that also covered this case). Downgrade the issue to non-actionable:
comment with "Unable to reproduce against current main — the described behavior
no longer occurs. [explain what was checked]. Reopen if the issue persists."
Close the issue and remove it from the actionable list. Continue with remaining
issues.

- **Write reproduction artifact** (`.runs/resolve-reproduction.json`):
  ```bash
  PAYLOAD=$(python3 -c "
  import json
  repro = {
      'reproductions': [
          {
              'issue': 0,
              'divergence_point': '<file:line>',
              'expected': '<...>',
              'actual': '<...>',
              'reproduced': True,
              # REQUIRED (M1): pick the cheapest tier that isolates the claim.
              # See the table in step 6 for tier choice. VERIFY rejects missing
              # evidence (≥30 chars, no stoplist phrases) and missing tier.
              'reproduction': '<cite | grep | exec | validator-fed>',
              'evidence': '<URL + quoted paragraph | rg/grep command + result excerpt | isolated repro command + output | validator invocation + exit code>'
          }
      ],
      'pre_fix_baseline': {'frontmatter': 0, 'semantics': 0, 'consistency': 0}
  }
  print(json.dumps(repro))
  ")
  bash .claude/scripts/lib/write-gate-artifact.sh \
    --path .runs/resolve-reproduction.json \
    --payload "$PAYLOAD" \
    --skill resolve
  ```

  **Per-tier `evidence` examples** (these literal forms, not hand-waves, must appear in the artifact):

  - `cite`: `"WCAG 2.4.1 Bypass Blocks (https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks.html): 'Skip-link target requires programmatic focusability'"`
  - `grep`: `"rg -n 'MAX_PROMPT_CHARS' .claude/stacks/ai/anthropic.md → 0 matches; absence confirms missing cap"`
  - `exec`: `"cd /tmp && mkdir t && cd t && npm init -y && npm install posthog-js && du -h node_modules/posthog-js/dist/module.js → 62.7 kB gz"`
  - `validator-fed`: `"echo '<bad input>' | python3 scripts/validate-experiment.py → exit 1 with: 'tests must be a list of 1-5 strings'"`

**POSTCONDITIONS:**
- Each actionable issue has: `divergence_point`, `expected`, `actual`, `reproduction`, `evidence`
- `reproduction` is one of the 4 tiers (`cite | grep | exec | validator-fed`), or a legacy alias (`validator-confirmed | simulation-only` — deprecated, accepted with warning for one release cycle)
- `evidence` is a non-empty string ≥ 30 chars containing the concrete artifact (cite URL+quote, grep command+excerpt, exec command+output, or validator invocation+exit code); stoplist hand-wave phrases rejected
- `pre_fix_baseline` captured from all 3 validators
- Issues that cannot be reproduced are closed and removed from actionable list
- `.runs/resolve-reproduction.json` exists

**VERIFY:**
```bash
RESOLVE_REPRO_VERIFY_MODE=hard python3 .claude/scripts/verify-resolve-reproduction.py  # .runs/resolve-reproduction.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 3
```

**NEXT:** Read [state-3b-causal-analysis.md](state-3b-causal-analysis.md) to continue.
