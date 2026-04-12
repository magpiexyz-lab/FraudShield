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

If `problem_type = "defect"`:
4. "Does this solution address the root cause, or just the symptom?"
   If treating a symptom (suppressing errors, adding workarounds, handling edge cases
   without addressing why they exist): revise Step 3.
5. "Could this same class of problem recur? If yes, what prevents it?"
   Identify a concrete prevention mechanism (test, guard, validator, type constraint)
   or explain why prevention is not feasible.
6. "Are there other instances of this same problem beyond the reported one?"
   The solution must cover all known instances, not just the trigger case.

If any answer reveals a gap: revise Step 3. Same one-revision-pass-max rule.

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

### Prevention Analysis (when problem_type = defect)
- **Root cause addressed**: [yes/no — explain]
- **Recurrence risk**: [none | guarded (<mechanism>) | unguarded (<why acceptable>)]
- **Scope**: [all instances covered | N known instances, all addressed]
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

5. **Prevention check** (when `problem_type = "defect"`):
   - **Root cause**: For each mechanism — does it address root cause, or just the symptom?
   - **Recurrence**: Could this class of problem recur? If yes: identify prevention
     mechanism (test, guard, validator, type constraint) or explain why not feasible.
   - **Scope**: Are there other instances beyond the reported one? Solution must
     cover all known instances.
   - Output: `prevention_analysis` — root_cause_addressed (bool),
     recurrence_risk (none|guarded|unguarded), recurrence_guard (description or null),
     scope (all_covered bool, instance_count int).

Output:
- **1 recommended solution** with ordered implementation checklist
- **0-2 Pareto alternatives** (only if genuinely competitive on different tradeoff axes — e.g., one is simpler but less extensible)

For each alternative: name the tradeoff axis where it wins.

### Phase 5 — Critic Loop (1 Named agent, max 2 rounds)

Spawn the `solve-critic` Named agent (`subagent_type: solve-critic`).

The caller MUST include `--context <file>` in the agent prompt to specify the
context file for run_id correlation:
- `/resolve`: `--context .runs/resolve-context.json`
- `/change`: `--context .runs/change-context.json`
- `/solve`: `--context .runs/solve-context.json`

**Critic receives**: the recommended solution + problem statement + constraint space + Phase 3 self-answered gaps.
**Critic does NOT receive**: the reasoning chain from Phases 1-4.

The critic protocol (TYPE A/B/C classification, output format) is defined in
`.claude/agents/solve-critic.md`. The agent writes its own trace to
`.runs/agent-traces/solve-critic.json` — this trace is independent of the lead
agent and cannot be modified by it.

**Convergence rules**:
- **Round 1**: If 0 TYPE A concerns → early exit (solution converged). Otherwise: fix all TYPE A concerns → round 2.
- **Round 2**: Spawn a **new** solve-critic agent (use the Agent tool, NOT SendMessage to the round 1 agent). Wait for the agent to return its result before proceeding. The agent overwrites its trace with `round: 2` and updated counts. Any remaining TYPE A → package as caveats in output. Stop.

**IMPORTANT**: Each critic round MUST complete (agent returns result) before the caller proceeds to Phase 6 or advances to the next state.

**Artifact tracking:** After the critic loop completes, the caller must record:
- `critic_rounds`: number of rounds actually executed (1 or 2)
- `round_1_type_a_count`: number of TYPE A concerns from round 1
- `round_2_type_a_count`: number of TYPE A concerns from round 2 (only when `critic_rounds > 1`)

These fields enable postcondition verification that round 2 was executed when required
and cross-artifact consistency checks between the challenge file and the critic trace.
Store in the caller's challenge artifact:
- `/resolve`: `.runs/resolve-challenge.json`
- `/change`: `.runs/change-challenge.json`
- `/solve`: `.runs/solve-challenge.json`

Do NOT store in the shared `solve-trace.json`.
The adversarial-merge-gate.sh hook cross-references these fields against the
solve-critic trace to detect silent overrides.

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

