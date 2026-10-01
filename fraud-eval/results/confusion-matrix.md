# Detection accuracy — confusion matrix

Run: 2026-10-01T08:49:09.170Z
Target: https://fraudshield.draftlabs.org
Scored: 40 of 40

All documents scored.



### Primary — flagged = suspect or fraud (score ≥ 34)

| | flagged | not flagged |
|---|---|---|
| tampered (20) | 0 | 20 |
| genuine (20) | 2 | 18 |

- caught rate: **0.0%** (bar: ≥ 80.0%) — MISS
- false alarms: **10.0%** (bar: ≤ 10.0%) — PASS

**BELOW BAR**

### Strict — flagged = fraud only (score ≥ 67)

| | flagged | not flagged |
|---|---|---|
| tampered (20) | 0 | 20 |
| genuine (20) | 0 | 20 |

- caught rate: **0.0%** (bar: ≥ 80.0%) — MISS
- false alarms: **0.0%** (bar: ≤ 10.0%) — PASS

**BELOW BAR**

## Missed tampered documents

| file | change | source | score |
|---|---|---|---|
| tampered-amount-01.pdf | net pay raised $400 to $1,986.88; true net is gross 2280.00 minus deductions 693.12 = 1586.88 | generated-pdf-edited | 20 |
| tampered-amount-02.pdf | gross raised to $4,150.00; rate 41.25 x 80h plus 6.5h OT reconciles to 3702.19 | generated-pdf-edited | 20 |
| tampered-amount-03.pdf | closing balance raised $2,200 to $11,588.40; transactions run to 9,388.40 | generated-pdf-edited | 20 |
| tampered-amount-04.pdf | a payroll deposit inflated by $6,000; stated closing left at the original 3,529.87 | generated-pdf-edited | 20 |
| tampered-amount-05.pdf | invoice total cut $400 to $4,107.53; subtotal 4,164.00 plus 8.25% tax is 4,507.53 | generated-pdf-edited | 20 |
| tampered-date-01.pdf | pay date moved before the period end | generated-pdf-edited | 20 |
| tampered-date-02.pdf | pay period start moved after its end | generated-pdf-edited | 20 |
| tampered-date-03.pdf | one transaction dated outside the statement period | generated-pdf-edited | 20 |
| tampered-date-04.pdf | due date moved before the issue date | generated-pdf-edited | 20 |
| tampered-identity-01.pdf | employee name swapped; SSN, employee ID and address still Dana Whitlock's | generated-pdf-edited | 20 |
| tampered-identity-02.pdf | address swapped to another employee's; employer is in a different state | generated-pdf-edited | 20 |
| tampered-identity-03.pdf | account holder name swapped; address still the original holder's | generated-pdf-edited | 20 |
| tampered-identity-04.pdf | bill-to name swapped; billing address still the original client's | generated-pdf-edited | 20 |
| tampered-template-01.pdf | generic template: round figures, no YTD history, placeholder employer | generated-pdf-edited | 30 |
| tampered-template-02.pdf | generic template: no insurance line, YTD equals one period | generated-pdf-edited | 30 |
| tampered-template-03.pdf | generic template: round amounts, no merchant detail, three transactions | generated-pdf-edited | 30 |
| tampered-template-04.pdf | generic template: single line item, placeholder vendor, round total | generated-pdf-edited | 30 |
| tampered-clean-01.pdf | net pay raised $600 to $3,933.71 (true 3,333.71); regenerated with no editing trace | generated-pdf-clean-metadata | 20 |
| tampered-clean-02.pdf | closing balance raised $2,000 to $5,529.87 (runs to 3,529.87); regenerated with no editing trace | generated-pdf-clean-metadata | 20 |
| tampered-clean-03.pdf | invoice total cut $300 to $1,231.70 (true 1,531.70); regenerated with no editing trace | generated-pdf-clean-metadata | 20 |

## False alarms

| file | source | score | verdict |
|---|---|---|---|
| genuine-paystub-07.jpg | simulated-scan | 65 | suspect |
| genuine-invoice-06.jpg | simulated-scan | 45 | suspect |

## Per-file results

