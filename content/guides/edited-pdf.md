---
slug: edited-pdf
path: /guides/edited-pdf
canonical: /guides/edited-pdf
title: "How to tell if a PDF has been edited (metadata and more)"
description: "Often you can. Check the metadata, look inside the file for extra saves and odd fonts, compare with an original, and know when the trail runs out."
links_to: [/guides/fake-pay-stub, /guides/fake-bank-statement, /signup]
faq_schema: optional (FAQPage JSON-LD from the H3 questions under "Frequently asked questions", answers word for word)
---

# How to tell if a PDF has been edited

Often, yes. Editing a PDF usually leaves traces in the metadata and in the file structure: a modified date after the created date, an editing program in the Producer field, or extra saved revisions. A careful editor can remove most of these. So treat every finding as a clue, and verify important documents with whoever issued them.

This guide is for anyone who has received a PDF, whether a [pay stub](/guides/fake-pay-stub), a [bank statement](/guides/fake-bank-statement), an invoice or a contract, and needs to know whether it is the file the sender says it is. Nothing here needs paid software.

## Check the metadata (five minutes, free)

Every PDF carries a small block of information about itself. Open the file in your PDF reader and look for Document Properties, usually under the File menu. You will see fields such as Title, Author, Creator, Producer, Created and Modified.

- Creator is the program that made the content. Producer is the library that wrote the PDF file. A statement from a bank or a stub from a payroll system usually names that system or a standard report engine in these fields.
- On the command line, `exiftool file.pdf` prints the same fields plus the XMP history when it exists, and `pdfinfo file.pdf` prints the basic fields and the PDF version.

What to look for:

- An image editor, a desktop or online PDF editor, or a word processor in Creator or Producer, when the document is supposed to come from a bank, a payroll system or an accounting system.
- A Modified date later than the Created date. A Created date later than the date printed on the document.
- Empty metadata on a document type that normally carries it.
- Several entries in the XMP history, which shows the document was saved more than once.

What it does not prove:

- Adding a comment, a highlight or a signature field also updates the Modified date.
- Printing to PDF or flattening wipes the history and resets the fields.
- Metadata is plain text. Anyone who knows it is there can change it.

## Look inside the file

The metadata is the cover. The file structure is the book.

- Extra saves. A PDF that was edited and saved on top of the original often contains more than one `%%EOF` marker, because the edits are appended as an incremental update. Open the file in a plain text editor and search for `%%EOF`. More than one means the file was saved again after it was created. Some tools also report the number of revisions.
- Fonts. The Fonts tab in Document Properties lists every font the file uses. A document that uses one font family everywhere, plus a second font or a separate subset of the same font that appears only in a few numbers, is a strong clue that those numbers were typed in later.
- Text over image. Some fakes start with a scan and lay typed text on top. Try selecting the text. If the page is a picture except for a few selectable numbers, ask why.
- Copy and paste. Select all the text on a page and paste it into a plain text editor. Edited numbers sometimes paste out of order, split into pieces, or carry odd characters.
- Zoom. Zoom in to three or four times the normal size and look along a column of figures. Edited digits often sit a hair above or below the baseline, or have a slightly different stroke weight.

## Compare with a known original

If you have an earlier document from the same issuer, or a copy you obtained directly from the issuer, put the two side by side. Many PDF readers have a compare function that highlights differences. A PDF that was digitally signed with a certificate will report whether it changed after signing. Most bank statements and pay stubs are not signed that way, so the absence of a signature means nothing.

## What a scan adds, and what it does not

Everything above is work you can do by hand, and we think you should. An automated scan adds a consistent second look for signs that values or text in the document were replaced or edited, and it returns a score from 0 to 100 built from the specific signals it found. It does not know who issued the document, and it cannot see what the original said. So the score is a flag to look into, not an answer.

Want a second pair of eyes on the file? Upload it to [FraudShield](/signup). Sign up and your first scan is free. In a few seconds you get a score from 0 to 100 for signs the document was altered, and how many signals the scan found. Treat the score as one more input, not a verdict.

No scan, ours included, replaces confirming the document with whoever issued it.

## Limits, and when to go to the source

- No traces does not mean no edits. A file that was printed to PDF, flattened, or rebuilt from scratch carries no history.
- A photo or a scan of a document is an image. None of the checks on this page apply to it, so ask for the original file.
- Keep the file you received. Do not open it, annotate it and save over it, or you will add your own traces.
- If money or a legal decision depends on the document, go to the issuer: the bank, the employer or payroll provider, the vendor. For a dispute, use a qualified document examiner.

## Frequently asked questions

### Can you see when a PDF was edited?

Sometimes. The Modified date in the properties is the last save, and the XMP history, when present, lists earlier saves. Both can be wiped or changed, and any save, including adding a comment, updates the date. So the date tells you the file was touched, not what was changed.

### Does adding a comment change the modified date?

Yes. Comments, highlights, form entries and signatures are all saved into the file and update the Modified date, usually as an incremental update. A later Modified date on its own is not evidence of a changed figure.

### Can AI detect an edited PDF?

Automated tools, including ones that use machine learning, look for the same kinds of traces described on this page and can do it consistently across many files. They produce a score and a list of signals, not a verdict. If the file carries no traces, no tool can tell you more than you could find yourself, and the answer is to go back to the issuer.

### How to tell if a document has been altered by AI?

The same way as any other edit. Whatever tool made the change, the trail is in the metadata, the file structure, the fonts and a comparison with an original. When there is no trail, the document has to be verified with the issuer. The tool used to alter a file matters less than whether you can confirm the file with the people who made it.

FraudShield team · October 2026
