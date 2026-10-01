# fraud-eval — detection accuracy gate

Line 2 of [`GO-LIVE.md`](../GO-LIVE.md). Measures whether the product's core
claim holds before the first real customer is charged: 40 labelled documents in,
one confusion matrix out.

Specified in [issue #49](https://github.com/magpiexyz-lab/FraudShield/issues/49).

## The rule that matters most

**No document is ever committed to this repository.** It is public, and twenty of
the forty documents are forged financial records. Three of those are built
specifically to defeat metadata forensics — the technique is the payload, so
there is no "obviously fake" version of them that is safe to publish. Making the
employer names silly would not remove the evasion recipe.

What lives here: the script, the manifest, and the results. What lives in the
private bucket: the documents. `.gitignore` in this directory denies everything
by default and re-allows four text files; that is a backstop, not the mechanism.
The mechanism is that `run.mjs` streams each document to a temp directory
**outside the repository**, scans it, and deletes it.

## Layout

| Path | Contents | Tracked |
|---|---|---|
| `labels.csv` | the manifest: file, label, change, source, sha256 | yes |
| `run.mjs` | downloads, scans, scores, writes the matrix | yes |
| `results/` | confusion matrix + per-file table | yes |
| the documents | private Supabase Storage bucket `fraud-eval` | **no** |

The manifest carries a SHA-256 per file. `run.mjs` verifies it after download
and refuses to score a mismatch: a document silently replaced in the bucket
would otherwise produce a confusion matrix about a set nobody can reconstruct.

## The set

20 genuine-style, 20 tampered with one known change each:

| Class | n | Private in every form |
|---|---|---|
| genuine | 20 | no |
| edited amounts | 5 | no |
| edited dates / pay periods | 4 | no |
| name / address swaps | 4 | no |
| cheap-template fakes | 4 | no |
| **clean-metadata fakes** | **3** | **yes** |

The 17 non-evasion tampered documents additionally use invented employers and
reserved identifier ranges — a second layer on top of the private bucket, not a
substitute for it.

## The bar

| Measure | Bar |
|---|---|
| caught rate (recall on tampered) | ≥ 80% |
| false-alarm rate (on genuine) | ≤ 10% |

Below either, the product still ships but the copy changes: the landing page and
`/terms` must call the score an aid rather than a determination, and the result
must show specific findings rather than one number. Then re-run.

## What "flagged" means

The product returns a 0–100 score and derives a verdict from it
(`scoreSeverity` in `src/lib/fraud/score.ts`):

| Score | Verdict |
|---|---|
| 0–33 | `clear` |
| 34–66 | `suspect` |
| ≥ 67 | `fraud` |

A confusion matrix needs a binary, and which cut you take changes the answer, so
**both are reported**:

- **`suspect+`** (score ≥ 34) — the primary figure. A customer shown "suspect"
  has been told something is wrong with the document, so treating it as
  not-flagged would understate what the product actually communicates.
- **`fraud` only** (score ≥ 67) — the strict reading, reported alongside.

The script does not invent a threshold of its own. If the product's bands change,
the matrix changes with them, which is the point.

## Running it

```bash
# Document bucket (service role: the bucket is private)
export NEXT_PUBLIC_SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...

# The account the scans run as. Needs quota for 40 scans -- a Pro
# subscription, or a comped row (plan 'comped', status active, quota 100+).
export FRAUD_EVAL_EMAIL=...
export FRAUD_EVAL_PASSWORD=...

# Defaults to http://localhost:3000
export FRAUD_EVAL_BASE_URL=https://fraudshield.draftlabs.org

node fraud-eval/run.mjs
```

Scans run through `/api/scan` inside a real authenticated browser session, which
is the same path a customer's upload takes. Results land in `results/`.

### Adding or replacing a document

1. Upload it to the private `fraud-eval` bucket.
2. Add a row to `labels.csv` with its SHA-256
   (`shasum -a 256 <file>` / `Get-FileHash -Algorithm SHA256`).
3. Never copy it into the repository, not even temporarily.

## Known gap, stated rather than papered over

Issue #49 asks for printed-and-scanned documents and two phone photos. Those
need a real printer and a real camera; they cannot be generated. Where the set
substitutes programmatic scan artefacts (skew, sensor noise, JPEG recompression)
the manifest says `simulated-scan` in the `source` column, and the results note
it. A confusion matrix that silently counted those as camera captures would be
claiming coverage the set does not have.
