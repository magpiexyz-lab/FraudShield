#!/usr/bin/env python3
"""Layer 2: Cross-Artifact Semantic Consistency Checks.

Part of Three-Layer Compliance Architecture.
Runs deterministic checks that the existing hook system does NOT perform.

Usage:
    python3 .claude/scripts/compliance-audit.py --skill <name> --run-id <id>

Output: .runs/compliance-audit-result.json
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

try:
    PROJECT_DIR = subprocess.check_output(
        ['git', 'rev-parse', '--show-toplevel'],
        stderr=subprocess.DEVNULL
    ).decode().strip()
except Exception:
    PROJECT_DIR = os.environ.get("CLAUDE_PROJECT_DIR", ".")
RUNS_DIR = os.path.join(PROJECT_DIR, ".runs")
REGISTRY_PATH = os.path.join(PROJECT_DIR, ".claude/patterns/state-registry.json")


def _read_skill_states(skill):
    """Read states list from skill.yaml."""
    skill_yaml = os.path.join(PROJECT_DIR, ".claude/skills", skill, "skill.yaml")
    if not os.path.isfile(skill_yaml):
        return []
    text = open(skill_yaml).read()
    m = re.search(r'states:\s*\[([^\]]+)\]', text)
    if not m:
        return []
    return [s.strip().strip('"').strip("'") for s in m.group(1).split(',')]


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def iso_to_epoch(ts):
    """Parse ISO 8601 timestamp to epoch seconds."""
    try:
        # Handle both with and without Z suffix
        ts = ts.rstrip("Z") + "+00:00"
        dt = datetime.fromisoformat(ts)
        return dt.timestamp()
    except Exception:
        return None


# --- Check (a): Artifact mtime vs trace timestamp ---
def check_artifact_mtime(skill):
    traces = glob.glob(os.path.join(RUNS_DIR, "agent-traces", "*.json"))
    if not traces:
        return {"name": "artifact_mtime", "result": "skip", "detail": "no agent traces found"}

    violations = []
    for path in traces:
        data = load_json(path)
        if not data or "timestamp" not in data:
            continue
        trace_epoch = iso_to_epoch(data["timestamp"])
        if trace_epoch is None:
            continue
        file_mtime = os.path.getmtime(path)
        delta = abs(file_mtime - trace_epoch)
        if delta > 60:
            violations.append(f"{os.path.basename(path)}: mtime delta {delta:.0f}s")

    if violations:
        return {"name": "artifact_mtime", "result": "fail",
                "detail": f"{len(violations)} trace(s) with suspicious mtime: {'; '.join(violations[:3])}"}
    return {"name": "artifact_mtime", "result": "pass", "detail": f"{len(traces)} traces checked"}


# --- Check (b): Fix-log count matching ---
def check_fix_log_count(skill):
    fix_log_path = os.path.join(RUNS_DIR, "fix-log.md")
    if not os.path.exists(fix_log_path):
        return {"name": "fix_log_count", "result": "skip", "detail": "no fix-log.md"}

    with open(fix_log_path) as f:
        content = f.read()
    fix_entries = len(re.findall(r"^\*\*Fix \d+\*\*", content, re.MULTILINE))

    # Find observer trace fixes_evaluated
    observer_path = os.path.join(RUNS_DIR, "agent-traces", "observer.json")
    observer = load_json(observer_path)
    if not observer or "fixes_evaluated" not in observer:
        return {"name": "fix_log_count", "result": "skip",
                "detail": f"fix-log has {fix_entries} entries but no observer trace with fixes_evaluated"}

    observer_count = observer.get("fixes_evaluated", 0)
    if fix_entries != observer_count:
        return {"name": "fix_log_count", "result": "fail",
                "detail": f"fix-log has {fix_entries} entries but observer.fixes_evaluated={observer_count}"}
    return {"name": "fix_log_count", "result": "pass",
            "detail": f"fix-log and observer agree: {fix_entries} entries"}


# --- Check (c): Behavior claims ---
def check_behavior_claims(skill):
    # No agent currently writes behaviors_checked — skip until agents are extended
    return {"name": "behavior_claims", "result": "skip",
            "detail": "no agent writes behaviors_checked field yet"}


# --- Check (d): checks_performed completeness ---
def check_checks_completeness(skill):
    registry = load_json(REGISTRY_PATH)
    if not registry:
        return {"name": "checks_completeness", "result": "skip",
                "detail": "cannot read state-registry.json"}

    # Read verify agent specs from skill.yaml (v2) or agent_gates (v1 fallback)
    agent_gates = registry.get("agent_gates", {})
    verify_gates = agent_gates.get("verify", {}) if agent_gates else {}
    traces_dir = os.path.join(RUNS_DIR, "agent-traces")
    if not os.path.isdir(traces_dir):
        return {"name": "checks_completeness", "result": "skip",
                "detail": "no agent-traces directory"}

    violations = []
    checked = 0

    for agent_name, spec in verify_gates.items():
        if agent_name.startswith("_"):
            continue
        required = spec.get("required_checks")
        if not required:
            continue

        # Find matching trace file (exact match or prefix match for per-page traces)
        trace_path = os.path.join(traces_dir, f"{agent_name}.json")
        if not os.path.exists(trace_path):
            # Try prefix match for per-page traces (design-critic-landing.json)
            matches = glob.glob(os.path.join(traces_dir, f"{agent_name}*.json"))
            if not matches:
                continue
            # Check all matching traces
            for match_path in matches:
                data = load_json(match_path)
                if not data:
                    continue
                performed = set(data.get("checks_performed", []))
                missing = set(required) - performed
                if missing:
                    violations.append(f"{os.path.basename(match_path)}: missing {sorted(missing)}")
                checked += 1
            continue

        data = load_json(trace_path)
        if not data:
            continue
        # Skip recovery traces — they legitimately have reduced checks
        if data.get("recovery"):
            checked += 1
            continue
        performed = set(data.get("checks_performed", []))
        missing = set(required) - performed
        if missing:
            violations.append(f"{agent_name}: missing {sorted(missing)}")
        checked += 1

    if checked == 0:
        return {"name": "checks_completeness", "result": "skip",
                "detail": "no agent traces with required_checks found"}
    if violations:
        return {"name": "checks_completeness", "result": "fail",
                "detail": f"{len(violations)} agent(s) with incomplete checks: {'; '.join(violations[:3])}"}
    return {"name": "checks_completeness", "result": "pass",
            "detail": f"{checked} agent traces verified against required_checks"}


# --- Check (e): Gate verdict downstream enforcement ---
def check_gate_enforcement(skill):
    verdicts_dir = os.path.join(RUNS_DIR, "gate-verdicts")
    if not os.path.isdir(verdicts_dir):
        return {"name": "gate_enforcement", "result": "skip",
                "detail": "no gate-verdicts directory"}

    verdict_files = glob.glob(os.path.join(verdicts_dir, "*.json"))
    if not verdict_files:
        return {"name": "gate_enforcement", "result": "skip",
                "detail": "no gate verdict files"}

    blocked_gates = []
    for vf in verdict_files:
        data = load_json(vf)
        if data and data.get("verdict") == "BLOCK":
            blocked_gates.append(os.path.basename(vf).replace(".json", ""))

    if not blocked_gates:
        return {"name": "gate_enforcement", "result": "pass",
                "detail": f"no BLOCK verdicts in {len(verdict_files)} gate files"}

    # If there are BLOCK verdicts, check that no downstream states were completed
    context_path = os.path.join(RUNS_DIR, f"{skill}-context.json")
    context = load_json(context_path)
    if not context:
        return {"name": "gate_enforcement", "result": "skip",
                "detail": f"BLOCK found in {blocked_gates} but no context file"}

    completed = set(str(s) for s in context.get("completed_states", []))
    registry = load_json(REGISTRY_PATH)
    if not registry:
        return {"name": "gate_enforcement", "result": "skip",
                "detail": "cannot read state-registry.json for state ordering"}

    required = _read_skill_states(skill)

    # Any BLOCK should mean the skill stopped — check if it actually completed
    if context.get("completed"):
        return {"name": "gate_enforcement", "result": "fail",
                "detail": f"skill marked completed despite BLOCK verdicts: {blocked_gates}"}

    return {"name": "gate_enforcement", "result": "pass",
            "detail": f"BLOCK verdicts {blocked_gates} respected — skill not marked completed"}


# --- Check (f): Missing required states ---
def check_missing_states(skill):
    context_path = os.path.join(RUNS_DIR, f"{skill}-context.json")
    context = load_json(context_path)
    if not context:
        return {"name": "missing_states", "result": "skip",
                "detail": f"no {skill}-context.json"}

    registry = load_json(REGISTRY_PATH)
    if not registry:
        return {"name": "missing_states", "result": "skip",
                "detail": "cannot read state-registry.json"}

    required = _read_skill_states(skill)
    if not required:
        return {"name": "missing_states", "result": "skip",
                "detail": f"no _required_states defined for {skill}"}

    completed = set(str(s) for s in context.get("completed_states", []))
    required_set = set(required)
    missing = required_set - completed

    if missing:
        # If exactly 1 state missing and it's the last required state,
        # this is the currently-executing epilogue state (audit runs before
        # advance-state marks it complete). Treat as pass.
        if len(missing) == 1 and str(required[-1]) in missing:
            return {"name": "missing_states", "result": "pass",
                    "detail": f"all pre-epilogue states completed ({len(required)-1}/{len(required)}), "
                              f"epilogue state {sorted(missing)[0]} executing"}
        return {"name": "missing_states", "result": "fail",
                "detail": f"missing states: {sorted(missing)} (completed: {sorted(completed)})"}
    return {"name": "missing_states", "result": "pass",
            "detail": f"all {len(required)} required states completed"}


# --- Condition resolver for trace_schemas conditional fields ---

def _is_webapp(trace_data, context_data):
    """Check if archetype is web-app from context or exploration-trace."""
    if context_data and context_data.get("archetype") == "web-app":
        return True
    et = load_json(os.path.join(RUNS_DIR, "exploration-trace.json"))
    return bool(et and et.get("archetype") == "web-app")


def _security_merge_has_issues():
    """Check if security-merge.json reports actual issues."""
    sm = load_json(os.path.join(RUNS_DIR, "security-merge.json"))
    return bool(sm and sm.get("merged_issues", 0) > 0
                and sm.get("source") != "no-security-agents")


def _has_fixes():
    """Check if fix-log.md has fix entries (consistent with check_b's detection)."""
    path = os.path.join(RUNS_DIR, "fix-log.md")
    if not os.path.exists(path):
        return False
    with open(path) as f:
        content = f.read()
    return bool(re.search(r"^\*\*Fix \d+\*\*", content, re.MULTILINE))


CONDITION_RESOLVERS = {
    # Phase 1: existing (upgraded to 3-arg)
    "when_full":            lambda t, c, ctx: t and t.get("mode") == "full",
    "when_light":           lambda t, c, ctx: t and t.get("mode") == "light",
    "when_rounds_gt_1":     lambda t, c, ctx: c and c.get("critic_rounds", 0) > 1,
    # Phase 2: change
    "when_solve_depth_full":    lambda t, c, ctx: ctx and ctx.get("solve_depth") == "full",
    "when_archetype_webapp":    lambda t, c, ctx: _is_webapp(t, ctx),
    # Phase 3: verify
    "when_scope_includes_security":         lambda t, c, ctx: ctx and ctx.get("scope") in ("full", "security"),
    "when_scope_includes_visual_and_webapp": lambda t, c, ctx: (
        ctx and ctx.get("scope") in ("full", "visual") and _is_webapp(t, ctx)
    ),
    "when_security_issues_found":           lambda t, c, ctx: _security_merge_has_issues(),
    "when_fixes_applied":                   lambda t, c, ctx: _has_fixes(),
}


def evaluate_condition(cond_key, trace_data, challenge_data, context_data=None):
    """Evaluate a trace_schemas condition key against actual data."""
    resolver = CONDITION_RESOLVERS.get(cond_key)
    return resolver(trace_data, challenge_data, context_data) if resolver else False


# --- Check (g): Trace schema conformance ---
def check_trace_schema_conformance(skill):
    registry = load_json(REGISTRY_PATH)
    if not registry:
        return {"name": "trace_schema_conformance", "result": "skip",
                "detail": "cannot read state-registry.json"}

    schema = registry.get("trace_schemas", {}).get(skill)
    if not schema:
        return {"name": "trace_schema_conformance", "result": "skip",
                "detail": f"no trace_schemas entry for {skill}"}

    violations = []

    # Load context_file for condition resolution
    context_file = schema.get("context_file")
    context_data = load_json(os.path.join(RUNS_DIR, context_file)) if context_file else None

    # Check trace_file fields
    trace_file = schema.get("trace_file")
    trace_data = None
    if trace_file:
        trace_data = load_json(os.path.join(RUNS_DIR, trace_file))
        if not trace_data:
            violations.append(f"{trace_file} missing or not valid JSON")
        else:
            for field in schema.get("required_fields", {}).get("always", []):
                if not trace_data.get(field):
                    violations.append(f"{trace_file}: {field} missing or empty")
            for cond_key, fields in schema.get("required_fields", {}).items():
                if cond_key == "always":
                    continue
                if evaluate_condition(cond_key, trace_data, None, context_data):
                    for field in fields:
                        if not trace_data.get(field):
                            violations.append(f"{trace_file}: {field} missing or empty (required by {cond_key})")

    # Check challenge_file fields
    challenge_file = schema.get("challenge_file")
    challenge_data = None
    if challenge_file:
        challenge_data = load_json(os.path.join(RUNS_DIR, challenge_file))
        if challenge_data:
            for field in schema.get("challenge_fields", {}).get("always", []):
                if field not in challenge_data:
                    violations.append(f"{challenge_file}: {field} missing")
            for cond_key, fields in schema.get("challenge_fields", {}).items():
                if cond_key == "always":
                    continue
                if evaluate_condition(cond_key, trace_data, challenge_data, context_data):
                    for field in fields:
                        if field not in challenge_data:
                            violations.append(f"{challenge_file}: {field} missing (required by {cond_key})")

    # Check extra_trace_files (e.g., exploration-trace.json for change)
    for extra_file, field_spec in schema.get("extra_trace_files", {}).items():
        extra_data = load_json(os.path.join(RUNS_DIR, extra_file))
        if not extra_data:
            violations.append(f"{extra_file} missing or not valid JSON")
        else:
            for field in field_spec.get("always", []):
                if not extra_data.get(field):
                    violations.append(f"{extra_file}: {field} missing or empty")
            for cond_key, fields in field_spec.items():
                if cond_key == "always":
                    continue
                if evaluate_condition(cond_key, trace_data, challenge_data, context_data):
                    for field in fields:
                        if not extra_data.get(field):
                            violations.append(f"{extra_file}: {field} missing or empty (required by {cond_key})")

    if not trace_file and not challenge_file and not schema.get("extra_trace_files"):
        return {"name": "trace_schema_conformance", "result": "skip",
                "detail": f"no trace/challenge/extra files defined for {skill}"}

    if violations:
        return {"name": "trace_schema_conformance", "result": "fail",
                "detail": f"{len(violations)} violation(s): {'; '.join(violations[:5])}"}
    return {"name": "trace_schema_conformance", "result": "pass",
            "detail": f"trace schema verified for {skill}"}


# --- Check (h): Agent trace coverage ---
def check_agent_trace_coverage(skill):
    registry = load_json(REGISTRY_PATH)
    if not registry:
        return {"name": "agent_trace_coverage", "result": "skip",
                "detail": "cannot read state-registry.json"}

    schema = registry.get("trace_schemas", {}).get(skill)
    if not schema:
        return {"name": "agent_trace_coverage", "result": "skip",
                "detail": f"no trace_schemas entry for {skill}"}

    expected = schema.get("expected_agent_traces", {})
    traces_dir = os.path.join(RUNS_DIR, "agent-traces")

    # Load data for condition resolution
    trace_file = schema.get("trace_file")
    trace_data = load_json(os.path.join(RUNS_DIR, trace_file)) if trace_file else None
    challenge_file = schema.get("challenge_file")
    challenge_data = load_json(os.path.join(RUNS_DIR, challenge_file)) if challenge_file else None
    context_file = schema.get("context_file")
    context_data = load_json(os.path.join(RUNS_DIR, context_file)) if context_file else None

    # Resolve exact agents and glob patterns separately
    required_agents = list(expected.get("always", []))
    required_globs = list(expected.get("always_glob", []))

    for cond_key, agents in expected.items():
        if cond_key in ("always", "always_glob"):
            continue
        if cond_key.endswith("_glob"):
            real_key = cond_key[:-5]  # strip "_glob"
            if evaluate_condition(real_key, trace_data, challenge_data, context_data):
                required_globs.extend(agents)
        else:
            if evaluate_condition(cond_key, trace_data, challenge_data, context_data):
                required_agents.extend(agents)

    if not required_agents and not required_globs:
        return {"name": "agent_trace_coverage", "result": "skip",
                "detail": f"no expected agents for {skill} in current mode"}

    # Check exact agents
    missing = [a for a in required_agents
               if not os.path.exists(os.path.join(traces_dir, f"{a}.json"))]

    # Check glob agents (at least 1 match required per pattern)
    missing_globs = []
    for pattern in required_globs:
        matches = glob.glob(os.path.join(traces_dir, f"{pattern}.json"))
        if not matches:
            missing_globs.append(f"{pattern} (0 matches)")

    all_missing = missing + missing_globs
    total_expected = len(required_agents) + len(required_globs)

    if all_missing:
        return {"name": "agent_trace_coverage", "result": "fail",
                "detail": f"missing agent traces: {all_missing}"}
    return {"name": "agent_trace_coverage", "result": "pass",
            "detail": f"{total_expected} expected agent trace(s) verified"}


# --- Cross-check handlers for check (i) ---

def _check_array_vs_trace_count(check_spec, challenge, traces_dir):
    """Verify challenge array length matches agent trace array length."""
    violations = []
    arr = challenge.get(check_spec["challenge_array"], [])
    trace_name = check_spec["trace"]
    trace_path = os.path.join(traces_dir, f"{trace_name}.json")
    trace = load_json(trace_path)
    if trace:
        trace_arr = trace.get(check_spec["trace_field"], [])
        if len(arr) != len(trace_arr):
            violations.append(
                f"{check_spec['challenge_array']} length ({len(arr)}) != "
                f"{trace_name}.{check_spec['trace_field']} length ({len(trace_arr)})")
    return violations


def _check_glob_status(check_spec, challenge, traces_dir):
    """Verify all glob-matched traces have expected status."""
    violations = []
    pattern = check_spec["trace_glob"]
    matches = glob.glob(os.path.join(traces_dir, f"{pattern}.json"))
    min_count = check_spec.get("min_count", 1)
    if len(matches) < min_count:
        if min_count > 0:
            violations.append(f"{pattern}: found {len(matches)}, need >= {min_count}")
        return violations
    for path in matches:
        data = load_json(path)
        if data:
            actual = data.get(check_spec["status_field"])
            expected = check_spec["expected_status"]
            if actual != expected:
                violations.append(
                    f"{os.path.basename(path)}: {check_spec['status_field']}="
                    f"{actual}, expected {expected}")
    return violations


def _check_all_agents_traced(check_spec, challenge, traces_dir):
    """Verify all agent traces completed (not just started).

    Accepts verdict, checks_performed, or status as completion indicators
    since different agent types use different fields.
    """
    violations = []
    if not os.path.isdir(traces_dir):
        return violations
    for path in glob.glob(os.path.join(traces_dir, "*.json")):
        data = load_json(path)
        if not data or data.get("recovery"):
            continue
        has_completion = (
            "verdict" in data
            or "checks_performed" in data
            or "status" in data
        )
        if not has_completion:
            violations.append(f"{os.path.basename(path)}: started but no completion indicator")
    return violations


CROSS_CHECK_HANDLERS = {
    "array_vs_trace_count": _check_array_vs_trace_count,
    "glob_status_check": _check_glob_status,
    "all_agents_traced": _check_all_agents_traced,
}


# --- Check (i): Cross-artifact count consistency ---
def check_cross_artifact_counts(skill):
    registry = load_json(REGISTRY_PATH)
    if not registry:
        return {"name": "cross_artifact_counts", "result": "skip",
                "detail": "cannot read state-registry.json"}

    schema = registry.get("trace_schemas", {}).get(skill)
    if not schema:
        return {"name": "cross_artifact_counts", "result": "skip",
                "detail": f"no trace_schemas entry for {skill}"}

    violations = []
    traces_dir = os.path.join(RUNS_DIR, "agent-traces")

    # Existing critic cross-check (runs whenever challenge_file has critic_rounds)
    challenge_file = schema.get("challenge_file")
    challenge = load_json(os.path.join(RUNS_DIR, challenge_file)) if challenge_file else None

    if challenge and challenge.get("critic_rounds") is not None:
        critic_path = os.path.join(traces_dir, "solve-critic.json")
        critic = load_json(critic_path)
        if critic:
            trace_round = critic.get("round")
            challenge_rounds = challenge.get("critic_rounds")
            if trace_round is not None and trace_round != challenge_rounds:
                violations.append(
                    f"critic_rounds mismatch: challenge={challenge_rounds}, trace round={trace_round}")

            if trace_round == 1:
                r1_ta = challenge.get("round_1_type_a_count")
                if r1_ta is not None and critic.get("type_a_count") is not None:
                    if r1_ta != critic["type_a_count"]:
                        violations.append(
                            f"round_1_type_a_count mismatch: challenge={r1_ta}, trace={critic['type_a_count']}")
            elif trace_round == 2:
                r2_ta = challenge.get("round_2_type_a_count")
                if r2_ta is not None and critic.get("type_a_count") is not None:
                    if r2_ta != critic["type_a_count"]:
                        violations.append(
                            f"round_2_type_a_count mismatch: challenge={r2_ta}, trace={critic['type_a_count']}")

            concerns = critic.get("concerns", [])
            ta = critic.get("type_a_count", 0)
            tb = critic.get("type_b_count", 0)
            tc = critic.get("type_c_count", 0)
            if len(concerns) != ta + tb + tc:
                violations.append(
                    f"concerns count={len(concerns)} != type_a({ta})+type_b({tb})+type_c({tc})")

    # Dispatch cross_checks from schema
    for check_spec in schema.get("cross_checks", []):
        handler = CROSS_CHECK_HANDLERS.get(check_spec.get("type"))
        if handler:
            violations.extend(handler(check_spec, challenge or {}, traces_dir))

    has_checks = challenge_file or schema.get("cross_checks")
    if not has_checks:
        return {"name": "cross_artifact_counts", "result": "skip",
                "detail": f"no challenge_file or cross_checks for {skill}"}

    if violations:
        return {"name": "cross_artifact_counts", "result": "fail",
                "detail": f"{len(violations)} mismatch(es): {'; '.join(violations)}"}
    return {"name": "cross_artifact_counts", "result": "pass",
            "detail": f"cross-artifact counts consistent for {skill}"}


def main():
    parser = argparse.ArgumentParser(description="Layer 2: Cross-artifact semantic consistency")
    parser.add_argument("--skill", required=True, help="Skill name")
    parser.add_argument("--run-id", required=True, help="Run ID from context")
    args = parser.parse_args()

    checks = [
        check_artifact_mtime(args.skill),
        check_fix_log_count(args.skill),
        check_behavior_claims(args.skill),
        check_checks_completeness(args.skill),
        check_gate_enforcement(args.skill),
        check_missing_states(args.skill),
        check_trace_schema_conformance(args.skill),
        check_agent_trace_coverage(args.skill),
        check_cross_artifact_counts(args.skill),
    ]

    anomaly_count = sum(1 for c in checks if c["result"] == "fail")
    overall = "fail" if anomaly_count > 0 else "pass"

    result = {
        "skill": args.skill,
        "run_id": args.run_id,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "checks": checks,
        "overall": overall,
        "anomaly_count": anomaly_count,
    }

    os.makedirs(RUNS_DIR, exist_ok=True)
    with open(os.path.join(RUNS_DIR, "compliance-audit-result.json"), "w") as f:
        json.dump(result, f, indent=2)
        f.write("\n")

    # Summary to stdout
    passed = sum(1 for c in checks if c["result"] == "pass")
    skipped = sum(1 for c in checks if c["result"] == "skip")
    print(f"Compliance audit: {overall} ({passed} pass, {anomaly_count} fail, {skipped} skip)")

    if anomaly_count > 0:
        for c in checks:
            if c["result"] == "fail":
                print(f"  FAIL: {c['name']} — {c['detail']}", file=sys.stderr)


if __name__ == "__main__":
    main()
