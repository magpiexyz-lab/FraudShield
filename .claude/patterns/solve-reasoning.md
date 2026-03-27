# Solve Reasoning

First-principles methodology for finding optimal solutions. Two modes: light
(inline, ~30s) and full (agent-assisted, ~3 min). Callable by commands (`/solve`)
and other patterns (`/change` Phase 1, `/resolve` Step 5).

---

## Light Mode

Execute directly in the lead agent. No subagents.

### Step 1: Problem Decomposition

Answer three questions:
1. **What** — State the problem in one sentence. No jargon.
2. **Why** — What breaks, degrades, or is blocked if this isn't solved?
3. **Constraints** — What is fixed and cannot change? (time, API surface, backwards compatibility, user expectations, etc.)

### Step 2: Constraint Enumeration

List:
- **Executor**: Who/what performs the solution? (human, CI, runtime, agent, etc.)
- **Available mechanisms**: What tools, APIs, patterns, or abstractions can the executor use? Rank by strength (strongest = most direct, fewest failure modes).
- **Hard constraints**: From Step 1.3 — things that cannot change.
- **Soft constraints**: Preferences that can be traded off if necessary.

### Step 3: Solution Design

For each sub-problem identified in Step 1:
1. Pick the **strongest available mechanism** from Step 2
2. Explain why it's strongest (fewest failure modes, most direct path)
3. If the strongest mechanism has a dealbreaker constraint, fall back to the next strongest

Output: a single recommended solution as an ordered implementation checklist.

### Step 4: Self-Check

For each mechanism chosen in Step 3, ask:
- "Is there a stronger mechanism I dismissed too early?"
- "Does this mechanism introduce a new failure mode I haven't accounted for?"
- "Would a different decomposition in Step 1 unlock a stronger approach?"

If any answer is yes: revise Steps 1-3 for that sub-problem. One revision pass max.

### Step 5: Output

```
## Recommended Solution
[1-2 sentence summary]

### Implementation Steps
1. [step]
2. [step]
...

### Constraints Respected
- [constraint]: [how the solution respects it]

### Key Tradeoff
[the most significant tradeoff made, and why it's acceptable]
```

---

## Full Mode

Uses 4 Opus subagents across 6 phases.

### Phase 1 — Parallel Research (3 agents)

Launch 3 agents concurrently:

**Agent 1 — Problem Space** (Explore subagent)
> Investigate the problem: what needs solving, for whom, and why.
> Search the codebase for related code, docs, and prior decisions.
> Output: problem statement, affected users/systems, severity, and scope.

**Agent 2 — Actionable Prior Art** (Explore subagent)
> Search the codebase for patterns, utilities, and infrastructure that partially
> solve this problem. For each finding: what it does + what gap remains.
>
> Search targets: demo modes, test fixtures, mocks, fallbacks, guards, gates,
> env vars, scripts, similar patterns in other files, related config.
>
> Output: list of findings, each with: file path, what it does, gap remaining.

**Agent 3 — Hard Constraints** (Explore subagent)
> Identify immutable boundaries: API contracts, backwards compatibility
> requirements, performance budgets, security requirements, deployment
> constraints, dependencies that cannot be changed.
>
> Only list truly immutable constraints. Preferences and soft constraints
> are NOT hard constraints. Failure modes are NOT constraints (those go
> to the critic in Phase 5).
>
> Output: numbered list of hard constraints with evidence (file path, doc, or API spec).

Wait for all 3 agents to complete before proceeding.

### Phase 2 — Constraint Enumeration (lead)

Synthesize research from Phase 1 into a structured constraint space:

1. **Executor type**: Who/what performs the solution?
2. **Available mechanisms**: Tools, APIs, patterns, abstractions the executor can use. Rank each by strength (strongest = most direct, fewest failure modes). Include mechanisms discovered by Agent 2.
3. **Hard constraints**: From Agent 3. Numbered, with evidence source.
4. **Prior art**: From Agent 2. What exists, what gap remains for each.
5. **Problem scope**: From Agent 1. Boundaries of what needs solving.

### Phase 3 — Gap Resolution (autonomous)

After research, before synthesis. The lead agent identifies and self-answers
research gaps using first-principles reasoning from Phase 1 data:

1. Generate 3-5 specific questions from gaps in Phase 1 research
   (e.g., "Agent 2 found X utility but it doesn't handle Y — should we extend it or build separately?")
2. For each question, self-answer using Phase 1 evidence:
   - Review Agent 1 (problem space), Agent 2 (prior art), Agent 3 (constraints)
   - Apply first-principles reasoning: strongest mechanism, fewest failure modes
   - Tag each answer with confidence: **HIGH** (grounded in Phase 1 evidence) or **LOW** (assumption without direct evidence)
3. LOW-confidence answers are flagged for Phase 5 Critic to challenge

Incorporate self-answers into the constraint space.

### Phase 4 — Solution Design (lead)

Using the constraint space from Phase 2 and self-answered gaps from Phase 3:

