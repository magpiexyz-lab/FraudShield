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

## The v2 set, and what was wrong with v1

`labels-v2.csv` (PDFs) and `labels-v2-images.csv` (the same 40 as PNG) replace
the originals. The first set produced numbers that measured ITSELF, not the
product -- four separate contaminations, none of which surfaced as an error:

| Contamination | Effect |
|---|---|
| Filenames `genuine-paystub-01.pdf`, `tampered-template-02.pdf` | `detectSuspiciousFilename` scores on a keyword list containing **stub** and **template**: 21 fires, 10 points each. The label was also in the name. |
| PDFs written by pdf-lib | Info dictionary lands in a compressed object stream; the route's regex cannot read it and reports **"metadata has been stripped"** -- 31 fires, 20 points each |
| Footers reading *"is a fictional institution used for software testing"*, reserved `000-xx-xxxx` SSNs, `.test` domains | The model reports placeholder text and placeholder identifiers, correctly |
| Three genuine pay stubs whose Regular YTD + Overtime YTD exceeded the Gross YTD printed beside them | Flagged for a real arithmetic contradiction, counted as a false alarm |

Together those produced a 78.9% false-alarm rate that was mostly the set.

**v2 fixes all four.** Filenames are `earnings-`/`statement-`/`invoice-` plus a
hash -- opaque, label-free, and checked against the product's own keyword list
by a test. PDFs are rendered once by Chromium and never post-processed, so the
Info dict stays readable. Identifiers are plausible and fictional. The
arithmetic reconciles.

**What v2 cannot test:** Producer and Creator are now identical across all 40
(Chromium/Skia), so the metadata-forensics axis is not measured. That is the
price of making the metadata readable at all, and it is better stated than
implied by a number.

## Two manifests, and why

| Manifest | Set | Reaches |
|---|---|---|
| `labels.csv` | the original 40 (36 PDF, 4 image) | PDF path for most |
| `labels-images.csv` | the same 40, all rendered PNG | the content pass, for all |

The first run scored **0 of 20** on tampered documents. The cause was not
tuning. `/api/scan` sends only images through the AI content pass:

```ts
const isImage = file.type.startsWith("image/");
const pdfMeta = file.type === "application/pdf" ? extractPdfMetadata(buf) : {};
...
if (isImage) { const vision = await analyzeImageForFraud(buf, docType); ... }
```

A PDF is scored on metadata alone -- producer, creator, dates, page count,
size. Its contents are never read, so an edited salary or a falsified balance
is invisible by construction. The PDF scores bear this out: a constant per
document type, identical for genuine and forged.

With one manifest, "cannot detect forgery in PDFs" and "cannot detect forgery
at all" are indistinguishable, and they call for very different responses. The
image manifest separates them.

Select one with `FRAUD_EVAL_MANIFEST=fraud-eval/labels-images.csv`. Results are
named after the manifest, so neither run overwrites the other's evidence.

**`FRAUD_EVAL_MANIFEST` persists for the whole shell session.** Leaving it out
of the next command does not clear it — the previous value is still set, and the
run quietly measures the wrong set. Clear it explicitly before running the
default manifest:

```powershell
Remove-Item Env:FRAUD_EVAL_MANIFEST     # PowerShell
unset FRAUD_EVAL_MANIFEST               # bash
```

The first line of output names the manifest actually in use. Read it before
waiting half an hour for the result.

## What the metadata in this set can and cannot test

The product does metadata forensics, so the set has to vary metadata or the
matrix silently measures content analysis alone. What it actually varies, after
checking rather than assuming:

| Field | Varies? | Carries |
|---|---|---|
| `Creator` | **yes** | the separating signal — see below |
| `CreationDate` | yes | a plausible issue date per document |
| `Producer` | **no** | identical across all 40 |
| `ModDate` | **no** | identical across all 40 |

`Creator` separates the three classes:

- genuine → the payroll or banking system that issued it
- tampered (17) → the editor that last touched it (Acrobat, Foxit, LibreOffice…)
- clean-metadata (3) → empty

`Producer` and `ModDate` are uniform because the generator writes PDFs with
`pdf-lib`, which stamps both on every save regardless of what is set — including
through the low-level Info dictionary. **So this set cannot test a detector that
relies on a create/modify timestamp gap**, which is a real forensic signal in the
wild. A caught rate measured here is therefore a floor, not a ceiling: a
real-world detector has one more signal available than this set provides.

Worth saying plainly because the first version of the generator did not check,
and produced forty documents with identical producer and that day's date — a set
that would have scored the metadata dimension at zero while looking fine.

## Known gap, stated rather than papered over

Issue #49 asks for printed-and-scanned documents and two phone photos. Those
need a real printer and a real camera; they cannot be generated. Where the set
substitutes programmatic scan artefacts (skew, sensor noise, JPEG recompression)
the manifest says `simulated-scan` in the `source` column, and the results note
it. A confusion matrix that silently counted those as camera captures would be
claiming coverage the set does not have.
