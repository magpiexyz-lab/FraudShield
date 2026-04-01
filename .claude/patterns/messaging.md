# Conversion Messaging Framework

Shared copy and structure rules for landing pages (`/bootstrap`) and ad campaigns (`/distribute`).
Both skills derive conversion copy from `experiment.yaml` — this file ensures they say the same thing.

## Section A: Copy Derivation Rules

Derive all conversion copy from experiment.yaml fields. Never use raw field values as headlines.

### Headline

Formula: **"[Verb] [desired outcome] [qualifier]"** — derived from `description` (the solution aspect) + `target_user`, NOT from `name`.

- `name` is the product name/brand (e.g., "QuickBill — Fast Invoicing for Freelancers")
- The headline is the value proposition (e.g., "Invoice Clients in 60 Seconds")

Anti-pattern: using `name` as the headline. That's branding, not conversion.

### Subheadline

One sentence explaining HOW — derived from `description` (the solution aspect). Can use the first sentence more directly, but rewrite for clarity if needed.

### CTA

Formula: **"{action verb} + {outcome}"** — not generic labels like "Sign up" or "Get started".

Examples:
- "Send Your First Invoice"
- "Start Tracking Free"
- "Build Your First Page"

### Pain points

3 short statements derived from the problem described in `description`. Each addresses one aspect of the pain.

Format: icon/emoji + short statement (e.g., "Manual invoicing wastes hours every week").

## Section B: Landing Page Content Inventory

Content inventory for landing pages (raw material — page architecture is a
creative decision by `frontend-design`, not a fixed checklist):

- **Value proposition** — headline + subheadline (derived from Section A rules)
- **CTA** — the call-to-action (derived from Section A rules)
- **Pain points** — derived from the problem described in experiment.yaml `description` — aspects of the pain to activate
- **Features** — derived from experiment.yaml `behaviors` — capabilities to showcase
- **Social proof** — testimonials, logos, metrics (if available in experiment.yaml or inferable)

`frontend-design` decides which elements to include, how to arrange them, how
many times CTA appears, and what additional sections the page needs (comparison
tables, pricing, FAQ, demo, etc.). The content inventory is input, not structure.

When landing is the only page (features as sections), features become interactive
sections rather than descriptive cards.

> **Testing note**: CTA typically appears 2+ times on landing pages — test
> selectors targeting CTA buttons should use `.first()` to avoid ambiguous matches.

## Section C: Message Match Rules

Rules ensuring ad-to-landing consistency:

- Ad headlines MUST be derived from the same headline as the landing page (shortened to fit the channel's ad format constraints — see distribution stack file)
- Ad descriptions MUST match the landing page subheadline in meaning
- CTA language MUST be consistent across ads and landing page
- The landing page headline should be recognizable to someone who just clicked the ad

## Section D: Variant Messaging Rules

When experiment.yaml has a `variants` field, these rules extend Sections A–C:

### Variant Copy Source
- Each variant defines its own `headline`, `subheadline`, `cta`, and `pain_points`.
- These fields **replace** the copy that Section A would derive from `description` + `target_user`.
- The variant copy IS the messaging — do not re-derive from solution/target_user.

### Landing Page Structure
- Each variant uses the **same** page structure (chosen by AI at bootstrap). Variant fields slot into the shared layout.
- Variant fields slot into Hero and Pain Points. Features section is shared across all variants (from experiment.yaml `behaviors`).

### Default Variant
- The variant with `default: true` (or the first in the list) renders at root `/`.
- All variants also render at `/v/<slug>`.
- The default variant is accessible at both `/` and `/v/<default-slug>`.

### Message Match for Variants
- Section C rules apply **per variant**: each variant's ad group must match its landing page headline.
- Ad headlines for a variant are shortened from that variant's `headline` field, not from the shared `description`.

## Section E: SEO/AEO Metadata Derivation Rules

Derive SEO metadata from experiment.yaml fields. These rules feed `layout.tsx` metadata exports, `llms.txt`, and JSON-LD structured data.

### Display Name

Title-case the experiment.yaml `name` slug, replacing hyphens with spaces.

Example: `quick-bill` → `Quick Bill`, `page-forge` → `Page Forge`.

### Meta Title

Formula: **`{headline} | {display name}`** — must be 60 characters or fewer. If it exceeds 60 chars, shorten the headline portion (keep the display name intact).

### Meta Description

Benefit-focused rewrite of the subheadline (from Section A). Must be 160 characters or fewer. Focus on what the user gains, not how the product works.

### OG Title / OG Description

Same values as meta title and meta description respectively.

### llms.txt Content

Plain text file summarizing the product for AI search engines. Format:

```
# {display name}

> {meta description}

## Features

- {behavior 1 `then` field}
- {behavior 2 `then` field}
- ...
```

Derive all content from experiment.yaml fields (`name`, `description`, `behaviors`).

### Variant Override

When experiment.yaml has `variants`, the root layout metadata uses the **default variant's** headline and subheadline (or Section A derivation if no variants). Each variant page exports `generateMetadata()` using that variant's `headline` and `subheadline` to override layout defaults.
