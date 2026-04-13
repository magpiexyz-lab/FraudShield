# STATE 2: PHASE1_PARALLEL

**PRECONDITIONS:** STATE 1 complete (build passes, build-result.json exists).

> **Write Conflict Prevention**: Edit-capable agents (design-critic, ux-journeyer, security-fixer)
> MUST run serially in Phase 2. Read-only agents run in parallel here.

**ACTIONS:**

> **Shared algorithms:** Before executing this state, ensure you have read the following sections in [verify.md](../verify.md): Dev Server Preamble, File Boundary for Edit-Capable Agents, Agent Efficiency Directives. These apply to all agent spawns in this state and STATE 3.

### Spawn Phase 1 agents

> **EXPLICIT FOREGROUND INSTRUCTION**: Spawn all Phase 1 agents as parallel foreground Agent tool calls in a **SINGLE message**. Do NOT use `run_in_background: true`. The platform blocks you until ALL return. This is the enforcement mechanism — background agents can be forgotten; foreground agents cannot.

Spawn the following agents simultaneously (per scope table in [verify.md](../verify.md)):

#### build-info-collector

Spawn the `build-info-collector` agent (`subagent_type: build-info-collector`).

If build/lint errors were fixed above, pass: "Build errors were fixed
in this verification run. Collect the diff and summaries."

If no errors were fixed, pass: "No build errors were fixed."

#### security-defender (if scope is `full` or `security`)

Spawn the `security-defender` agent (`subagent_type: security-defender`). No additional context needed.

#### security-attacker (if scope is `full` or `security`)

Spawn the `security-attacker` agent (`subagent_type: security-attacker`). No additional context needed.

#### behavior-verifier (if scope is `full` or `security`)

Spawn the `behavior-verifier` agent (`subagent_type: behavior-verifier`). No additional context needed.

#### performance-reporter (if scope is `full` or `visual`, AND archetype is `web-app`)

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table, row "Performance + a11y agents".
>
> web-app: spawn performance-reporter + accessibility-scanner | service: skip | cli: skip

Spawn the `performance-reporter` agent (`subagent_type: performance-reporter`). No additional context needed.

#### accessibility-scanner (if scope is `full` or `visual`, AND archetype is `web-app`)

Spawn the `accessibility-scanner` agent (`subagent_type: accessibility-scanner`). No additional context needed.

#### spec-reviewer (if scope is `full` or `security`)

Spawn the `spec-reviewer` agent (`subagent_type: spec-reviewer`). Pass: "Read `.claude/agents/spec-reviewer.md` and execute all checks. Read `experiment/experiment.yaml` and `.runs/current-plan.md` (if it exists) as input. Return the output contract table and verdict."

### After Phase 1 agents return

After each agent returns, use [Trace State Detection](../verify.md#trace-state-detection) to check each spawned agent's trace individually. Use [Recovery Traces](../verify.md#recovery-traces) for agents that returned output but crashed before writing their trace. Use [Exhaustion Protocol](../verify.md#exhaustion-protocol) for agents in Trace State 2.

> **Template enforcement:** Read `.claude/agent-prompt-footer.md` and append its full content
> to every agent spawn prompt. The skill-agent-gate hook checks for the directive marker.

**POSTCONDITIONS:** All scope-required Phase 1 traces exist in `.runs/agent-traces/`.

**VERIFY:**
```bash
ls .runs/agent-traces/*.json >/dev/null 2>&1 && python3 -c "import glob; traces=glob.glob('.runs/agent-traces/*.json'); assert len(traces)>=1, 'no agent traces found: expected at least 1'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 2
```

**NEXT:** Read [state-3a-design-agents.md](state-3a-design-agents.md) to continue.
