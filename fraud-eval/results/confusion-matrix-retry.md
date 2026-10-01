# Detection accuracy — confusion matrix

Run: 2026-10-01T11:25:12.966Z
Target: https://fraudshield.draftlabs.org
Scored: 4 of 4

All documents scored.



### Primary — flagged = suspect or fraud (score ≥ 34)

| | flagged | not flagged |
|---|---|---|
| tampered (3) | 1 | 2 |
| genuine (1) | 0 | 1 |

- caught rate: **33.3%** (bar: ≥ 80.0%) — MISS
- false alarms: **0.0%** (bar: ≤ 10.0%) — PASS

**BELOW BAR**

### Strict — flagged = fraud only (score ≥ 67)

| | flagged | not flagged |
|---|---|---|
| tampered (3) | 0 | 3 |
| genuine (1) | 0 | 1 |

- caught rate: **0.0%** (bar: ≥ 80.0%) — MISS
- false alarms: **0.0%** (bar: ≤ 10.0%) — PASS

**BELOW BAR**

## Missed tampered documents

| file | change | source | score |
|---|---|---|---|
| images/tampered-date-03.png | one transaction dated outside the statement period | rendered-png | 30 |
| images/tampered-identity-04.png | bill-to name swapped; billing address still the original client's | rendered-png | 0 |

## False alarms

None.

## Per-file results

| file | label | change | source | score | verdict |
|---|---|---|---|---|---|
| images/genuine-statement-03.png | genuine |  | rendered-png | 30 | clear |
| images/tampered-date-03.png | tampered | one transaction dated outside the statement period | rendered-png | 30 | clear |
| images/tampered-identity-04.png | tampered | bill-to name swapped; billing address still the original client's | rendered-png | 0 | clear |
| images/tampered-clean-01.png | tampered | net pay raised $600 to $3,933.71 (true 3,333.71); regenerated with no editing trace | rendered-png | 35 | suspect |
