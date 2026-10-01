# Detection accuracy — confusion matrix

Run: 2026-10-01T10:08:02.576Z
Target: https://fraudshield.draftlabs.org
Scored: 36 of 40

**4 document(s) could not be scored** — listed below. They are EXCLUDED from the matrix rather than counted as correct, which would flatter the result.



### Primary — flagged = suspect or fraud (score ≥ 34)

| | flagged | not flagged |
|---|---|---|
| tampered (17) | 14 | 3 |
| genuine (19) | 7 | 12 |

- caught rate: **82.4%** (bar: ≥ 80.0%) — PASS
- false alarms: **36.8%** (bar: ≤ 10.0%) — MISS

**BELOW BAR**

### Strict — flagged = fraud only (score ≥ 67)

| | flagged | not flagged |
|---|---|---|
| tampered (17) | 8 | 9 |
| genuine (19) | 0 | 19 |

- caught rate: **47.1%** (bar: ≥ 80.0%) — MISS
- false alarms: **0.0%** (bar: ≤ 10.0%) — PASS

**BELOW BAR**

## Missed tampered documents

| file | change | source | score |
|---|---|---|---|
| images/tampered-identity-01.png | employee name swapped; SSN, employee ID and address still Dana Whitlock's | rendered-png | 0 |
| images/tampered-identity-02.png | address swapped to another employee's; employer is in a different state | rendered-png | 30 |
| images/tampered-identity-03.png | account holder name swapped; address still the original holder's | rendered-png | 0 |

## False alarms

| file | source | score | verdict |
|---|---|---|---|
| images/genuine-paystub-02.png | rendered-png | 50 | suspect |
| images/genuine-paystub-04.png | rendered-png | 42 | suspect |
| images/genuine-paystub-06.png | rendered-png | 35 | suspect |
| images/genuine-paystub-07.png | rendered-png | 54 | suspect |
| images/genuine-statement-02.png | rendered-png | 45 | suspect |
| images/genuine-statement-07.png | rendered-png | 35 | suspect |
| images/genuine-invoice-01.png | rendered-png | 50 | suspect |

## Not scored

| file | reason |
|---|---|
| images/genuine-statement-03.png | request failed: apiRequestContext.post: read ECONNRESET |
| images/tampered-date-03.png | request failed: apiRequestContext.post: read ECONNRESET |
| images/tampered-identity-04.png | request failed: apiRequestContext.post: read ECONNRESET |
| images/tampered-clean-01.png | request failed: apiRequestContext.post: read ECONNRESET |

## Per-file results

| file | label | change | source | score | verdict |
|---|---|---|---|---|---|
| images/genuine-paystub-01.png | genuine |  | rendered-png | 10 | clear |
| images/genuine-paystub-02.png | genuine |  | rendered-png | 50 | suspect |
| images/genuine-paystub-03.png | genuine |  | rendered-png | 10 | clear |
| images/genuine-paystub-04.png | genuine |  | rendered-png | 42 | suspect |
| images/genuine-paystub-05.png | genuine |  | rendered-png | 10 | clear |
| images/genuine-paystub-06.png | genuine |  | rendered-png | 35 | suspect |
| images/genuine-paystub-07.png | genuine |  | rendered-png | 54 | suspect |
| images/genuine-statement-01.png | genuine |  | rendered-png | 0 | clear |
| images/genuine-statement-02.png | genuine |  | rendered-png | 45 | suspect |
| images/genuine-statement-03.png | genuine |  | rendered-png | — | not scored |
| images/genuine-statement-04.png | genuine |  | rendered-png | 20 | clear |
| images/genuine-statement-05.png | genuine |  | rendered-png | 30 | clear |
| images/genuine-statement-06.png | genuine |  | rendered-png | 0 | clear |
| images/genuine-statement-07.png | genuine |  | rendered-png | 35 | suspect |
| images/genuine-invoice-01.png | genuine |  | rendered-png | 50 | suspect |
| images/genuine-invoice-02.png | genuine |  | rendered-png | 0 | clear |
| images/genuine-invoice-03.png | genuine |  | rendered-png | 10 | clear |
| images/genuine-invoice-04.png | genuine |  | rendered-png | 20 | clear |
| images/genuine-invoice-05.png | genuine |  | rendered-png | 0 | clear |
| images/genuine-invoice-06.png | genuine |  | rendered-png | 0 | clear |
| images/tampered-amount-01.png | tampered | net pay raised $400 to $1,986.88; true net is gross 2280.00 minus deductions 693.12 = 1586.88 | rendered-png | 35 | suspect |
| images/tampered-amount-02.png | tampered | gross raised to $4,150.00; rate 41.25 x 80h plus 6.5h OT reconciles to 3702.19 | rendered-png | 98 | fraud |
| images/tampered-amount-03.png | tampered | closing balance raised $2,200 to $11,588.40; transactions run to 9,388.40 | rendered-png | 100 | fraud |
| images/tampered-amount-04.png | tampered | a payroll deposit inflated by $6,000; stated closing left at the original 3,529.87 | rendered-png | 100 | fraud |
| images/tampered-amount-05.png | tampered | invoice total cut $400 to $4,107.53; subtotal 4,164.00 plus 8.25% tax is 4,507.53 | rendered-png | 55 | suspect |
| images/tampered-date-01.png | tampered | pay date moved before the period end | rendered-png | 35 | suspect |
| images/tampered-date-02.png | tampered | pay period start moved after its end | rendered-png | 77 | fraud |
| images/tampered-date-03.png | tampered | one transaction dated outside the statement period | rendered-png | — | not scored |
| images/tampered-date-04.png | tampered | due date moved before the issue date | rendered-png | 80 | fraud |
| images/tampered-identity-01.png | tampered | employee name swapped; SSN, employee ID and address still Dana Whitlock's | rendered-png | 0 | clear |
| images/tampered-identity-02.png | tampered | address swapped to another employee's; employer is in a different state | rendered-png | 30 | clear |
| images/tampered-identity-03.png | tampered | account holder name swapped; address still the original holder's | rendered-png | 0 | clear |
| images/tampered-identity-04.png | tampered | bill-to name swapped; billing address still the original client's | rendered-png | — | not scored |
| images/tampered-template-01.png | tampered | generic template: round figures, no YTD history, placeholder employer | rendered-png | 40 | suspect |
| images/tampered-template-02.png | tampered | generic template: no insurance line, YTD equals one period | rendered-png | 65 | suspect |
| images/tampered-template-03.png | tampered | generic template: round amounts, no merchant detail, three transactions | rendered-png | 65 | suspect |
| images/tampered-template-04.png | tampered | generic template: single line item, placeholder vendor, round total | rendered-png | 70 | fraud |
| images/tampered-clean-01.png | tampered | net pay raised $600 to $3,933.71 (true 3,333.71); regenerated with no editing trace | rendered-png | — | not scored |
| images/tampered-clean-02.png | tampered | closing balance raised $2,000 to $5,529.87 (runs to 3,529.87); regenerated with no editing trace | rendered-png | 85 | fraud |
| images/tampered-clean-03.png | tampered | invoice total cut $300 to $1,231.70 (true 1,531.70); regenerated with no editing trace | rendered-png | 80 | fraud |
