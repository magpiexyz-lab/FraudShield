# Detection accuracy — confusion matrix

Run: 2026-10-05T04:52:54.550Z
Target: https://fraudshield.draftlabs.org
Scored: 40 of 40

All documents scored.



### Primary — flagged = suspect or fraud (score ≥ 34)

| | flagged | not flagged |
|---|---|---|
| tampered (20) | 13 | 7 |
| genuine (20) | 3 | 17 |

- caught rate: **65.0%** (bar: ≥ 80.0%) — MISS
- false alarms: **15.0%** (bar: ≤ 10.0%) — MISS

**BELOW BAR**

### Strict — flagged = fraud only (score ≥ 67)

| | flagged | not flagged |
|---|---|---|
| tampered (20) | 5 | 15 |
| genuine (20) | 0 | 20 |

- caught rate: **25.0%** (bar: ≥ 80.0%) — MISS
- false alarms: **0.0%** (bar: ≤ 10.0%) — PASS

**BELOW BAR**

## Missed tampered documents

| file | change | source | score |
|---|---|---|---|
| v2/earnings-6e04915e.pdf | gross raised to $4,150.00; rate 41.25 x 80h plus 6.5h OT reconciles to 3702.19 | chromium-pdf | 5 |
| v2/statement-3ae64127.pdf | one transaction dated outside the statement period | chromium-pdf | 30 |
| v2/invoice-f11d31ef.pdf | due date moved before the issue date | chromium-pdf | 30 |
| v2/earnings-e4952b53.pdf | employee name swapped; SSN, employee ID and address still Dana Whitlock's | chromium-pdf | 5 |
| v2/earnings-23508771.pdf | address swapped to another employee's; employer is in a different state | chromium-pdf | 30 |
| v2/statement-22d6ebee.pdf | account holder name swapped; address still the original holder's | chromium-pdf | 5 |
| v2/invoice-b3751930.pdf | bill-to name swapped; billing address still the original client's | chromium-pdf | 5 |

## False alarms

| file | source | score | verdict |
|---|---|---|---|
| v2/earnings-5b3d144e.pdf | chromium-pdf | 53 | suspect |
| v2/invoice-fd01492d.pdf | chromium-pdf | 35 | suspect |
| v2/invoice-7c8bb454.pdf | chromium-pdf | 37 | suspect |

## Per-file results

| file | label | change | source | score | verdict |
|---|---|---|---|---|---|
| v2/earnings-5b3d144e.pdf | genuine |  | chromium-pdf | 53 | suspect |
| v2/earnings-6dbbe950.pdf | genuine |  | chromium-pdf | 25 | clear |
| v2/earnings-e7500ef0.pdf | genuine |  | chromium-pdf | 25 | clear |
| v2/earnings-4f71767a.pdf | genuine |  | chromium-pdf | 30 | clear |
| v2/earnings-7f2a37d7.pdf | genuine |  | chromium-pdf | 25 | clear |
| v2/earnings-b422c704.pdf | genuine |  | chromium-pdf | 30 | clear |
| v2/earnings-207cdad5.pdf | genuine |  | chromium-pdf | 5 | clear |
| v2/statement-a4c9e300.pdf | genuine |  | chromium-pdf | 5 | clear |
| v2/statement-82de2ecb.pdf | genuine |  | chromium-pdf | 5 | clear |
| v2/statement-41c13869.pdf | genuine |  | chromium-pdf | 30 | clear |
| v2/statement-c51357f4.pdf | genuine |  | chromium-pdf | 5 | clear |
| v2/statement-392bb9a1.pdf | genuine |  | chromium-pdf | 5 | clear |
| v2/statement-15c882dd.pdf | genuine |  | chromium-pdf | 30 | clear |
| v2/statement-9e2d09ea.pdf | genuine |  | chromium-pdf | 5 | clear |
| v2/invoice-fd01492d.pdf | genuine |  | chromium-pdf | 35 | suspect |
| v2/invoice-c373e3d8.pdf | genuine |  | chromium-pdf | 5 | clear |
| v2/invoice-919b0b3b.pdf | genuine |  | chromium-pdf | 5 | clear |
| v2/invoice-7c8bb454.pdf | genuine |  | chromium-pdf | 37 | suspect |
| v2/invoice-cc58af87.pdf | genuine |  | chromium-pdf | 5 | clear |
| v2/invoice-8793a195.pdf | genuine |  | chromium-pdf | 5 | clear |
| v2/earnings-4091854b.pdf | tampered | net pay raised $400 to $1,986.88; true net is gross 2280.00 minus deductions 693.12 = 1586.88 | chromium-pdf | 40 | suspect |
| v2/earnings-6e04915e.pdf | tampered | gross raised to $4,150.00; rate 41.25 x 80h plus 6.5h OT reconciles to 3702.19 | chromium-pdf | 5 | clear |
| v2/statement-3d8f6a56.pdf | tampered | closing balance raised $2,200 to $11,588.40; transactions run to 9,388.40 | chromium-pdf | 70 | fraud |
| v2/statement-13099853.pdf | tampered | a payroll deposit inflated by $6,000; stated closing left at the original 3,529.87 | chromium-pdf | 85 | fraud |
| v2/invoice-35e822cc.pdf | tampered | invoice total cut $400 to $4,107.53; subtotal 4,164.00 plus 8.25% tax is 4,507.53 | chromium-pdf | 60 | suspect |
| v2/earnings-63e7ccbe.pdf | tampered | pay date moved before the period end | chromium-pdf | 47 | suspect |
| v2/earnings-cae4ed50.pdf | tampered | pay period start moved after its end | chromium-pdf | 72 | fraud |
| v2/statement-3ae64127.pdf | tampered | one transaction dated outside the statement period | chromium-pdf | 30 | clear |
| v2/invoice-f11d31ef.pdf | tampered | due date moved before the issue date | chromium-pdf | 30 | clear |
| v2/earnings-e4952b53.pdf | tampered | employee name swapped; SSN, employee ID and address still Dana Whitlock's | chromium-pdf | 5 | clear |
| v2/earnings-23508771.pdf | tampered | address swapped to another employee's; employer is in a different state | chromium-pdf | 30 | clear |
| v2/statement-22d6ebee.pdf | tampered | account holder name swapped; address still the original holder's | chromium-pdf | 5 | clear |
| v2/invoice-b3751930.pdf | tampered | bill-to name swapped; billing address still the original client's | chromium-pdf | 5 | clear |
| v2/earnings-4575ed98.pdf | tampered | generic template: round figures, no YTD history, placeholder employer | chromium-pdf | 59 | suspect |
| v2/earnings-1d2019bc.pdf | tampered | generic template: no insurance line, YTD equals one period | chromium-pdf | 100 | fraud |
| v2/statement-d8f08bf9.pdf | tampered | generic template: round amounts, no merchant detail, three transactions | chromium-pdf | 40 | suspect |
| v2/invoice-38033ad1.pdf | tampered | generic template: single line item, placeholder vendor, round total | chromium-pdf | 55 | suspect |
| v2/earnings-00b779e5.pdf | tampered | net pay raised $600 to $3,933.71 (true 3,333.71); regenerated with no editing trace | chromium-pdf | 55 | suspect |
| v2/statement-34374312.pdf | tampered | closing balance raised $2,000 to $5,529.87 (runs to 3,529.87); regenerated with no editing trace | chromium-pdf | 77 | fraud |
| v2/invoice-1c5f0fc0.pdf | tampered | invoice total cut $300 to $1,231.70 (true 1,531.70); regenerated with no editing trace | chromium-pdf | 40 | suspect |
