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

