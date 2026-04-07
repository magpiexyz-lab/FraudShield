# Agent Taxonomy

25 sub-agents in `.claude/agents/`. Each agent is a specialized subprocess with constrained tools, model tier, and scope.

## Categories

### 1. Read-only scanners (13 agents)

No Edit/Write tools. Each has deeply specialized instructions (WCAG rules, attack vectors, performance thresholds, compliance checklists). Different model tiers: opus for creative reasoning (security-attacker), sonnet for checklist verification (security-defender), haiku for data extraction (build-info-collector).

`accessibility-scanner`, `behavior-verifier`, `build-info-collector`, `design-consistency-checker`, `gate-keeper`, `observer`, `pattern-classifier`, `performance-reporter`, `provision-scanner`, `scaffold-externals`, `security-attacker`, `security-defender`, `spec-reviewer`

### 2. Implementation agents (2 agents)

Edit/Write with worktree isolation. Shared TDD logic extracted to `procedures/tdd-cycle.md`.

`implementer`, `visual-implementer`

Kept separate because: (a) different output contracts (visual-implementer has DESIGN field), (b) 6+ consuming files reference both names in hooks/globs/traces, (c) `skills: [frontend-design]` is a declarative frontmatter field with no runtime conditional loading.

### 3. Scaffold agents (7 agents)

Edit/Write, bootstrap-only. Each handles a distinct build phase with different inputs/outputs.

`scaffold-setup`, `scaffold-init`, `scaffold-images`, `scaffold-libs`, `scaffold-pages`, `scaffold-landing`, `scaffold-wire`

scaffold-pages vs scaffold-landing stay separate: different self-check rubrics (utility 6-dim vs persuasion 7-dim), different data inputs (image-manifest.json vs messaging.md), different write territories.

### 4. Design/UX agents (3 agents)

Different scopes (per-page visual, cross-page consistency, end-to-end flow) with serial execution required for edit-capable agents.

`design-critic`, `design-consistency-checker`, `ux-journeyer`

### 5. Security agents (3 agents)

Attacker vs defender use fundamentally different cognitive frames (adversary vs compliance) AND different model tiers (opus for creative exploit paths, sonnet for binary checklist). Fixer consumes both outputs.

`security-attacker` (opus, scan-only), `security-defender` (sonnet, scan-only), `security-fixer` (opus, edit-capable)

## Description Convention

- **Creative agents** (6): "World-champion" priming preserved in description field -- identity framing improves subjective creative output. Agents: design-critic, scaffold-images, scaffold-init, scaffold-landing, scaffold-pages, pattern-classifier.
- **Functional agents** (19): `<What it does> -- <Scope constraint>` template.

## Files that reference agent names

Update these if renaming an agent:

- `.claude/procedures/change-feature.md` -- implementer/visual-implementer dispatch
- `.claude/procedures/tdd-task-generation.md` -- agent type table
- `.claude/procedures/worktree-merge-verification.md` -- merge logic
- `.claude/patterns/change/state-10-implement.md` -- trace globs, gate checks
- `.claude/patterns/state-registry.json` -- agent_gates entries
- `.claude/hooks/agent-state-gate.sh` -- SUBAGENT_TYPE branching
- `.claude/hooks/artifact-integrity-gate.sh` -- scaffold_prefixes list
- `.claude/hooks/change-commit-gate.sh` -- merge commit detection
