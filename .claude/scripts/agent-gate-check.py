#!/usr/bin/env python3
"""Agent gate detection and registry checks for agent-state-gate.sh.

Detects active skill from context files, loads state-registry.json,
checks gate conditions (isolation, background, required_states, artifacts).
Returns tab-separated: skill<TAB>warn on line 1, errors on subsequent lines.
"""
import glob
import json
import os
import sys


def main():
    project = os.environ.get('CLAUDE_PROJECT_DIR', '.')
    agent_type = os.environ.get('_AGENT_TYPE', '')
    payload_str = os.environ.get('_PAYLOAD', '{}')

    try:
        payload = json.loads(payload_str)
    except:
        payload = {}

    isolation = payload.get('tool_input', {}).get('isolation', '')

    # 1. Detect active skill — scan *-context.json, pick most recent timestamp
    ctx_files = glob.glob(os.path.join(project, '.runs', '*-context.json'))
    # Filter out epilogue-context.json for active skill detection
    ctx_files = [f for f in ctx_files if 'epilogue-context' not in f]

    best_skill = ''
    best_ts = ''
    for cf in ctx_files:
        try:
            d = json.load(open(cf))
            ts = d.get('timestamp', '')
            if ts > best_ts:
                best_ts = ts
                best_skill = d.get('skill', os.path.basename(cf).replace('-context.json', ''))
        except:
            pass

    if not best_skill:
        print(json.dumps({'skill': '', 'errors': [], 'warn': ''}))
        sys.exit(0)

    # 2. Load registry
    reg_path = os.path.join(project, '.claude', 'patterns', 'state-registry.json')
    if not os.path.isfile(reg_path):
        print(json.dumps({'skill': best_skill, 'errors': [], 'warn': 'registry missing'}))
        sys.exit(0)

    reg = json.load(open(reg_path))
    agent_gates = reg.get('agent_gates', {})
    skill_gates = agent_gates.get(best_skill, {})

    # 3. Resolve gate config for this agent type
    gate = skill_gates.get(agent_type, skill_gates.get('_default', None))

    errors = []
    warn = ''

    if gate is None:
        if skill_gates:
            warn = f'unrecognized agent {agent_type} for skill {best_skill}'
        # else: skill has no gates at all — silent allow
    elif gate.get('allow_unconditional'):
        pass  # always allow
    else:
        # Check deny_isolation
        for denied in gate.get('deny_isolation', []):
            if isolation == denied:
                errors.append(f'{agent_type} cannot use isolation={denied} — agents for {best_skill} must share the main filesystem')

        # Check deny_background
        run_in_bg = payload.get('tool_input', {}).get('run_in_background', False)
        deny_bg = gate.get('deny_background', False)
        if deny_bg and run_in_bg:
            errors.append(f"Agent type '{agent_type}' requires foreground execution (deny_background=true) but run_in_background=true")

        # Check required_states (using registry key order for proper ordering)
        required = gate.get('required_states', [])
        if required:
            ctx_file = os.path.join(project, '.runs',
                'verify-context.json' if best_skill == 'verify'
                else f'{best_skill}-context.json')
            if os.path.isfile(ctx_file):
                ctx = json.load(open(ctx_file))
                cs = [str(s) for s in ctx.get('completed_states', [])]
                if not cs:
                    pass  # Fail-open if field absent (backward compat)
                else:
                    missing = [str(r) for r in required if str(r) not in cs]
                    if missing:
                        errors.append(f"States [{','.join(missing)}] not in completed_states — prerequisite states were skipped")

        # Check artifacts
        for art in gate.get('artifacts', []):
            art_path = os.path.join(project, art)
            if not os.path.isfile(art_path):
                errors.append(f'{os.path.basename(art)} missing — required artifact for {agent_type}')

    # Output tab-separated: skill\twarn on first line, errors on subsequent lines.
    # Parsed directly by bash (head/cut/tail) — no second python3 invocation needed.
    print(best_skill + '\t' + warn)
    for e in errors:
        print(e)


if __name__ == "__main__":
    main()
