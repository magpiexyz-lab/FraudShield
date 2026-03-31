# STATE 2: PRIORITIZE_AND_OUTPUT

**PRECONDITIONS:**
- Parallel analysis complete with deduplicated findings (STATE 1 POSTCONDITIONS met)

**ACTIONS:**

### Priority matrix

| | Low Effort | Medium Effort | High Effort |
|---|---|---|---|
| **High Impact** | P1 | P2 | P3 |
| **Medium Impact** | P2 | P3 | P4 |
| **Low Impact** | P3 | P4 | — |

### Delta computation

If `prior_findings` is non-empty (from Step 0):
- **New**: findings not in prior audit (by title similarity)
- **Resolved**: prior findings not in current audit
- **Persistent**: findings in both

### Report

Print the report:

```
Template Structural Audit
-------------------------
Scope: <full | hooks | commands | ...>
Files scanned: <N> .md, <N> .sh, <N> .py    Total lines: <N>
Validator baseline: <PASSED | N errors>
Prior audit: <date> (<N> findings) | none

## Duplication (<N> findings)
| # | Pattern | Occurrences | Files | Effort | Priority |
|---|---------|-------------|-------|--------|----------|
| 1 | ...     | ...         | ...   | ...    | P1       |

## Complexity Hotspots (<N> findings)
| # | File | Lines | Issue | Suggestion | Priority |
|---|------|-------|-------|------------|----------|
| 1 | ...  | ...   | ...   | ...        | P2       |

## Abstraction Opportunities (<N> findings)
| # | Pattern | Inline Count | Shared Definition | Priority |
|---|---------|--------------|-------------------|----------|
| 1 | ...     | ...          | ...               | P1       |

## Delta (vs prior audit)
- New: <N> findings
- Resolved: <N> findings
- Persistent: <N> findings
(Or: "First audit — no prior baseline")

## Top 5 Recommendations (by priority)
1. [P1] <one-line summary + suggested next step>
2. [P1] <one-line summary + suggested next step>
3. [P2] <one-line summary + suggested next step>
4. [P2] <one-line summary + suggested next step>
5. [P3] <one-line summary + suggested next step>
```

### Manifest (if --save)

If `save_manifest` is true, write `.claude/runs/audit-manifest.json`:
```json
{
  "timestamp": "<ISO 8601>",
  "scope": "<full|hooks|commands|...>",
  "files_scanned": {"md": "<N>", "sh": "<N>", "py": "<N>"},
  "total_lines": "<N>",
  "total_findings": "<N>",
  "findings": [
    {
      "id": "<D><N>",
      "dimension": "duplication|complexity|abstractability",
      "title": "<title>",
      "impact": "HIGH|MEDIUM|LOW",
      "effort": "LOW|MEDIUM|HIGH",
      "priority": "P1|P2|P3|P4",
      "files": ["<path>"],
      "issue": "<description>",
      "suggestion": "<fix>"
    }
  ],
  "delta": {
    "new": "<N>",
    "resolved": "<N>",
    "persistent": "<N>"
  }
}
```

### Q-score

Compute audit quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.claude/runs/audit-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
AUDIT_DIMS=$(python3 -c "
import json, os
q_findings = 0.5
if os.path.exists('.claude/runs/audit-manifest.json'):
    m = json.load(open('.claude/runs/audit-manifest.json'))
    q_findings = 1.0 if int(m.get('total_findings', 0)) > 0 else 0.5
print(json.dumps({'coverage': 1.0, 'findings': q_findings}))
" 2>/dev/null || echo '{"coverage": 1.0, "findings": 0.5}')
python3 .claude/scripts/write-q-score.py \
  --skill audit --scope audit --archetype N/A \
  --gate 1.0 --dims "$AUDIT_DIMS" \
  --run-id "$RUN_ID" || true
```

## STOP

After printing the report, **STOP**. Do not implement any changes.
The user decides next steps — they may cherry-pick recommendations
and run `/resolve` or manual refactoring for specific items.

**POSTCONDITIONS:**
- Findings prioritized using the priority matrix
- Delta computed against prior audit (if any)
- Report printed to user
- Manifest written (if `--save` flag was set)

**VERIFY:**
```bash
if [ -f .claude/runs/audit-context.json ]; then echo "OK"; else echo "FAIL"; fi
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh audit 2
```

**NEXT:** Read [state-3-skill-epilogue.md](state-3-skill-epilogue.md) to continue.
