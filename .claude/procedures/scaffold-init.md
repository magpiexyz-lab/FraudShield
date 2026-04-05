# Scaffold: Visual Design Foundation

## Prerequisites
- Branch already created (by bootstrap Step 0)
- Plan approved and saved to `.runs/current-plan.md`
- Packages installed and UI framework configured (by scaffold-setup agent)
- Read all context files listed in your task assignment before starting

## Steps

### Step 1: Design decisions
1. Derive the three design constraints per `.claude/patterns/design.md` (color direction, design philosophy, optimization target) from experiment.yaml's product domain.
2. Apply the preloaded `frontend-design` guidelines (injected via skills)
   for visual direction within the derived constraints. If not available,
   use your own judgment — match the product's personality, not framework defaults.
3. Record choices in globals.css custom properties and tailwind config per the theme contract in design.md. Font setup applies when layout.tsx is created by the pages subagent.
4. Write `.runs/current-visual-brief.md` — a structured brief that all page-generating subagents will read for visual coherence. Sections:
   - **Design Constraints**: the 3 constraints derived above (color direction, design philosophy, optimization target)
   - **Color Palette**: primary, accent, background treatment, dark mode approach
   - **Typography**: display font, body font, scale, letter-spacing stance (tight / normal / wide)
   - **Animation & Motion**: philosophy (e.g., subtle/energetic), scroll effects, micro-interactions, loading states, easing character (snappy / organic / elastic), duration scale (fast / moderate / deliberate), stagger rhythm (tight / relaxed)
   - **Spacing & Density**: overall density, section spacing, card spacing
   - **Component Style**: shape vocabulary (pill / rounded / sharp), shadows, borders, button style
   - **Visual Texture**: decorative elements, background patterns, depth technique
   - **Social Proof Treatment**: approach (ticker/marquee / testimonial cards / metric counters / logo strip / none), density, position relative to hero
   - **Image Direction**: comprehensive visual guidance for AI image generation during bootstrap Phase B1. Must cover ALL image types:
     - **Visual system**: photography / illustration / mixed — the overall approach for all generated images
     - **Hero**: subject matter (abstract/concrete), composition direction (negative space placement for text overlay), mood (aspirational/functional/dramatic)
     - **Features**: style (iconographic/photographic/illustrative), consistency rule (all features must share the same visual treatment)
     - **Logo**: graphic type (geometric/organic/letterform), shape logic (symmetry, complexity), constraint level (minimal 2-color / moderate / detailed)
     - **OG/Social**: text hierarchy approach, background treatment, brand presentation style
     - **Empty states**: emotional tone (encouraging/humorous/neutral), abstraction level
     - **Color temperature**: warm/cool/neutral alignment with the Color Palette above — this ensures AI-generated images harmonize with page CSS
   - **Numeric Precision** (brief MUST include concrete values, not directional terms):
     - **Letter-spacing**: display heading value in px (e.g., "-2.0px"), body value (e.g., "-0.1px")
     - **Line-height**: heading value (e.g., 1.1), body value (e.g., 1.55)
     - **Shadow stack**: define 3 elevation levels — each as a complete multi-layer box-shadow value with brand-color-tinted rgba. Example: light `0 1px 2px rgba(accent, 0.06), 0 2px 4px rgba(accent, 0.08)`, medium `0 4px 8px rgba(accent, 0.10), 0 8px 16px rgba(accent, 0.12)`, heavy `0 0 0 1px rgba(accent, 0.08), 0 8px 16px rgba(accent, 0.15), 0 16px 32px rgba(accent, 0.10)`
     - **Color count**: exact number of brand colors (max 3) with their roles (primary, accent, CTA) and hex values
     - **Border-radius scale**: at least 3 levels (pill: 9999px, card: Npx, input: Npx)
     - **Neutral tint**: specific tinted near-white (e.g., "#f5f4ed") and near-black (e.g., "#1a1a0e") with warm/cool justification from the color direction
   - **Signature Animation**: one hero-level micro-interaction tied to the product concept. The animation must TELL THE PRODUCT STORY, not be generic decoration. Selection guide:
     - Audio / voice / music product → waveform equalizer bars
     - Dashboard / analytics → NumberTicker counter cascade
     - Messaging / communication → typing indicator pulse
     - File / storage / upload → progress shimmer beam
     - Search / discovery → spotlight sweep
     - Scheduling / calendar → clock hand rotation
     - Payment / finance → transaction flow animation
     - Security / auth → lock/shield pulse
     - AI / ML → particle system or neural network dots
     - Social / community → avatar orbit or marquee
     - If no clear mapping: choose from Spotlight, Ripple, or Particles (neutral effects)
   - **Project-Specific Guardrails**: derive at least 3 "Never do" rules specific to THIS product's palette, domain, and visual stance. These are in ADDITION to the universal anti-patterns in design.md. Examples:
     - Warm palette: "Never use cool blue-gray for text, borders, or shadows"
     - Dark theme: "Never use drop shadows on dark surfaces — use translucent borders and subtle glows"
     - Minimalist stance: "Never add decorative gradients or background patterns"
     - Professional services: "Never use AI-generated human faces — use Unsplash real photography"
     - Playful brand: "Never use sharp corners — minimum border-radius 12px on all elements"
   - **Image source strategy**: photography (Unsplash) / illustration (AI-generated) / mixed — choose based on product domain using the Image Source Strategy table in design.md. When "photography": include specific Unsplash search terms per image type (e.g., hero: "modern dental office professional", features: "patient consultation"). When "mixed": specify which images use photography and which use illustration. When "illustration": follow existing fal.md model selection

