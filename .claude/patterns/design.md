# Visual Design System

## Quality Invariants

Two non-negotiable rules that prevent real usability issues:

1. **Form input sizing**: All `<Input>` and `<Select>` elements must use `text-base` (16px minimum). This prevents iOS Safari from auto-zooming the viewport when a user focuses an input field (triggered at font sizes below 16px). This is a platform bug workaround, not an aesthetic choice.

2. **Use shadcn/ui components**: Use library components (`<Button>`, `<Input>`, `<Card>`, etc.) instead of raw HTML elements. This ensures accessibility baselines (ARIA attributes, keyboard handling, focus management) without manual effort.

3. **Scroll-triggered animation safety**: Never use `opacity: 0` or `visibility: hidden` as an initial state for content sections awaiting scroll reveal. If using IntersectionObserver, handle the initial callback where `isIntersecting` is already `true` for above-the-fold elements. Entrance animations use CSS transforms (translateY, scale) while keeping content visible.

## Design Decisions

Before generating pages, derive design constraints from experiment.yaml and establish
visual direction. `frontend-design` is the recommended executor for visual
decisions (see `### Recommended executor`); skills decide when and how to
invoke it.

> Skip this section if `stack.surface` resolves to `none`.
> (Inference: `stack.services[0].hosting` present → `co-located`; absent → `detached`.
> Explicit `stack.surface` in experiment.yaml overrides inference.)

### Design constraints

Three hard constraints must be derived from experiment.yaml's product domain before
any visual decisions are made. These compress ~100 open decisions to ~10:

1. **Color direction** — dark, light, or neutral. Infer from product domain
   (e.g., security/dev-tools/AI → dark; consumer/health/education → light;
   B2B/finance → neutral). The executor may override with justification.
2. **Design philosophy** — minimalist, rich, or playful. Infer from audience
   (developers → minimalist; consumers → rich; creative → playful).
3. **Optimization target** — conversion, documentation, or demonstration.
   Infer from archetype and funnel (web-app with waitlist → conversion;
   service with API → documentation; CLI → demonstration).

These constraints, along with experiment.yaml content, are inputs to the visual
executor.

### Quality bar

Every page must look **world-champion level** — the absolute limit of your
ability. Not adequate, not good — the best you've ever seen. Each page
should make the founder proud. This standard applies equally to all pages,
but expresses differently based on page purpose.

**Per-section rule:** Evaluate per-section. Each section scores independently.
Weakest section determines overall quality. A page cannot hide mediocre social
proof behind a great hero.

**Landing page** (marketing surface) — optimized for **persuasion**.
The benchmark is world-champion persuasion — the absolute limit of your ability:
- Custom color palette (not default shadcn/tailwind colors)
- Considered typography (display + body font, clear hierarchy)
- Meaningful animations (scroll-triggered transforms, staggered transitions — content visible before animation starts)
- Textured depth (subtle gradients, noise overlays, backdrop effects)
- Responsive layout, dark/light mode
- The goal: "I want to share this URL"

**Inner pages** (product surface) — world champion of **utility**.
The benchmark is a top-tier SaaS product (Linear, Vercel, Raycast):
- Same custom palette and typography as landing (visual coherence)
- Proper spacing rhythm (consistent padding, margins, gap)
- Information hierarchy (scannable layout, appropriate data density)
- Interaction quality (loading states, empty states, hover/focus feedback)
- Component completeness (all shadcn/ui, no raw HTML, proper form validation)
- Functional animations (skeleton loaders, micro-interactions, state transitions)
- The goal: "When users open this page, they should feel surprise — this is far better than I expected"

Both expressions share the same theme tokens. Neither is a lower bar —
they are different axes of the same professional standard.

### Quality mechanics

These 5 constraints are the minimum floor (passing does not equal good, just not
bad). The real standard is taste judgment — constraints prevent disaster, taste
drives excellence. Checkable structural constraints that give `frontend-design`
precise targets.

**Landing page (5 constraints):**
1. **Typography tension** — display heading >= 6:1 size ratio vs body text
2. **Layout diversity** — at least one section must break the centered-column pattern (asymmetric grid, full-bleed + inset alternation, overlapping elements)
3. **Depth layers** — minimum 3 z-layers visible simultaneously (background texture/gradient, content, decorative elements)
4. **Interactive hero** — hero section must contain a functioning micro-interaction, not static content
5. **Section differentiation** — each section transition must have a visual event (color temperature shift, layout pattern change, or animation). No two adjacent sections may look structurally identical.

**Inner pages (3 constraints):**
1. **Loading choreography** — skeleton-to-content transition must stagger elements, not pop everything at once
2. **Empty state as design moment** — empty tables/lists show illustration + clear CTA, not "No data found"
3. **Hover vocabulary** — every interactive element responds to hover within 50ms (cards lift, buttons glow, links underline-animate)

> These mechanics are structural constraints, not technique prescriptions.
> `frontend-design` decides HOW to satisfy each one.

When `frontend-design` is available, invoke it for all pages (with
context-appropriate creative brief). When unavailable, follow the theme
tokens and the relevant expression criteria.

### Recommended executor

The `frontend-design` skill is the recommended executor for all visual
decisions. It has full authority over visual direction — color palette,
typography, spacing, component styling, and layout composition — within the
derived constraints.

For **service/cli archetypes with a surface**: the executor creates a complete,
self-contained HTML marketing page (not a React component). CSS is inline,
fonts via Google Fonts `<link>`, animations via CSS keyframes. Same creative
authority as for web-app — unique visual identity per experiment, not a
generic template.

Skills decide when and how to invoke `frontend-design`. The `design-critic`
agent has `frontend-design` preloaded and full read-write access. When
`frontend-design` is unavailable, the creative brief and constraints provide
sufficient direction.

### Theme contract

- Record choices in the theme layer (globals.css custom properties,
  tailwind config, font setup in layout.tsx)
- All pages consume these tokens — no per-page color/font overrides
- `/change` must preserve these choices unless explicitly asked to restyle

### Visual language brief

The visual language brief (`.runs/current-visual-brief.md`) is a structured
artifact produced by the Init subagent during bootstrap. It extends the theme
contract with non-CSS decisions that affect visual coherence across pages:
animation philosophy, spacing density, component styling, visual texture, etc.

All page-generating subagents (landing, pages) read the same brief so they
produce visually coherent output without needing to see each other's work.
This enables landing and inner pages to be generated in parallel.

The brief is **ephemeral** — it is deleted after the bootstrap PR is committed.
`/change` reads the generated code (globals.css, existing components) to infer
the established visual language rather than referencing the brief.
