#!/usr/bin/env bash
# verify-linter.sh — Detect VERIFY-postcondition drift AND cross-file contradictions.
# Checks: artifact coverage, state-file/registry divergence, unjustified true VERIFY,
# declared-field / prose drift, cross-file contradictions (rule-driven).
# Exit 0 if clean, exit 1 if any category non-empty (overridden by --warn-only).
#
# CLI flags:
#   --json              Emit machine-readable JSON to stdout (no human report)
#   --cache <path>      Write findings to cache file (used by lifecycle-finalize.sh)
#   --warn-only         Always exit 0 (still print findings; for non-blocking checks)
#   --rules <path>      Override default rules file path

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY="$REPO_ROOT/.claude/patterns/state-registry.json"
SKILLS_DIR="$REPO_ROOT/.claude/skills"
RULES="$REPO_ROOT/.claude/patterns/template-coherence-rules.json"

JSON_OUT=""
CACHE_FILE=""
WARN_ONLY=""
STRICT_AOC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)        JSON_OUT="1"; shift ;;
    --cache)       CACHE_FILE="$2"; shift 2 ;;
    --warn-only)   WARN_ONLY="1"; shift ;;
    --strict-aoc)  STRICT_AOC="1"; shift ;;
    --rules)       RULES="$2"; shift 2 ;;
    *)             echo "ERROR: unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$REGISTRY" ]]; then
  echo "ERROR: state-registry.json not found at $REGISTRY" >&2
  exit 1
fi

export VL_JSON_OUT="$JSON_OUT"
export VL_CACHE_FILE="$CACHE_FILE"
export VL_WARN_ONLY="$WARN_ONLY"
export VL_STRICT_AOC="$STRICT_AOC"
export VL_RULES_PATH="$RULES"
export VL_REPO_ROOT="$REPO_ROOT"

python3 - "$REGISTRY" "$SKILLS_DIR" <<'PYTHON_SCRIPT'
import json, sys, os, glob, re

registry_path = sys.argv[1]
skills_dir = sys.argv[2]