## Prevention Analysis (when problem_type = defect)
- **Root cause addressed**: [yes/no — explain how the solution targets the cause]
- **Recurrence risk**: [none | guarded | unguarded]
- **Recurrence guard**: [description of prevention mechanism, or N/A]
- **Scope**: [N instances identified, all covered | single instance, no others found]

## Critic Convergence
- Rounds completed: [1 or 2]
- Round 1 TYPE A count: [N]
- Round 2 needed: [yes/no]
```

---

## Caller Integration

Other patterns can invoke this methodology with **adaptive depth** — light by
default, full when complexity warrants it.

### `/resolve` Step 5

- **Default**: light
- **Trigger full**: `blast_radius` confirmed >= 3 files OR `severity` = HIGH
- **Input mapping**: `divergence_point`, `blast_radius`, `reproduction`, `severity` as constraints
- **Light output mapping**: "Recommended Solution" -> `root_cause`, "Implementation Steps" -> `fix_plan`, "Constraints Respected" -> constraint review, "Key Tradeoff" -> diagnosis report, "Prevention Analysis" -> `prevention_analysis` in solve-trace.json
- **Full mode customization**:
  - Phase 1 agents: Agent 1 = divergence investigation, Agent 2 = blast radius + prior fix art, Agent 3 = fix constraints (validators, archetype universality)
  - Phase 5 Critic receives domain-specific vectors from Step 5b (configuration counterexample, blast radius gap, regression vector)
- **Prevention**: Core pattern handles root-cause, regression-prevention, and scope coverage via `problem_type = "defect"` (resolve always sets this). Post-validation retains only the domain-specific template universality requirement.
- **Post-validation**: resolve.md Step 5 applies template universality after solve-reasoning completes. If rejected: iterate once through self-check (light) or critic round 2 (full).

### `/change` Step 2b

- **Default**: light
- **Trigger full**: `preliminary_type` in [Feature, Upgrade] AND `affected_areas` >= 3
- **Input mapping**: `$ARGUMENTS` as problem, exploration results from Step 2 as constraints
- **Light output**: stored in working memory, feeds into plan "How" sections
- **Full mode customization**:
  - Phase 1 agents: Agent 1 = change problem space, Agent 2 = reuse/prior art (extends plan-exploration), Agent 3 = hard constraints (archetype, stack, behaviors)
  - Phase 5 Critic reviews plan mechanism choices (no extra domain vectors)
  - Output feeds: "How" sections, Risks & Mitigations, Approaches table
- **Prevention**: When `preliminary_type = "Fix"`, callers set `problem_type = "defect"` to activate prevention dimension. Other types do not set problem_type.

### Direct `/solve` invocation

- **Default**: full
- **Override**: `--light` flag selects light mode
- **Prevention**: Callers may set `problem_type = "defect"` via `--defect` or `--bug` flag to activate prevention. Default: not set (no prevention check).

### Caller conventions

- **Output ownership**: return output to the caller — do not present directly to the user (the caller handles presentation and next steps)
- **Phase 3 autonomy**: Phase 3 is fully autonomous — the lead agent self-answers research gaps using first-principles reasoning. No user interaction occurs in Phase 3. Callers do not need to merge Phase 3 questions into STOP gates
- **Domain-specific critics**: callers may inject additional critic vectors into Phase 5 (see `/resolve` Step 5b vectors)
- **Post-validation iteration**: callers may apply their own domain validation after solve-reasoning completes and iterate once if rejected
- **Prevention activation**: Callers set `problem_type = "defect"` to activate prevention questions. When not set, prevention dimension is skipped entirely. The pattern treats this as a pure input — it never infers problem_type on its own.
- **Generic vs domain separation**: Core prevention handles root cause, recurrence, and scope coverage for all defects. Callers add domain-specific validation only (e.g., config universality, deployment constraints). Never re-implement generic prevention in a caller.