1. For each sub-problem: pick the **strongest available mechanism**
2. Explain why it's strongest (fewest failure modes, most direct)
3. Mark each mechanism's strength level: **strong** (direct, few failure modes), **moderate** (indirect or some failure modes), **weak** (workaround, many failure modes)
4. If two mechanisms are close in strength: note both as Pareto alternatives

Output:
- **1 recommended solution** with ordered implementation checklist
- **0-2 Pareto alternatives** (only if genuinely competitive on different tradeoff axes — e.g., one is simpler but less extensible)

For each alternative: name the tradeoff axis where it wins.

### Phase 5 — Critic Loop (1 agent, max 2 rounds)

Launch 1 Opus agent as an adversarial critic.

**Critic receives**: the recommended solution + problem statement + constraint space + Phase 3 self-answered gaps.
**Critic does NOT receive**: the reasoning chain from Phases 1-4.

**Critic instructions**:
> You are reviewing a proposed solution. Your job is to find flaws.
>
> **Self-answered gaps**: The following research gaps were answered by the AI
> without user input. Challenge each self-answer for circular reasoning or
> ungrounded assumptions. If a self-answer is tagged LOW confidence, scrutinize
> it more heavily.
>
> For each concern, classify it:
>
> - **TYPE A — Fixable design flaw**: The solution has a gap or error that can
>   be fixed without changing the approach. Default to this when uncertain.
> - **TYPE B — Immutable constraint**: The solution conflicts with a hard
>   constraint that cannot be changed. You MUST name the specific constraint.
> - **TYPE C — Needs user domain knowledge**: The solution makes an assumption
>   that only the user can validate.
>
> For each concern: type, description, evidence, and (for TYPE A) suggested fix.

**Convergence rules**:
- **Round 1**: If 0 TYPE A concerns → early exit (solution converged). Otherwise: fix all TYPE A concerns → round 2.
- **Round 2**: Any remaining TYPE A → package as caveats in output. Stop. Do not iterate further.

### Phase 6 — Output

Present the final output:

```
## Recommended Solution
[converged solution — 2-3 sentence summary]

### Implementation Checklist
1. [step]
2. [step]
...

## Self-Answered Research Gaps
[Phase 3 gap resolution — question, self-answer, confidence level for each]

## Constraint Space
[enumeration from Phase 2 — executor, mechanisms, hard constraints]

## Alternatives
[Pareto alternatives from Phase 4, if any. For each: summary + tradeoff axis where it wins]
[If none: "No Pareto alternatives — recommended solution dominates on all axes."]

## Remaining Risks
- **TYPE B** (system constraints): [list, or "None"]
- **TYPE C** (open questions): [list, or "None"]
- **Caveats**: [unresolved TYPE A from round 2, if any, or "None"]
```

---

## Caller Integration

Other patterns can invoke this methodology with **adaptive depth** — light by
default, full when complexity warrants it.

### `/resolve` Step 5

- **Default**: light
- **Trigger full**: `blast_radius` confirmed >= 3 files OR `severity` = HIGH
- **Input mapping**: `divergence_point`, `blast_radius`, `reproduction`, `severity` as constraints
- **Light output mapping**: "Recommended Solution" -> `root_cause`, "Implementation Steps" -> `fix_plan`, "Constraints Respected" -> `anti_pattern_review`, "Key Tradeoff" -> diagnosis report
- **Full mode customization**:
  - Phase 1 agents: Agent 1 = divergence investigation, Agent 2 = blast radius + prior fix art, Agent 3 = fix constraints (validators, archetype universality)
  - Phase 5 Critic receives domain-specific vectors from Step 5b (configuration counterexample, blast radius gap, regression vector)
- **Post-validation**: resolve.md Step 5 applies its own 5 fix requirements + 4 anti-patterns after solve-reasoning completes. If rejected: iterate once through self-check (light) or critic round 2 (full).

### `/change` Step 2b

- **Default**: light
- **Trigger full**: `preliminary_type` in [Feature, Upgrade] AND `affected_areas` >= 3
- **Input mapping**: `$ARGUMENTS` as problem, exploration results from Step 2 as constraints
- **Light output**: stored in working memory, feeds into plan "How" sections
- **Full mode customization**:
  - Phase 1 agents: Agent 1 = change problem space, Agent 2 = reuse/prior art (extends plan-exploration), Agent 3 = hard constraints (archetype, stack, behaviors)
  - Phase 5 Critic reviews plan mechanism choices (no extra domain vectors)
  - Output feeds: "How" sections, Risks & Mitigations, Approaches table

### Direct `/solve` invocation

- **Default**: full
- **Override**: `--light` flag selects light mode

### Caller conventions

- **Output ownership**: return output to the caller — do not present directly to the user (the caller handles presentation and next steps)
- **Phase 3 autonomy**: Phase 3 is fully autonomous — the lead agent self-answers research gaps using first-principles reasoning. No user interaction occurs in Phase 3. Callers do not need to merge Phase 3 questions into STOP gates
- **Domain-specific critics**: callers may inject additional critic vectors into Phase 5 (see `/resolve` Step 5b vectors)
- **Post-validation iteration**: callers may apply their own domain validation after solve-reasoning completes and iterate once if rejected