# CLI flags exported from the bash wrapper
JSON_OUT = bool(os.environ.get("VL_JSON_OUT"))
CACHE_FILE = os.environ.get("VL_CACHE_FILE", "")
WARN_ONLY = bool(os.environ.get("VL_WARN_ONLY"))
STRICT_AOC = bool(os.environ.get("VL_STRICT_AOC"))
RULES_PATH = os.environ.get("VL_RULES_PATH", "")
STRICT_AOC_TYPES = {
    "verdict_vocab_consistency",
    "ledger_ownership",
    "consumer_coverage",
}
REPO_ROOT = os.environ.get("VL_REPO_ROOT", os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

registry = json.load(open(registry_path))

# Keys that are not skills (no state files)
SKIP_KEYS = {"trace_schemas"}

uncovered = []
diverged = []
unjustified_true = []
drift_declared = []
cross_file = []

# Phrases that count as matching prose for a declared `allows_early_exit_when` value.
# The declared value itself (with _ replaced by space) is always matched; this dict
# augments with common synonyms for known values.
SYNONYMS = {
    "no_fixes": ["no fixes succeeded", "0 fixes", "zero fixes", "no fixes applied"],
    "zero_findings": ["0 remaining findings", "zero findings", "no findings"],
    "baseline_unchanged": ["error count same or decreased", "final_errors <= baseline", "no regression"],
}

# Regex markers that must appear in a state's VERIFY for a declared `verify_semantics` value.
VERIFY_SEMANTIC_MARKERS = {
    "strict_zero": [r"exit\s+0", r"&&\s*python3\s+scripts/validate", r"==\s*0"],
    "no_regression_from_baseline": [r"baseline", r"<=\s*baseline", r"no regression", r"final_errors"],
    "artifact_exists": [r"\btest -f\b", r"os\.path\.exists", r"os\.path\.isfile"],
    "non_empty_diff": [r"git diff.*grep -q", r"diff.*--name-only"],
}

def extract_verify_cmd(value):
    """Extract the VERIFY command string from a registry entry."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and "verify" in value:
        return value["verify"]
    return None

def find_state_file(skill, state_id):
    """Glob for .claude/skills/<dir>/state-<id>-*.md."""
    SKILL_DIR_MAP = {
        "iterate-check": "iterate",
        "iterate-cross": "iterate",
    }
    directory = SKILL_DIR_MAP.get(skill, skill)
    pattern = os.path.join(skills_dir, directory, f"state-{state_id}-*.md")
    matches = glob.glob(pattern)
    return matches[0] if matches else None

def extract_section(text, header):
    """Extract content between **HEADER:** and the next **...:** section header.
    Skips matches inside code fences to avoid false positives."""
    lines = text.split('\n')
    in_fence = False
    capturing = False
    result = []
    target = f'**{header}:**'
    for line in lines:
        stripped = line.strip()
        # Track code fences
        if stripped.startswith('```'):
            in_fence = not in_fence
            if capturing:
                result.append(line)
            continue
        if in_fence:
            if capturing:
                result.append(line)
            continue
        # Outside code fences: look for section headers
        if not capturing and stripped.startswith(target):
            capturing = True
            # Capture any text after the header on the same line
            after = stripped[len(target):].strip()
            if after:
                result.append(after)
            continue
        if capturing:
            # Stop at the next bold section header
            if re.match(r'\*\*\w', stripped):
                break
            result.append(line)
    return '\n'.join(result).strip()

def extract_verify_from_file(text):
    """Extract VERIFY section content (both fenced and unfenced)."""
    # Find the VERIFY section
    verify_section = extract_section(text, "VERIFY")
    if not verify_section:
        return ""

    # Extract bash code fence content if present
    fence_match = re.search(r'```bash\s*\n(.*?)```', verify_section, re.DOTALL)
    if fence_match:
        return fence_match.group(1).strip()

    # Return the full section text (includes HTML comments, plain text)
    return verify_section

def extract_artifacts_from_postconditions(postcond_text):
    """Extract artifact file references from POSTCONDITIONS that represent created/written artifacts.
    Skips read-only references, deletion references, and conditional prior-run references."""
    artifacts = set()
    # Patterns that indicate the line is NOT about creating an artifact
    skip_patterns = re.compile(
        r'(?:read|understood|has been read|deleted|cleaned|rm -f|'
        r'If .*exists from a prior run|available in.memory|in-memory|'
        r'Context digest)',
        re.IGNORECASE
    )
    for line in postcond_text.split('\n'):
        stripped = line.strip()
        if not stripped or skip_patterns.search(stripped):
            continue
        # .runs/something.json, .runs/something.md, .runs/something.jsonl, .runs/something.txt
        for m in re.finditer(r'\.runs/[\w\-/]+\.(?:json|md|jsonl|txt)\b', stripped):
            artifacts.add(m.group(0))
        # experiment/*.yaml — only if the line suggests creation/modification
        for m in re.finditer(r'experiment/[\w\-]+\.yaml', stripped):
            artifacts.add(m.group(0))
        # package.json — only if not read-only
        if 'package.json' in stripped:
            artifacts.add('package.json')
    return artifacts

def has_skip_annotation(postcond_text):
    """Check if postconditions have the skip annotation."""
    return '<!-- enforced by agent behavior, not VERIFY gate -->' in postcond_text

def normalize_verify(cmd):
    """Normalize a VERIFY command for comparison: strip echo, whitespace, comments."""
    if not cmd:
        return ""
    lines = []
    for line in cmd.split('\n'):
        stripped = line.strip()
        # Skip empty lines, echo-only lines, pure comments
        if not stripped:
            continue
        if stripped.startswith('echo ') or stripped == 'echo':
            continue
        if stripped.startswith('#'):
            continue
        if stripped.startswith('<!--'):
            continue
        lines.append(stripped)
    return '\n'.join(lines)

def commands_diverge(file_verify, registry_verify):
    """Check if state file VERIFY and registry VERIFY have substantive differences."""
    norm_file = normalize_verify(file_verify)
    norm_reg = normalize_verify(registry_verify)

    if not norm_file and not norm_reg:
        return False

    # Both empty after normalization = no divergence
    if not norm_file or not norm_reg:
        # One is empty, one isn't — could be intentional (file has comments only)
        # Only flag if registry has real commands but file doesn't (or vice versa)
        if norm_reg and not norm_file:
            return True
        return False

    # Compare the substantive content
    return norm_file != norm_reg

def check_declared_drift(skill, state_id, value, file_text):
    """Detect drift between declarative fields in state-registry.json and state-file prose.

    Declarations are ESCAPE HATCHES that tell cross-file consistency audits
    (e.g. /review Dimension A) that a pattern is intentional. They must stay in
    sync with state-file prose, or they become silent false-negatives.

    Checked fields:
      - allows_early_exit_when: must have matching phrase in ACTIONS
      - verify_semantics: must have matching regex marker in VERIFY
    """
    out = []
    if not isinstance(value, dict):
        return out

    actions_text = extract_section(file_text, "ACTIONS").lower()
    verify_text = (extract_verify_from_file(file_text) + " " + extract_section(file_text, "VERIFY")).lower()

    declared_exit = value.get("allows_early_exit_when")
    if declared_exit:
        phrases = [declared_exit.replace("_", " ")] + SYNONYMS.get(declared_exit, [])
        if not any(p.lower() in actions_text for p in phrases):
            out.append(
                f"  [{skill}:{state_id}] allows_early_exit_when='{declared_exit}' "
                f"but ACTIONS prose lacks matching phrase (tried: {phrases})"
            )

    declared_sem = value.get("verify_semantics")
    if declared_sem:
        pats = VERIFY_SEMANTIC_MARKERS.get(declared_sem, [])
        if pats and not any(re.search(p, verify_text) for p in pats):
            out.append(
                f"  [{skill}:{state_id}] verify_semantics='{declared_sem}' "
                f"but VERIFY lacks matching markers (expected one of: {pats})"
            )
    return out

for skill, states in registry.items():
    if skill in SKIP_KEYS:
        continue
    if not isinstance(states, dict):
        continue

    for state_id, value in states.items():
        # Skip metadata keys
        if state_id.startswith('_'):
            continue

        verify_cmd = extract_verify_cmd(value)
        if verify_cmd is None:
            continue

        state_file = find_state_file(skill, state_id)
        if not state_file:
            print(f"WARNING: No state file for [{skill}:{state_id}]", file=sys.stderr)
            continue

        file_text = open(state_file).read()

        # --- Check 1: Artifact reference coverage ---
        postcond_text = extract_section(file_text, "POSTCONDITIONS")
        if postcond_text and not has_skip_annotation(postcond_text):
            artifacts = extract_artifacts_from_postconditions(postcond_text)
            for artifact in sorted(artifacts):
                basename = os.path.basename(artifact)
                # Check if artifact or its basename appears in registry VERIFY
                if basename not in verify_cmd and artifact not in verify_cmd:
                    # Extract the postcondition line mentioning this artifact
                    context_line = ""
                    for line in postcond_text.split('\n'):
                        if artifact in line or basename in line:
                            context_line = line.strip().lstrip('- ')
                            break
                    uncovered.append(
                        f"  [{skill}:{state_id}] {artifact} -- postcondition: \"{context_line[:80]}\""
                    )

        # --- Check 2: State file / registry divergence ---
        # Skip divergence check for VERIFY=true entries (state files have prose justifications)
        file_verify = extract_verify_from_file(file_text)
        if verify_cmd.strip() != "true" and commands_diverge(file_verify, verify_cmd):
            file_summary = normalize_verify(file_verify)[:60].replace('\n', ' | ')
            reg_summary = normalize_verify(verify_cmd)[:60].replace('\n', ' | ')
            diverged.append(
                f"  [{skill}:{state_id}] -- state file: {file_summary} | registry: {reg_summary}"
            )

        # --- Check 3: Unjustified true VERIFY ---
        if verify_cmd.strip() == "true":
            has_justification = (
                '<!-- VERIFY=true:' in file_text or
                '# VERIFY=true:' in file_text
            )
            if not has_justification:
                unjustified_true.append(
                    f"  [{skill}:{state_id}] -- VERIFY is \"true\" but no justification comment found"
                )

        # --- Check 4: Declared field / prose drift ---
        drift_declared.extend(check_declared_drift(skill, state_id, value, file_text))


# ---------------------------------------------------------------------------
# Check 5: Cross-file contradictions (rule-driven)
# ---------------------------------------------------------------------------

def check_field_role_map(rule):
    """Verify each consumer mentions the canonical derivation function and
    contains no count-based raw access patterns to the named field.

    Rule shape:
      {
        "id": "<rule_id>",
        "type": "field_role_map",
        "field": "<field_name>",         # e.g. "golden_path"
        "canonical_function": "<name>",  # e.g. "derive_scope_pages"
        "consumers": ["<file>", ...]     # paths relative to repo root
      }

    Mention check (consumer must call canonical OR have explicit pragma):
      `<canonical>(` substring OR `<!-- coherence-allow: raw-<field>` pragma

    Forbidden patterns (UNCONDITIONAL — pragma cannot whitelist these):
      `len(... <field> ...)` and `set(... <field> ...)`
      Count-based access defeats the centralization purpose.
    """
    out = []
    canonical = rule.get("canonical_function", "")
    field = rule.get("field", "")
    rid = rule.get("id", "<unknown>")
    if not canonical or not field:
        out.append(f"  [{rid}] rule definition incomplete (need canonical_function and field)")
        return out

    forbidden = [
        re.compile(rf"\blen\s*\(\s*[^)]*\b{re.escape(field)}\b"),
        re.compile(rf"\bset\s*\(\s*[^)]*\b{re.escape(field)}\b"),
    ]
    pragma_marker = f"<!-- coherence-allow: raw-{field}"

    for consumer_path in rule.get("consumers", []):
        full = os.path.join(REPO_ROOT, consumer_path)
        if not os.path.isfile(full):
            out.append(f"  [{rid}] consumer not found on disk: {consumer_path}")
            continue
        text = open(full).read()
        has_canonical = canonical in text
        has_pragma = pragma_marker in text
        if not has_canonical and not has_pragma:
            out.append(
                f"  [{rid}] {consumer_path} doesn't mention {canonical}() and has no "
                f"`{pragma_marker} (...)` pragma"
            )
        for pat in forbidden:
            for m in pat.finditer(text):
                # Find which line for human-friendly reporting
                line_num = text[: m.start()].count("\n") + 1
                out.append(
                    f"  [{rid}] {consumer_path}:{line_num} forbidden count-based access: "
                    f"{m.group(0)!r} (pragma cannot whitelist this)"
                )
    return out


# Patterns that indicate an artifact reference is NOT a real consumption
# (used to filter false positives in artifact_lifecycle check). Mirrors the
# existing `extract_artifacts_from_postconditions` skip_patterns precedent.
_ARTIFACT_SKIP_PATTERNS = re.compile(
    r"(?:not\s+os\.path\.exists|"
    r"not\s+os\.path\.isfile|"
    r"deleted|cleaned|rm\s+-f|"
    r"if\s+.*exists\s+from\s+a\s+prior\s+run)",
    re.IGNORECASE,
)


def check_artifact_lifecycle(rule):
    """Verify artifact producer/consumer ordering across states in a skill.

    Rule shape:
      {
        "id": "<rule_id>",
        "type": "artifact_lifecycle",
        "skill": "<skill_name>"     # which skill's states to scan
      }

    For the named skill: each state can declare optional `produces: [...]`
    and `do_not_modify: [...]` arrays in state-registry.json. The check:
      (a) every artifact appearing in a state's VERIFY (regex-extracted)
          MUST be in some upstream state's `produces` declaration, OR
          NOT be `do_not_modify` flagged anywhere upstream
      (b) `do_not_modify[X]` declared in state B + `produces[X]` declared
          in any state after B = DO_NOT_MODIFY_VIOLATION

    Conservative: only fires when both `produces` and `do_not_modify` are
    explicitly declared. Pure prose (e.g. "do not write to X" in ACTIONS)
    is intentionally NOT parsed — too brittle.
    """
    out = []
    skill = rule.get("skill", "")
    rid = rule.get("id", "<unknown>")
    if not skill or skill not in registry or not isinstance(registry[skill], dict):
        return out

    states = registry[skill]
    # Build state ordering from registry key order (insertion order is preserved
    # in Python 3.7+ JSON load and reflects the canonical skill flow).
    ordered_states = [s for s in states if not s.startswith("_") and isinstance(states[s], (dict, str))]
    state_position = {s: i for i, s in enumerate(ordered_states)}

    produces_at = {}     # artifact -> earliest state position that produces it
    forbids_at = {}      # artifact -> earliest state position that forbids it

    for sid in ordered_states:
        val = states[sid]
        if not isinstance(val, dict):
            continue
        for a in (val.get("produces") or []):
            produces_at.setdefault(a, []).append(state_position[sid])
        for a in (val.get("do_not_modify") or []):
            forbids_at.setdefault(a, []).append(state_position[sid])

    # Check (a): VERIFY-referenced artifacts must have a producer upstream
    artifact_re = re.compile(r"\.runs/[a-z0-9-]+\.(?:json|md|jsonl|txt|flag)")
    for sid in ordered_states:
        val = states[sid]
        verify_cmd = extract_verify_cmd(val)
        if not verify_cmd or verify_cmd.strip() == "true":
            continue
        if _ARTIFACT_SKIP_PATTERNS.search(verify_cmd):
            # Verify contains negated/skip patterns; conservative — skip
            continue
        for m in artifact_re.finditer(verify_cmd):
            artifact = m.group(0)
            sid_pos = state_position[sid]
            producer_positions = produces_at.get(artifact, [])
            if producer_positions and not any(p <= sid_pos for p in producer_positions):
                out.append(
                    f"  [{rid}] {skill}:{sid} VERIFY references {artifact} "
                    f"but no upstream state declares produces"
                )

    # Check (b): do_not_modify[X] cannot precede produces[X]
    for artifact, forbid_positions in forbids_at.items():
        producer_positions = produces_at.get(artifact, [])
        for fp in forbid_positions:
            for pp in producer_positions:
                if fp < pp:
                    forbid_state = ordered_states[fp]
                    produce_state = ordered_states[pp]
                    out.append(
                        f"  [{rid}] {skill}:{forbid_state} do_not_modify includes {artifact} "
                        f"but {skill}:{produce_state} (later) declares produces"
                    )
    return out


# ---------------------------------------------------------------------------
# AOC v1 rule dispatchers (R1/R2/R3)
# ---------------------------------------------------------------------------

def _emit_finding(rule, message):
    """Emit a finding string tagged with rule id + type so downstream
    exit-logic can partition by rule type for --strict-aoc."""
    rid = rule.get("id", "<unknown>")
    rtype = rule.get("type", "<unknown>")
    sev = rule.get("severity", "block")
    return f"  [{rid}] ({rtype}/{sev}) {message}"


def check_verdict_vocab_consistency(rule):
    """AOC v1 R1: agent definitions must emit only verdicts/results declared
    in verdict_agents_schema, and lib-verdict.sh predicates must reference
    only declared verdict values."""
    findings = []
    rid = rule.get("id", "<unknown>")

    reg_path = os.path.join(REPO_ROOT, rule.get("registry_path", ""))
    if not os.path.isfile(reg_path):
        findings.append(_emit_finding(rule, f"registry file missing: {reg_path}"))
        return findings
    try:
        reg = json.load(open(reg_path))
    except (OSError, json.JSONDecodeError) as e:
        findings.append(_emit_finding(rule, f"cannot read registry: {e}"))
        return findings

    schema = reg.get("verdict_agents_schema", {})
    if not schema:
        findings.append(_emit_finding(rule, "verdict_agents_schema missing from registry"))
        return findings

    # Build a union of all declared verdicts/results across agents.
    all_verdicts = set()
    all_results = set()
    for agent_name, spec in schema.items():
        for v in spec.get("allowed_verdicts", []):
            if v is not None:
                all_verdicts.add(v)
        for r in spec.get("allowed_results", []):
            if r is not None:
                all_results.add(r)

    # Core verdict vocabulary is fixed at 4 values per AOC v1.
    AOC_CORE_VERDICTS = {"pass", "fail", "blocked", "unresolved"}
    for v in all_verdicts:
        if v not in AOC_CORE_VERDICTS:
            findings.append(_emit_finding(
                rule,
                f"verdict_agents_schema contains non-AVS-v1 verdict: {v!r}. "
                f"Allowed core verdicts are {sorted(AOC_CORE_VERDICTS)}."
            ))

    # Scan predicate file for verdict literals and confirm they are in the
    # core vocabulary (predicates should never reference legacy verdicts).
    pred_path = os.path.join(REPO_ROOT, rule.get("predicate_file", ""))
    if os.path.isfile(pred_path):
        try:
            pred_content = open(pred_path).read()
        except OSError:
            pred_content = ""
        # Find all double-quoted or single-quoted strings compared to t.get('verdict')
        # Heuristic: look for patterns like: t.get('verdict') == 'VALUE' or 'VALUE' in (...)
        verdict_literal_re = re.compile(
            r"t\.get\(['\"]verdict['\"]\)\s*==?\s*['\"]([a-zA-Z_\-]+)['\"]"
        )
        tuple_literal_re = re.compile(
            r"t\.get\(['\"]verdict['\"]\)\s+in\s*\(([^)]*)\)"
        )
        for m in verdict_literal_re.finditer(pred_content):
            lit = m.group(1)
            if lit not in AOC_CORE_VERDICTS and lit not in all_verdicts:
                findings.append(_emit_finding(
                    rule,
                    f"{rule.get('predicate_file')} references non-registry verdict {lit!r}"
                ))
        for m in tuple_literal_re.finditer(pred_content):
            tuple_body = m.group(1)
            for lit_m in re.finditer(r"['\"]([a-zA-Z_\-]+)['\"]", tuple_body):
                lit = lit_m.group(1)
                if lit not in AOC_CORE_VERDICTS and lit not in all_verdicts:
                    findings.append(_emit_finding(
                        rule,
                        f"{rule.get('predicate_file')} references non-registry verdict {lit!r}"
                    ))

    # Scan agent files (under agent_files_glob) for verdict values emitted.
    # We look for `"verdict":"<value>"` patterns; values like `<verdict>`
    # or `<pass|fail>` are templates and excluded.
    agent_glob = rule.get("agent_files_glob", "")
    if agent_glob:
        abs_glob = os.path.join(REPO_ROOT, agent_glob)
        verdict_agents = set(schema.keys())
        for agent_file in sorted(glob.glob(abs_glob)):
            agent_base = os.path.basename(agent_file).replace(".md", "")
            if agent_base not in verdict_agents:
                continue  # Only enforce the declared 17 verdict_agents.
            try:
                content = open(agent_file).read()
            except OSError:
                continue
            spec = schema.get(agent_base, {})
            allowed_v = set(spec.get("allowed_verdicts", []))
            # Detect `"verdict":"<literal>"` (legacy uppercase, multi-word, or unknown-value emissions).
            # Values starting with `<` are template placeholders (e.g. <pass|fail>, <verdict>) — skip.
            # Values containing `|` alone are template alternation — skip.
            for m in re.finditer(r'"verdict"\s*:\s*"([^"<>]+)"', content):
                lit = m.group(1).strip()
                if not lit:
                    continue
                if "|" in lit:
                    continue
                # Normalize casing
                lit_norm = lit.lower() if lit.lower() in {"pass", "fail", "blocked", "unresolved"} else lit
                if lit_norm not in allowed_v and lit not in allowed_v:
                    findings.append(_emit_finding(
                        rule,
                        f"{os.path.relpath(agent_file, REPO_ROOT)}: emits verdict {lit!r} not in allowed_verdicts {sorted(allowed_v)}"
                    ))

    return findings


def check_ledger_ownership(rule):
    """AOC v1 R2: gated_paths must be written only by allowed_writers.
    Scans template directories (.claude/agents, .claude/hooks,
    .claude/scripts, .claude/skills, .claude/patterns) for writes targeting
    gated_paths and reports any outside the allowed_writers list."""
    findings = []
    allowed = set(rule.get("allowed_writers", []))
    gated_paths = rule.get("gated_paths", [])
    # Build per-path escaped regex segments (literal paths).
    # Detect writes: patterns like "> .runs/fix-log.md", ">> .runs/fix-log.md",
    # "open('.runs/fix-log.md'", "open(\".runs/fix-log.md\"", and "with open('.runs/fix-log.md', 'a')".
    scan_roots = [
        ".claude/agents",
        ".claude/hooks",
        ".claude/scripts",
        ".claude/skills",
        ".claude/patterns",
    ]
    # Test directories contain fixture strings that intentionally reference
    # gated paths; do not scan them.
    SKIP_PREFIXES = (
        ".claude/scripts/tests/",
        ".claude/scripts/lib/tests/",
    )
    for gated in gated_paths:
        esc = re.escape(gated)
        write_patterns = [
            re.compile(r">{1,2}\s*" + esc),                             # shell redirect
            re.compile(r"open\(\s*['\"]" + esc + r"['\"]\s*,\s*['\"][wa]\+?b?['\"]"),  # open(path, 'w'/'a')
            re.compile(r"open\(\s*['\"]" + esc + r"['\"]\)[^)]*\.write\("),  # open(path).write( — rare
        ]
        for root in scan_roots:
            root_abs = os.path.join(REPO_ROOT, root)
            if not os.path.isdir(root_abs):
                continue
            for dirpath, _dirs, files in os.walk(root_abs):
                for fn in files:
                    if not (fn.endswith(".md") or fn.endswith(".sh")
                            or fn.endswith(".py") or fn.endswith(".json")):
                        continue
                    fpath = os.path.join(dirpath, fn)
                    relpath = os.path.relpath(fpath, REPO_ROOT)
                    # Skip the coherence rules file itself (declares paths as strings)
                    # and the contract docs.
                    if relpath == "/".join([".claude/patterns",
                                            "template-coherence-rules.json"]):
                        continue
                    if relpath == "/".join([".claude/patterns",
                                            "agent-output-contract.md"]):
                        continue
                    # Skip the linter itself: its regex patterns literally
                    # contain the gated paths for detection purposes.
                    if relpath == "/".join([".claude/scripts",
                                            "verify-linter.sh"]):
                        continue
                    # Skip the runtime write guard: it contains the gated
                    # paths in its detection/deny regexes.
                    if relpath == "/".join([".claude/hooks",
                                            "fix-ledger-write-guard.sh"]):
                        continue
                    # Skip test fixtures.
                    if any(relpath.startswith(p) for p in SKIP_PREFIXES):
                        continue
                    if relpath in allowed:
                        continue  # Allowed writer; its writes are legitimate.
                    try:
                        content = open(fpath).read()
                    except OSError:
                        continue
                    for pat in write_patterns:
                        for m in pat.finditer(content):
                            # Skip when the mention is inside a code comment
                            # that references AOC v1 contract.
                            line_start = content.rfind("\n", 0, m.start()) + 1
                            line_end = content.find("\n", m.end())
                            if line_end == -1:
                                line_end = len(content)
                            line = content[line_start:line_end]
                            low = line.lower()
                            if "aoc v1" in low or "# documented pattern" in low:
                                continue
                            findings.append(_emit_finding(
                                rule,
                                f"{relpath}: writes to gated path {gated} outside allowed writers"
                            ))
                            break  # one finding per file+path
                        else:
                            continue
                        break
    return findings


def check_consumer_coverage(rule):
    """AOC v1 R3: every consumer must reference canonical_source (path string)."""
    findings = []
    canonical = rule.get("canonical_source", "")
    consumers = rule.get("consumers", [])
    canonical_basename = os.path.basename(canonical)
    # The literal canonical path or its basename is sufficient evidence.
    needles = [canonical, canonical_basename]
    for consumer in consumers:
        fpath = os.path.join(REPO_ROOT, consumer)
        if not os.path.isfile(fpath):
            findings.append(_emit_finding(
                rule,
                f"{consumer}: consumer file missing"
            ))
            continue
        try:
            content = open(fpath).read()
        except OSError as e:
            findings.append(_emit_finding(
                rule,
                f"{consumer}: cannot read ({e})"
            ))
            continue
        if not any(n and n in content for n in needles):
            findings.append(_emit_finding(
                rule,
                f"{consumer}: does not reference canonical source {canonical}"
            ))
    return findings


# Load and run cross-file rules
if os.path.isfile(RULES_PATH):
    try:
        rules_data = json.load(open(RULES_PATH))
        for rule in rules_data.get("rules", []):
            rtype = rule.get("type")
            if rtype == "field_role_map":
                cross_file.extend(check_field_role_map(rule))
            elif rtype == "artifact_lifecycle":
                cross_file.extend(check_artifact_lifecycle(rule))
            elif rtype == "verdict_vocab_consistency":
                cross_file.extend(check_verdict_vocab_consistency(rule))
            elif rtype == "ledger_ownership":
                cross_file.extend(check_ledger_ownership(rule))
            elif rtype == "consumer_coverage":
                cross_file.extend(check_consumer_coverage(rule))
            else:
                cross_file.append(f"  [{rule.get('id','<unknown>')}] unknown rule type: {rtype}")
    except (OSError, json.JSONDecodeError) as e:
        cross_file.append(f"  [framework] failed to load rules from {RULES_PATH}: {e}")


# ---------------------------------------------------------------------------
# Output: JSON or human-readable report
# ---------------------------------------------------------------------------

if JSON_OUT or CACHE_FILE:
    payload = {
        "uncovered": uncovered,
        "diverged": diverged,
        "unjustified_true": unjustified_true,
        "drift_declared": drift_declared,
        "cross_file_contradiction": cross_file,
        "summary": {
            "uncovered": len(uncovered),
            "diverged": len(diverged),
            "unjustified_true": len(unjustified_true),
            "drift_declared": len(drift_declared),
            "cross_file_contradiction": len(cross_file),
        },
    }
    if CACHE_FILE:
        os.makedirs(os.path.dirname(CACHE_FILE) or ".", exist_ok=True)
        with open(CACHE_FILE, "w") as f:
            json.dump(payload, f, indent=2)
    if JSON_OUT:
        print(json.dumps(payload, indent=2))

# Human report (suppressed when JSON_OUT is set)
if not JSON_OUT:
    print("VERIFY Linter Report")
    print("====================")
    print()

    if uncovered:
        print("UNCOVERED (artifact in postcondition but not in VERIFY):")
        for line in uncovered:
            print(line)
        print()

    if diverged:
        print("DIVERGED (state file VERIFY != registry VERIFY):")
        for line in diverged:
            print(line)
        print()

    if unjustified_true:
        print("UNJUSTIFIED_TRUE:")
        for line in unjustified_true:
            print(line)
        print()

    if drift_declared:
        print("DRIFT_DECLARED_VS_PROSE (registry declaration disagrees with state-file prose):")
        for line in drift_declared:
            print(line)
        print()

    if cross_file:
        print("CROSS_FILE_CONTRADICTION (template-coherence-rules.json violations):")
        for line in cross_file:
            print(line)
        print()

    print(
        f"Summary: {len(uncovered)} uncovered, {len(diverged)} diverged, "
        f"{len(unjustified_true)} unjustified_true, {len(drift_declared)} drift_declared, "
        f"{len(cross_file)} cross_file_contradiction"
    )

# Exit code — layered semantics:
#   default (no flags): any finding blocks (exit 1).
#   --warn-only: downgrades ALL findings to warnings (exit 0).
#   --strict-aoc: forces AOC findings (R1/R2/R3) to block regardless of
#                 --warn-only; other findings still honor --warn-only.
#
# AOC findings are tagged in their message string by _emit_finding with
# "(<rule_type>/<severity>)". Partition cross_file by presence of STRICT_AOC_TYPES.

def _is_aoc_finding(msg):
    return any(f"({t}/" in msg for t in STRICT_AOC_TYPES)


aoc_findings = [m for m in cross_file if _is_aoc_finding(m)]
non_aoc_findings = (
    uncovered + unjustified_true + diverged + drift_declared +
    [m for m in cross_file if not _is_aoc_finding(m)]
)

should_block = False
# AOC findings: block when not warn-only OR when strict-aoc is set.
if aoc_findings and (not WARN_ONLY or STRICT_AOC):
    should_block = True
# Non-AOC findings: block only when not warn-only (strict-aoc does not apply).
if non_aoc_findings and not WARN_ONLY:
    should_block = True
if should_block:
    sys.exit(1)
PYTHON_SCRIPT
