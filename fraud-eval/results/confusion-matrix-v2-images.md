# Detection accuracy — confusion matrix

Run: 2026-10-05T08:37:27.314Z
Target: https://fraudshield.draftlabs.org
Scored: 17 of 40

**23 document(s) could not be scored** — listed below. They are EXCLUDED from the matrix rather than counted as correct, which would flatter the result.



### Primary — flagged = suspect or fraud (score ≥ 34)

| | flagged | not flagged |
|---|---|---|
| tampered (0) | 0 | 0 |
| genuine (17) | 1 | 16 |

- caught rate: **0.0%** (bar: ≥ 80.0%) — MISS
- false alarms: **5.9%** (bar: ≤ 10.0%) — PASS

**BELOW BAR**

### Strict — flagged = fraud only (score ≥ 67)

| | flagged | not flagged |
|---|---|---|
| tampered (0) | 0 | 0 |
| genuine (17) | 0 | 17 |

- caught rate: **0.0%** (bar: ≥ 80.0%) — MISS
- false alarms: **0.0%** (bar: ≤ 10.0%) — PASS

**BELOW BAR**

## Missed tampered documents

None.

## False alarms

| file | source | score | verdict |
|---|---|---|---|
| v2-images/statement-9e2d09ea.png | rendered-png | 40 | suspect |

## Not scored

| file | reason |
|---|---|
| v2-images/invoice-7c8bb454.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/invoice-cc58af87.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/invoice-8793a195.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/earnings-4091854b.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/earnings-6e04915e.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/statement-3d8f6a56.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/statement-13099853.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/invoice-35e822cc.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/earnings-63e7ccbe.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/earnings-cae4ed50.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/statement-3ae64127.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/invoice-f11d31ef.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/earnings-e4952b53.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/earnings-23508771.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/statement-22d6ebee.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/invoice-b3751930.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/earnings-4575ed98.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/earnings-1d2019bc.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/statement-d8f08bf9.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/invoice-38033ad1.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/earnings-00b779e5.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/statement-34374312.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |
| v2-images/invoice-1c5f0fc0.png | HTTP 402: {"error":"Free-scan quota exhausted — upgrade to keep scanning."} |

## Per-file results

| file | label | change | source | score | verdict |
|---|---|---|---|---|---|
| v2-images/earnings-5b3d144e.png | genuine |  | rendered-png | 20 | clear |
| v2-images/earnings-6dbbe950.png | genuine |  | rendered-png | 0 | clear |
| v2-images/earnings-e7500ef0.png | genuine |  | rendered-png | 32 | clear |
| v2-images/earnings-4f71767a.png | genuine |  | rendered-png | 20 | clear |
| v2-images/earnings-7f2a37d7.png | genuine |  | rendered-png | 0 | clear |
| v2-images/earnings-b422c704.png | genuine |  | rendered-png | 25 | clear |
| v2-images/earnings-207cdad5.png | genuine |  | rendered-png | 0 | clear |
| v2-images/statement-a4c9e300.png | genuine |  | rendered-png | 0 | clear |
| v2-images/statement-82de2ecb.png | genuine |  | rendered-png | 20 | clear |
| v2-images/statement-41c13869.png | genuine |  | rendered-png | 0 | clear |
| v2-images/statement-c51357f4.png | genuine |  | rendered-png | 20 | clear |
| v2-images/statement-392bb9a1.png | genuine |  | rendered-png | 0 | clear |
| v2-images/statement-15c882dd.png | genuine |  | rendered-png | 0 | clear |
| v2-images/statement-9e2d09ea.png | genuine |  | rendered-png | 40 | suspect |
| v2-images/invoice-fd01492d.png | genuine |  | rendered-png | 20 | clear |
| v2-images/invoice-c373e3d8.png | genuine |  | rendered-png | 0 | clear |
| v2-images/invoice-919b0b3b.png | genuine |  | rendered-png | 0 | clear |
| v2-images/invoice-7c8bb454.png | genuine |  | rendered-png | — | not scored |
| v2-images/invoice-cc58af87.png | genuine |  | rendered-png | — | not scored |
| v2-images/invoice-8793a195.png | genuine |  | rendered-png | — | not scored |
| v2-images/earnings-4091854b.png | tampered | net pay raised $400 to $1,986.88; true net is gross 2280.00 minus deductions 693.12 = 1586.88 | rendered-png | — | not scored |
| v2-images/earnings-6e04915e.png | tampered | gross raised to $4,150.00; rate 41.25 x 80h plus 6.5h OT reconciles to 3702.19 | rendered-png | — | not scored |
| v2-images/statement-3d8f6a56.png | tampered | closing balance raised $2,200 to $11,588.40; transactions run to 9,388.40 | rendered-png | — | not scored |
| v2-images/statement-13099853.png | tampered | a payroll deposit inflated by $6,000; stated closing left at the original 3,529.87 | rendered-png | — | not scored |
| v2-images/invoice-35e822cc.png | tampered | invoice total cut $400 to $4,107.53; subtotal 4,164.00 plus 8.25% tax is 4,507.53 | rendered-png | — | not scored |
| v2-images/earnings-63e7ccbe.png | tampered | pay date moved before the period end | rendered-png | — | not scored |
| v2-images/earnings-cae4ed50.png | tampered | pay period start moved after its end | rendered-png | — | not scored |
| v2-images/statement-3ae64127.png | tampered | one transaction dated outside the statement period | rendered-png | — | not scored |
| v2-images/invoice-f11d31ef.png | tampered | due date moved before the issue date | rendered-png | — | not scored |
| v2-images/earnings-e4952b53.png | tampered | employee name swapped; SSN, employee ID and address still Dana Whitlock's | rendered-png | — | not scored |
| v2-images/earnings-23508771.png | tampered | address swapped to another employee's; employer is in a different state | rendered-png | — | not scored |
| v2-images/statement-22d6ebee.png | tampered | account holder name swapped; address still the original holder's | rendered-png | — | not scored |
| v2-images/invoice-b3751930.png | tampered | bill-to name swapped; billing address still the original client's | rendered-png | — | not scored |
| v2-images/earnings-4575ed98.png | tampered | generic template: round figures, no YTD history, placeholder employer | rendered-png | — | not scored |
| v2-images/earnings-1d2019bc.png | tampered | generic template: no insurance line, YTD equals one period | rendered-png | — | not scored |
| v2-images/statement-d8f08bf9.png | tampered | generic template: round amounts, no merchant detail, three transactions | rendered-png | — | not scored |
| v2-images/invoice-38033ad1.png | tampered | generic template: single line item, placeholder vendor, round total | rendered-png | — | not scored |
| v2-images/earnings-00b779e5.png | tampered | net pay raised $600 to $3,933.71 (true 3,333.71); regenerated with no editing trace | rendered-png | — | not scored |
| v2-images/statement-34374312.png | tampered | closing balance raised $2,000 to $5,529.87 (runs to 3,529.87); regenerated with no editing trace | rendered-png | — | not scored |
| v2-images/invoice-1c5f0fc0.png | tampered | invoice total cut $300 to $1,231.70 (true 1,531.70); regenerated with no editing trace | rendered-png | — | not scored |
