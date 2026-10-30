// b-12 — the three how-to guides, verbatim.
//
// These pages are the top of the funnel: someone searching "how to tell if a
// pay stub is fake" at the moment they have one in front of them. Every
// sentence below was written by hand and checked against what the scan
// actually reports before it was approved, which is why this module exists
// rather than the prose living inside page.tsx.
//
// Two reasons, both learned from src/lib/billing-copy.ts:
//
// 1. Testability. vitest runs with environment "node" and this project has no
//    jsdom, so a rendered page cannot be asserted. Text that makes a claim
//    about the product has to live somewhere a node test can read it, and
//    tests/guides-copy.test.ts pins the frontmatter and every FAQ answer back
//    to the manager's source documents in content/guides/*.md.
// 2. Reuse without duplication. Each guide's title and description go into
//    page metadata, its FAQ goes into FAQPage JSON-LD as well as into the
//    visible page, and its cross-links are checked against the registry. A
//    second copy of a sentence is a second thing to keep true.
//
// A source-text test against JSX was the other option and is a trap: Prettier
// re-wraps JSX text nodes and the compiler escapes entities, so the assertion
// breaks on formatting rather than on meaning, and gets deleted the first time
// it cries wolf.
//
// EDITING RULES. The copy is manager-written and deliberately plain. Do not
// tighten it, do not Americanise the spelling, do not "fix" a sentence that
// reads long. Several passages are hedged on purpose ("clues, not proof",
// "one more input, not a verdict") because the scan returns a score and not a
// verdict, and an edit that removes the hedge makes the site promise something
// the product does not do. If the copy needs to change, change
// content/guides/<slug>.md first and bring this module with it.
//
// One transcription note: the source markdown sets a few terms in backticks
// (exiftool file.pdf, %%EOF). The words are reproduced exactly; the backtick
// markers are not, because Span has no code kind and a literal backtick would
// render on the page as a stray character.

/**
 * A run of body text. A bare string is plain prose; the object form is a link.
 *
 * Spans rather than billing-copy's `body: string` because these guides put
 * links in the MIDDLE of sentences — "whether a [pay stub](...), a [bank
 * statement](...), an invoice or a contract" — so a block cannot be one string
 * plus an optional trailing link without breaking the sentence.
 */
export type Span = string | { text: string; href: string };

/**
 * One piece of body content: a paragraph, or a bullet list whose items are
 * themselves span runs (several bullets carry mid-sentence links).
 *
 * Arrays are readonly throughout because GUIDES is declared `as const`, which
 * freezes every nested array. A mutable `Span[]` here would make the whole
 * registry fail its own `satisfies` check.
 */
export type Block =
  | { kind: "p"; spans: readonly Span[] }
  | { kind: "ul"; items: readonly (readonly Span[])[] };

/** An H2 and everything under it, up to the next H2. */
export type Section = { heading: string; blocks: readonly Block[] };

/**
 * One H3 question and its answer.
 *
 * `a` is a plain string, not a span run: no FAQ answer in any of the three
 * source documents contains a link, and FAQPage JSON-LD wants plain text
 * anyway. Checked against the markdown before being relied on — if a future
 * answer needs a link, this becomes `readonly Span[]` and the JSON-LD builder
 * runs it through plainText.
 */
export type Faq = { q: string; a: string };

/** One complete guide page. */
export type Guide = {
  slug: string;
  title: string;
  description: string;
  canonical: string;
  h1: string;
  /** The paragraphs between the H1 and the first H2. */
  lede: readonly Block[];
  sections: readonly Section[];
  faq: readonly Faq[];
  /** "FraudShield team · October 2026" — the byline every guide carries. */
  footer: string;
};

/**
 * Flatten a span run to prose.
 *
 * Needed in two places that cannot take markup: FAQPage JSON-LD and page
 * metadata. A link contributes its visible text and loses its href, which is
 * correct for both — a bracket or a URL leaking into a meta description ships
 * straight to the search result.
 */
export function plainText(spans: readonly Span[]): string {
  return spans
    .map((span) => (typeof span === "string" ? span : span.text))
    .join("");
}

/** The byline, stated once. */
const FOOTER = "FraudShield team · October 2026";

