# Detection accuracy — image set, complete

All 40 documents scored. Supersedes `confusion-matrix-images.md`, where four
documents failed with ECONNRESET and were excluded, leaving denominators of 17
and 19. Those four were rescanned from `labels-retry.csv` and merged here.

**Completing the set LOWERED the caught rate, from 82.4% to 75.0%.** Two of the
four missing documents turned out to be misses, so the partial figure flattered
the product. That is the reason the gate is run over a whole set.

Source: `per-file-images.csv` + `per-file-retry.csv` -> `per-file-images-final.csv`.

## Primary — flagged = suspect or fraud (score >= 34)

| | flagged | not flagged |
|---|---|---|
| tampered (20) | 15 | 5 |
| genuine (20) | 7 | 13 |

- caught rate: **75.0%** (bar: >= 80.0%) — MISS
- false alarms: **35.0%** (bar: <= 10.0%) — MISS

**BELOW BAR**

## Strict — flagged = fraud only (score >= 67)

| | flagged | not flagged |
|---|---|---|
| tampered (20) | 8 | 12 |
| genuine (20) | 0 | 20 |

- caught rate: **40.0%** (bar: >= 80.0%) — MISS
- false alarms: **0.0%** (bar: <= 10.0%) — PASS

**BELOW BAR**

## Missed tampered documents

| file | score | change |
|---|---|---|
| tampered-date-03.png | 25 | one transaction dated outside the statement period |
| tampered-identity-01.png | 0 | employee name swapped; SSN, employee ID and address still Dana Whitlock's |
| tampered-identity-02.png | 30 | address swapped to another employee's; employer is in a different state |
| tampered-identity-03.png | 0 | account holder name swapped; address still the original holder's |
| tampered-identity-04.png | 0 | bill-to name swapped; billing address still the original client's |

**Four of the five are identity swaps — the entire category, 0 of 4.** Detecting a
name that does not belong requires a second source to check against, and the
product has none. This is a scope limit of the design, not model quality.

The fifth is a transaction dated outside its statement period: a contradiction
visible within the document, and the only one of that kind that was missed.

## False alarms

| file | score | verdict |
|---|---|---|
| genuine-paystub-02.png | 50 | suspect |
| genuine-paystub-04.png | 42 | suspect |
| genuine-paystub-06.png | 35 | suspect |
| genuine-paystub-07.png | 54 | suspect |
| genuine-statement-02.png | 45 | suspect |
| genuine-statement-07.png | 35 | suspect |
| genuine-invoice-01.png | 50 | suspect |

All seven fall in 35-54, the lower half of the suspect band. None reached fraud,
which is why the strict cut records no false alarms at all.
