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

5. **Validator evidence** (machine-verifiable baseline):
   Run all 3 validators and capture output as `pre_fix_baseline`:
   - `python3 scripts/validate-frontmatter.py 2>&1`
   - `python3 scripts/validate-semantics.py 2>&1`
   - `bash scripts/consistency-check.sh 2>&1`

   Search validator output for errors citing the issue's file(s).
   If a validator error corresponds to the divergence_point:
   `reproduction = "validator-confirmed"` + the error line(s).
   Otherwise: `reproduction = "simulation-only"` (acceptable for
   prose/logic bugs that validators cannot catch).

**Cannot reproduce:** If the simulation completes without finding a divergence
point, the issue may have been fixed indirectly (e.g., by a refactor or a
related fix that also covered this case). Downgrade the issue to non-actionable:
comment with "Unable to reproduce against current main — the described behavior
no longer occurs. [explain what was checked]. Reopen if the issue persists."
Close the issue and remove it from the actionable list. Continue with remaining
issues.

- **Write reproduction artifact** (`.runs/resolve-reproduction.json`):
  ```bash
  python3 -c "
  import json
  repro = {
      'reproductions': [
          {'issue': 0, 'divergence_point': '<file:line>', 'expected': '<...>', 'actual': '<...>', 'reproduced': True}
      ],
      'pre_fix_baseline': {'frontmatter': 0, 'semantics': 0, 'consistency': 0}
  }
  json.dump(repro, open('.runs/resolve-reproduction.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Each actionable issue has: `divergence_point`, `expected`, `actual`, `reproduction`
- `pre_fix_baseline` captured from all 3 validators
- Issues that cannot be reproduced are closed and removed from actionable list
- `.runs/resolve-reproduction.json` exists

**VERIFY:**
```bash
python3 -c "import json,re; d=json.load(open('.runs/resolve-reproduction.json')); rs=d.get('reproductions',[]); assert isinstance(rs, list) and len(rs)>0, 'reproductions empty'; r=rs[0]; assert 'divergence_point' in r, 'divergence_point missing'; assert 'expected' in r, 'expected missing'; assert 'actual' in r, 'actual missing'; b=d.get('pre_fix_baseline',{}); assert 'frontmatter' in b and 'semantics' in b and 'consistency' in b, 'pre_fix_baseline incomplete'; bad=re.compile(r'\s+(?:and|&|vs|\+|;)\s+',re.IGNORECASE); offenders=[x.get('divergence_point','') for x in rs if isinstance(x,dict) and bad.search(x.get('divergence_point',''))]; assert not offenders, 'divergence_point contract violated - embedded separator: ' + repr(offenders)"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 3
```

**NEXT:** Read [state-3b-causal-analysis.md](state-3b-causal-analysis.md) to continue.