/**
 * The scan CTA. Identical on all three guides by design, and the only link to
 * /signup in any guide body — guide_cta_click is attributed by slug, so a
 * second signup link on a page makes that page's click rate unreadable.
 */
const RUN_A_SCAN: Block = {
  kind: "p",
  spans: [
    "Want a second pair of eyes on the file? Upload it to ",
    { text: "FraudShield", href: "/signup" },
    ". Sign up and your first scan is free. In a few seconds you get a score from 0 to 100 for signs the document was altered, and how many signals the scan found. Treat the score as one more input, not a verdict.",
  ],
};

/**
 * The three guides, in reading order: the pay-stub guide is the head term and
 * the other two are reached from it.
 *
 * DECLARATION STYLE IS LOAD-BEARING. `as const satisfies ReadonlyArray<Guide>`
 * — in that order — not `: ReadonlyArray<Guide>`. The annotation form widens
 * every string to `string`, which makes GuideSlug below resolve to `string`,
 * which makes a typo'd slug in a route handler or an analytics call compile
 * clean. That widening is invisible at runtime and therefore invisible to
 * every test in this repo, so the declaration itself is the guard.
 */
export const GUIDES = [
  {
    slug: "fake-pay-stub",
    title: "How to tell if a pay stub is fake: checks you can do today",
    description:
      "Do the math, check the layout, call the employer and match the stub to bank deposits. A plain guide for landlords, lenders and anyone who has to decide.",
    canonical: "/guides/fake-pay-stub",
    h1: "How to tell if a pay stub is fake",
    lede: [
      {
        kind: "p",
        spans: [
          "Start with the arithmetic: gross pay minus taxes and deductions must equal net pay to the cent, and year-to-date totals must grow by exactly the current amount. Then check the layout, confirm the employer through a number you found yourself, and match the net pay to deposits on a bank statement. A clean-looking stub proves little on its own.",
        ],
      },
    ],
    sections: [
      {
        heading: "Who this is for",
        blocks: [
          {
            kind: "p",
            spans: [
              "You have a pay stub in front of you and a decision to make. Maybe you rent out a house, run a small lending desk, broker cash advances, or review contractors for a gig platform. You are not a forensic examiner and you do not need to be. Most altered stubs fall over on checks that take ten minutes. Here they are, in the order we would do them.",
            ],
          },
        ],
      },
      {
        heading: "Why a clean-looking stub proves little now",
        blocks: [
          {
            kind: "p",
            spans: [
              'A few years ago a fake stub usually looked fake. Generators, image editors and AI writing tools now produce stubs with tidy layouts and tidy arithmetic. So the question has changed from "does this look right?" to "can I confirm this with someone other than the applicant?" Many fakes are still careless, so the checks below still matter. But the steps that carry the most weight go outside the document: the employer, the bank statement, and the file itself.',
            ],
          },
        ],
      },
      {
        heading: "Ask for the file, not a picture",
        blocks: [
          {
            kind: "p",
            spans: [
              "Ask for the PDF the applicant downloaded from their payroll portal, not a photo, a screenshot or a scan of a printout. A real export keeps its structure and metadata. A picture throws that away and makes the later checks harder. If all you have is a photo, ask for the download. An honest applicant can get it in a minute.",
            ],
          },
        ],
      },
      {
        heading: "Do the math",
        blocks: [
          {
            kind: "p",
            spans: [
              "This is where careless fakes fail. Take a calculator and work through both columns, the current period and the year to date.",
            ],
          },
          {
            kind: "ul",
            items: [
              [
                "Gross pay minus taxes minus deductions must equal net pay, to the cent, in both columns.",
              ],
              [
                "Hours times rate must equal gross pay for hourly workers, with overtime hours at the overtime rate.",
              ],
              [
                "Year-to-date figures must rise from one stub to the next by exactly the amount on the later stub. Line up two or three consecutive stubs.",
              ],
              [
                "The pay period should end on or before the pay date, and the period length should be consistent (every 14 days for biweekly pay, for example).",
              ],
              [
                "Taxes are calculated on taxable wages, not on gross pay, and the base differs by tax. Pre-tax health premiums reduce the base for all of them. Pre-tax retirement contributions reduce the base for federal income tax but not for Social Security and Medicare. Good stubs print each taxable base, so use those figures before you call a number wrong.",
              ],
              [
                "Social Security is withheld at 6.2% of Social Security wages up to an annual limit, and Medicare at 1.45% with no cap. The limit changes every year, so a high earner's stub late in the year can legitimately show no Social Security deduction.",
              ],
              [
                "Federal income tax withholding can legitimately be zero: W-4 settings, low pay for the period, exempt status, or a short or part-time period can all produce one. Treat a zero as a question to ask, not as proof. Several states have no income tax, so a missing state line only matters if the state has one.",
              ],
              [
                "Net pay that lands on a round number (exactly $4,000.00) is a soft signal, because real deductions almost always leave cents behind. One round number is a coincidence. Three in a row is not.",
              ],
            ],
          },
          {
            kind: "p",
            spans: [
              "A stub that passes all of this is not proven real. It has only cleared the first bar.",
            ],
          },
        ],
      },
      {
        heading: "Look at the layout",
        blocks: [
          { kind: "p", spans: ["Now read the stub the way a proofreader would."] },
          {
            kind: "ul",
            items: [
              [
                "One font throughout. Pasted-in numbers often sit in a slightly different font or weight, or do not line up on the decimal point with the rest of the column.",
              ],
              [
                "The letter O standing in for a zero, or the letter l for a one. Copy a suspect number into a text editor and look at it there.",
              ],
              ["A blurry or stretched logo on an otherwise crisp document."],
              [
                "Employer name, address and employee name spelled exactly as on the ID and the application.",
              ],
              [
                "Check numbers or stub numbers that run in sequence across consecutive stubs.",
              ],
              [
                "If two applicants claim the same employer, their stubs should share the same layout exactly.",
              ],
            ],
          },
        ],
      },
      {
        heading: "Verify the employer yourself",
        blocks: [
          {
            kind: "p",
            spans: [
              "Find the employer's main phone number on your own, through a search or a public listing. Do not call the number printed on the stub or the one the applicant gives you. Ask whether the person works there and in what role. Many employers will confirm employment and dates even if they will not discuss pay. Some route these questions through an employment verification service, which is fine as long as you reached it through the employer and not through a link the applicant sent.",
            ],
          },
          {
            kind: "p",
            spans: [
              "For self-employed and gig applicants, a pay stub is the wrong document to lean on. Ask for bank statements showing the deposits and for tax records such as 1099 forms or a filed return.",
            ],
          },
        ],
      },
      {
        heading: "Match it to the bank statement",
        blocks: [
          {
            kind: "p",
            spans: [
              "This is the check that trips up good fakes. Net pay on the stub should appear as a deposit on the applicant's bank statement on or just after the pay date, for the same amount, with a description that names the employer or its payroll processor. If the deposits are missing, smaller, or arrive on different days, ask about it directly. We wrote a separate guide on reading a bank statement, including how to tell whether the statement itself has been altered: ",
              {
                text: "How to tell if a bank statement is fake or has been altered",
                href: "/guides/fake-bank-statement",
              },
              ".",
            ],
          },
        ],
      },
      {
        heading: "Check the file itself",
        blocks: [
          {
            kind: "p",
            spans: [
              "Open the document properties in your PDF reader and look at the Creator and Producer fields and at the created and modified dates. A stub exported from a payroll system usually names that system or a standard report engine. An image editor or a general-purpose PDF editor in those fields is a clue. So is a modified date well after the created date, or a created date after the pay date. These are clues, not proof: metadata can be empty and it can be edited. Our guide on ",
              {
                text: "how to tell if a PDF has been edited",
                href: "/guides/edited-pdf",
              },
              " goes deeper, including what to look for inside the file structure.",
            ],
          },
        ],
      },
      { heading: "Run a scan", blocks: [RUN_A_SCAN] },
      {
        heading: "When to stop and get a person",
        blocks: [
          {
            kind: "p",
            spans: ["Some decisions should not rest on your own read of a document."],
          },
          {
            kind: "ul",
            items: [
              [
                "The money is large: a long lease, a high rent, a sizeable loan or advance.",
              ],
              [
                "The signals disagree. The arithmetic is perfect but the employer cannot be reached, or the employer confirms employment but the deposits do not match.",
              ],
              [
                "You are about to refuse someone, or the matter may end up in a dispute.",
              ],
              [
                "You are making a regulated decision, such as tenant screening or lending, where you must apply the same checks to every applicant.",
              ],
            ],
          },
          {
            kind: "p",
            spans: [
              "Instead of guessing, ask the employer or its payroll provider for written confirmation. For a dispute, use a qualified document examiner. Apply the same checks to every applicant, keep a short record of what you checked and what you found, and follow your local rules on adverse decisions, including any written notice you owe the applicant.",
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: "Can landlords detect fake pay stubs?",
        a: "Often, yes, with the checks above: the math, the layout, an independent call to the employer, and matching net pay to bank deposits. The last two matter most, because a well-made fake can pass the first two.",
      },
      {
        q: "Do apartments verify pay stubs?",
        a: "Many do, and more do each year. Larger property managers often run income through a screening service or ask applicants to connect a payroll or bank account directly. Independent landlords usually verify by phone and by comparing the stub with a bank statement.",
      },
      {
        q: "What does a real pay stub include?",
        a: "Employer name and address, employee name, the pay period and the pay date, hours and rate or a salary amount, gross pay, each tax and deduction with current and year-to-date amounts, and net pay. Formats vary by payroll system and by state, so a different layout is not by itself a warning sign. The arithmetic and the year-to-date totals are what has to hold.",
      },
    ],
    footer: FOOTER,
  },
  {
    slug: "fake-bank-statement",
    title: "How to tell if a bank statement is fake or altered",
    description:
      "Run the balance arithmetic, read the transactions like a banker, check the file, then verify with the bank. A plain guide for lenders and landlords.",
    canonical: "/guides/fake-bank-statement",
    h1: "How to tell if a bank statement is fake or has been altered",
    lede: [
      {
        kind: "p",
        spans: [
          "Two different things get called a fake bank statement: a document invented from scratch, and a real statement with a few numbers changed. Both show up in the arithmetic first. Check that opening balance plus deposits minus withdrawals equals the closing balance, line by line. Then read the transactions, check the file, and verify with the bank.",
        ],
      },
    ],
    sections: [
      {
        heading: "Who this is for",
        blocks: [
          {
            kind: "p",
            spans: [
              "You lend, underwrite, broker, rent out property or keep the books, and someone has handed you a bank statement to prove income, cash flow or savings. A statement can show what moved through an account over a period. It cannot by itself prove that the account still holds that money today, that the deposits were income rather than transfers, or that the document is the one the bank issued. This guide is about that last question, with the other two in view.",
            ],
          },
        ],
      },
      {
        heading: "Why a clean-looking statement proves little now",
        blocks: [
          {
            kind: "p",
            spans: [
              "The old tells still exist. A font that changes halfway down a column, a balance that does not add up, a logo that looks photocopied. But editing a PDF is now easy, and generators and AI tools can produce statements with neat layouts and arithmetic that works. So a statement that looks right has cleared only the lowest bar. The checks that carry weight are the ones that reach past the document: the bank, the applicant's live login, or a connection the applicant authorizes. Do the document checks below first, because they are fast and they still trip up careless work. Then verify at the source.",
            ],
          },
        ],
      },
      {
        heading: "Ask for the right file",
        blocks: [
          {
            kind: "p",
            spans: [
              "Ask for the PDF downloaded from online banking, not a photo, a screenshot, or a scan of a printout. Ask for consecutive months, usually two or three, so the closing balance of one month can be matched to the opening balance of the next. Where you can, do better than a file: have the applicant log in to their bank in front of you, use a read-only connection that the applicant authorizes, or ask the bank for a verification letter. Each of those takes the document out of the question entirely.",
            ],
          },
        ],
      },
      {
        heading: "Run the arithmetic",
        blocks: [
          {
            kind: "ul",
            items: [
              [
                "Opening balance plus total deposits minus total withdrawals must equal the closing balance for the period.",
              ],
              [
                "Pick ten transactions, including every large deposit, and recompute the running balance line by line. A single line that does not follow from the one above it is a hard signal.",
              ],
              [
                "Page subtotals and the summary box at the top must agree with the detail lines.",
              ],
              [
                "Pages should be numbered and consecutive (Page 3 of 7), and the statement period should match the dates of the first and last transactions.",
              ],
              [
                "Across months, the closing balance of one statement must be the opening balance of the next, to the cent.",
              ],
            ],
          },
        ],
      },
      {
        heading: "Read the transactions like a banker",
        blocks: [
          {
            kind: "p",
            spans: [
              "Numbers that add up can still describe an account that does not exist. Read the statement as if you worked at the bank.",
            ],
          },
          {
            kind: "ul",
            items: [
              [
                "Payroll deposits should match the applicant's pay stubs in amount, date and payer name. We cover the stub side in ",
                {
                  text: "How to tell if a pay stub is fake",
                  href: "/guides/fake-pay-stub",
                },
                ".",
              ],
              [
                "Round-number deposits with vague descriptions (Deposit, Transfer) deserve a question, especially when they are the only income.",
              ],
              [
                "Real accounts have friction: a monthly fee, an interest line of a few cents, a card charge from a coffee shop. An account with no fees, no interest and no small purchases deserves a closer look.",
              ],
              [
                "Dates should run in order, and automated transfers rarely post on a Sunday or a public holiday.",
              ],
              [
                "The same transaction twice, a merchant name misspelled, or a balance that never dips are all worth a second look.",
              ],
              [
                "A personal account normally shows rent or mortgage, utilities and groceries. Their absence is a question.",
              ],
            ],
          },
          {
            kind: "p",
            spans: [
              "If you lend to small businesses or underwrite cash advances, add these:",
            ],
          },
          {
            kind: "ul",
            items: [
              ["Average daily balance against the revenue the applicant states."],
              [
                "Number and frequency of deposits, and whether they look like customer payments or like a few large transfers.",
              ],
              ["Debits from existing advances or loans that were not disclosed."],
              ["Returned items, overdraft fees and days with a negative balance."],
            ],
          },
        ],
      },
      {
        heading: "Look at the format",
        blocks: [
          {
            kind: "ul",
            items: [
              [
                "One font and one weight throughout, with amounts aligned on the decimal point and consistent spacing between digits.",
              ],
              [
                "The bank's usual header, footer, account-number masking and logo quality. If you have a statement from the same bank that you know is genuine, lay the two side by side.",
              ],
              [
                "Watch for a line where the spacing or the baseline shifts slightly. Edited lines often sit a fraction off.",
              ],
            ],
          },
        ],
      },
      {
        heading: "Check the file itself",
        blocks: [
          {
            kind: "p",
            spans: [
              "Open the document properties in your PDF reader. Statements are produced by the bank's own systems, so a desktop editor or an image tool in the Creator or Producer fields is a clue. So is a modified date later than the created date, or more than one saved revision. Select all the text on a page and paste it into a plain text editor. Edited numbers sometimes paste out of order or with odd characters. Our guide on ",
              {
                text: "how to tell if a PDF has been edited",
                href: "/guides/edited-pdf",
              },
              " explains each of these checks in detail.",
            ],
          },
        ],
      },
      { heading: "Run a scan", blocks: [RUN_A_SCAN] },
      {
        heading: "Verify at the source",
        blocks: [
          {
            kind: "p",
            spans: [
              "The strongest check does not involve the document at all. Call the bank on a number you looked up yourself. Most banks will not discuss a customer's account with a third party, but they can confirm whether a routing number, a branch and a format are theirs. Better still, ask the applicant to log in to their bank in front of you, to authorize a read-only connection, or to request a verification letter from the bank. If an applicant refuses every one of these, that refusal is information.",
            ],
          },
        ],
      },
      {
        heading: "When to stop and get a person",
        blocks: [
          {
            kind: "ul",
            items: [
              [
                "The amount is above the limit you set for yourself for a document-only decision.",
              ],
              [
                "The signals disagree: the arithmetic is perfect but the bank cannot confirm the format, or the deposits do not match the stubs.",
              ],
              ["You suspect the applicant may not be who they say they are."],
              [
                "You are about to refuse someone, or the matter could end in a dispute.",
              ],
            ],
          },
          {
            kind: "p",
            spans: [
              "In those cases, go back to the bank through one of the routes above, bring in a qualified document examiner for a dispute, and escalate under your own rules. Apply the same checks to every applicant, keep a short record of what you checked, and follow your local rules on adverse decisions.",
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: "Can fake bank statements be verified?",
        a: "A fake statement can be identified, but not by looking harder at the document alone. The arithmetic and formatting checks trip up careless fakes. The ones that pass those checks are found at the source: a live login, an authorized read-only connection, or confirmation from the bank.",
      },
      {
        q: "How do lenders verify bank statements?",
        a: "Lenders start with the document checks on this page, then confirm through the bank or through a read-only account connection the applicant authorizes, and compare deposits with pay stubs or tax records. If you are the applicant, that is why you are asked to connect your account or to provide several consecutive months: it lets the lender see the deposits rather than take the PDF on trust. Download statements from your bank's site rather than sending screenshots, and expect questions about large or unusual deposits.",
      },
      {
        q: "How many months of statements should I ask for?",
        a: "Two or three consecutive months is the common minimum for rentals and small loans. Consecutive months let you check that each closing balance becomes the next opening balance. For business lending, three to six months gives a better view of deposit patterns and seasonality.",
      },
    ],
    footer: FOOTER,
  },
  {
    slug: "edited-pdf",
    title: "How to tell if a PDF has been edited (metadata and more)",
    description:
      "Often you can. Check the metadata, look inside the file for extra saves and odd fonts, compare with an original, and know when the trail runs out.",
    canonical: "/guides/edited-pdf",
    h1: "How to tell if a PDF has been edited",
    lede: [
      {
        kind: "p",
        spans: [
          "Often, yes. Editing a PDF usually leaves traces in the metadata and in the file structure: a modified date after the created date, an editing program in the Producer field, or extra saved revisions. A careful editor can remove most of these. So treat every finding as a clue, and verify important documents with whoever issued them.",
        ],
      },
      {
        kind: "p",
        spans: [
          "This guide is for anyone who has received a PDF, whether a ",
          { text: "pay stub", href: "/guides/fake-pay-stub" },
          ", a ",
          { text: "bank statement", href: "/guides/fake-bank-statement" },
          ", an invoice or a contract, and needs to know whether it is the file the sender says it is. Nothing here needs paid software.",
        ],
      },
    ],
    sections: [
      {
        heading: "Check the metadata (five minutes, free)",
        blocks: [
          {
            kind: "p",
            spans: [
              "Every PDF carries a small block of information about itself. Open the file in your PDF reader and look for Document Properties, usually under the File menu. You will see fields such as Title, Author, Creator, Producer, Created and Modified.",
            ],
          },
          {
            kind: "ul",
            items: [
              [
                "Creator is the program that made the content. Producer is the library that wrote the PDF file. A statement from a bank or a stub from a payroll system usually names that system or a standard report engine in these fields.",
              ],
              [
                "On the command line, exiftool file.pdf prints the same fields plus the XMP history when it exists, and pdfinfo file.pdf prints the basic fields and the PDF version.",
              ],
            ],
          },
          { kind: "p", spans: ["What to look for:"] },
          {
            kind: "ul",
            items: [
              [
                "An image editor, a desktop or online PDF editor, or a word processor in Creator or Producer, when the document is supposed to come from a bank, a payroll system or an accounting system.",
              ],
              [
                "A Modified date later than the Created date. A Created date later than the date printed on the document.",
              ],
              ["Empty metadata on a document type that normally carries it."],
              [
                "Several entries in the XMP history, which shows the document was saved more than once.",
              ],
            ],
          },
          { kind: "p", spans: ["What it does not prove:"] },
          {
            kind: "ul",
            items: [
              [
                "Adding a comment, a highlight or a signature field also updates the Modified date.",
              ],
              ["Printing to PDF or flattening wipes the history and resets the fields."],
              [
                "Metadata is plain text. Anyone who knows it is there can change it.",
              ],
            ],
          },
        ],
      },
      {
        heading: "Look inside the file",
        blocks: [
          {
            kind: "p",
            spans: ["The metadata is the cover. The file structure is the book."],
          },
          {
            kind: "ul",
            items: [
              [
                "Extra saves. A PDF that was edited and saved on top of the original often contains more than one %%EOF marker, because the edits are appended as an incremental update. Open the file in a plain text editor and search for %%EOF. More than one means the file was saved again after it was created. Some tools also report the number of revisions.",
              ],
              [
                "Fonts. The Fonts tab in Document Properties lists every font the file uses. A document that uses one font family everywhere, plus a second font or a separate subset of the same font that appears only in a few numbers, is a strong clue that those numbers were typed in later.",
              ],
              [
                "Text over image. Some fakes start with a scan and lay typed text on top. Try selecting the text. If the page is a picture except for a few selectable numbers, ask why.",
              ],
              [
                "Copy and paste. Select all the text on a page and paste it into a plain text editor. Edited numbers sometimes paste out of order, split into pieces, or carry odd characters.",
              ],
              [
                "Zoom. Zoom in to three or four times the normal size and look along a column of figures. Edited digits often sit a hair above or below the baseline, or have a slightly different stroke weight.",
              ],
            ],
          },
        ],
      },
      {
        heading: "Compare with a known original",
        blocks: [
          {
            kind: "p",
            spans: [
              "If you have an earlier document from the same issuer, or a copy you obtained directly from the issuer, put the two side by side. Many PDF readers have a compare function that highlights differences. A PDF that was digitally signed with a certificate will report whether it changed after signing. Most bank statements and pay stubs are not signed that way, so the absence of a signature means nothing.",
            ],
          },
        ],
      },
      {
        heading: "What a scan adds, and what it does not",
        blocks: [
          {
            kind: "p",
            spans: [
              "Everything above is work you can do by hand, and we think you should. An automated scan adds a consistent second look for signs that values or text in the document were replaced or edited, and it returns a score from 0 to 100 built from the specific signals it found. It does not know who issued the document, and it cannot see what the original said. So the score is a flag to look into, not an answer.",
            ],
          },
          RUN_A_SCAN,
          {
            kind: "p",
            spans: [
              "No scan, ours included, replaces confirming the document with whoever issued it.",
            ],
          },
        ],
      },
      {
        heading: "Limits, and when to go to the source",
        blocks: [
          {
            kind: "ul",
            items: [
              [
                "No traces does not mean no edits. A file that was printed to PDF, flattened, or rebuilt from scratch carries no history.",
              ],
              [
                "A photo or a scan of a document is an image. None of the checks on this page apply to it, so ask for the original file.",
              ],
              [
                "Keep the file you received. Do not open it, annotate it and save over it, or you will add your own traces.",
              ],
              [
                "If money or a legal decision depends on the document, go to the issuer: the bank, the employer or payroll provider, the vendor. For a dispute, use a qualified document examiner.",
              ],
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: "Can you see when a PDF was edited?",
        a: "Sometimes. The Modified date in the properties is the last save, and the XMP history, when present, lists earlier saves. Both can be wiped or changed, and any save, including adding a comment, updates the date. So the date tells you the file was touched, not what was changed.",
      },
      {
        q: "Does adding a comment change the modified date?",
        a: "Yes. Comments, highlights, form entries and signatures are all saved into the file and update the Modified date, usually as an incremental update. A later Modified date on its own is not evidence of a changed figure.",
      },
      {
        q: "Can AI detect an edited PDF?",
        a: "Automated tools, including ones that use machine learning, look for the same kinds of traces described on this page and can do it consistently across many files. They produce a score and a list of signals, not a verdict. If the file carries no traces, no tool can tell you more than you could find yourself, and the answer is to go back to the issuer.",
      },
      {
        q: "How to tell if a document has been altered by AI?",
        a: "The same way as any other edit. Whatever tool made the change, the trail is in the metadata, the file structure, the fonts and a comparison with an original. When there is no trail, the document has to be verified with the issuer. The tool used to alter a file matters less than whether you can confirm the file with the people who made it.",
      },
    ],
    footer: FOOTER,
  },
] as const satisfies ReadonlyArray<Guide>;

/**
 * The slugs, as a literal union.
 *
 * Derived from GUIDES rather than written out, so adding a guide cannot leave
 * the union behind. This only stays a union because GUIDES is `as const` — see
 * the note on the declaration above, and the compile-time guard in
 * tests/guides-copy.test.ts.
 */
export type GuideSlug = (typeof GUIDES)[number]["slug"];