| file | label | change | source | score | verdict |
|---|---|---|---|---|---|
| genuine-paystub-01.pdf | genuine |  | generated-pdf | 30 | clear |
| genuine-paystub-02.pdf | genuine |  | generated-pdf | 30 | clear |
| genuine-paystub-03.pdf | genuine |  | generated-pdf | 30 | clear |
| genuine-paystub-04.pdf | genuine |  | generated-pdf | 30 | clear |
| genuine-paystub-05.pdf | genuine |  | generated-pdf | 30 | clear |
| genuine-paystub-06.png | genuine |  | simulated-scan | 10 | clear |
| genuine-paystub-07.jpg | genuine |  | simulated-scan | 65 | suspect |
| genuine-statement-01.pdf | genuine |  | generated-pdf | 20 | clear |
| genuine-statement-02.pdf | genuine |  | generated-pdf | 20 | clear |
| genuine-statement-03.pdf | genuine |  | generated-pdf | 20 | clear |
| genuine-statement-04.pdf | genuine |  | generated-pdf | 20 | clear |
| genuine-statement-05.pdf | genuine |  | generated-pdf | 20 | clear |
| genuine-statement-06.pdf | genuine |  | generated-pdf | 20 | clear |
| genuine-statement-07.png | genuine |  | simulated-scan | 0 | clear |
| genuine-invoice-01.pdf | genuine |  | generated-pdf | 20 | clear |
| genuine-invoice-02.pdf | genuine |  | generated-pdf | 20 | clear |
| genuine-invoice-03.pdf | genuine |  | generated-pdf | 20 | clear |
| genuine-invoice-04.pdf | genuine |  | generated-pdf | 20 | clear |
| genuine-invoice-05.pdf | genuine |  | generated-pdf | 20 | clear |
| genuine-invoice-06.jpg | genuine |  | simulated-scan | 45 | suspect |
| tampered-amount-01.pdf | tampered | net pay raised $400 to $1,986.88; true net is gross 2280.00 minus deductions 693.12 = 1586.88 | generated-pdf-edited | 20 | clear |
| tampered-amount-02.pdf | tampered | gross raised to $4,150.00; rate 41.25 x 80h plus 6.5h OT reconciles to 3702.19 | generated-pdf-edited | 20 | clear |
| tampered-amount-03.pdf | tampered | closing balance raised $2,200 to $11,588.40; transactions run to 9,388.40 | generated-pdf-edited | 20 | clear |
| tampered-amount-04.pdf | tampered | a payroll deposit inflated by $6,000; stated closing left at the original 3,529.87 | generated-pdf-edited | 20 | clear |
| tampered-amount-05.pdf | tampered | invoice total cut $400 to $4,107.53; subtotal 4,164.00 plus 8.25% tax is 4,507.53 | generated-pdf-edited | 20 | clear |
| tampered-date-01.pdf | tampered | pay date moved before the period end | generated-pdf-edited | 20 | clear |
| tampered-date-02.pdf | tampered | pay period start moved after its end | generated-pdf-edited | 20 | clear |
| tampered-date-03.pdf | tampered | one transaction dated outside the statement period | generated-pdf-edited | 20 | clear |
| tampered-date-04.pdf | tampered | due date moved before the issue date | generated-pdf-edited | 20 | clear |
| tampered-identity-01.pdf | tampered | employee name swapped; SSN, employee ID and address still Dana Whitlock's | generated-pdf-edited | 20 | clear |
| tampered-identity-02.pdf | tampered | address swapped to another employee's; employer is in a different state | generated-pdf-edited | 20 | clear |
| tampered-identity-03.pdf | tampered | account holder name swapped; address still the original holder's | generated-pdf-edited | 20 | clear |
| tampered-identity-04.pdf | tampered | bill-to name swapped; billing address still the original client's | generated-pdf-edited | 20 | clear |
| tampered-template-01.pdf | tampered | generic template: round figures, no YTD history, placeholder employer | generated-pdf-edited | 30 | clear |
| tampered-template-02.pdf | tampered | generic template: no insurance line, YTD equals one period | generated-pdf-edited | 30 | clear |
| tampered-template-03.pdf | tampered | generic template: round amounts, no merchant detail, three transactions | generated-pdf-edited | 30 | clear |
| tampered-template-04.pdf | tampered | generic template: single line item, placeholder vendor, round total | generated-pdf-edited | 30 | clear |
| tampered-clean-01.pdf | tampered | net pay raised $600 to $3,933.71 (true 3,333.71); regenerated with no editing trace | generated-pdf-clean-metadata | 20 | clear |
| tampered-clean-02.pdf | tampered | closing balance raised $2,000 to $5,529.87 (runs to 3,529.87); regenerated with no editing trace | generated-pdf-clean-metadata | 20 | clear |
| tampered-clean-03.pdf | tampered | invoice total cut $300 to $1,231.70 (true 1,531.70); regenerated with no editing trace | generated-pdf-clean-metadata | 20 | clear |
