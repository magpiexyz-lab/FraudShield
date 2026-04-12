#!/usr/bin/env bash
# verify-linter.sh — Detect VERIFY-postcondition drift in state files.
# Checks: artifact coverage, state-file/registry divergence, unjustified true VERIFY.
# Exit 0 if clean, exit 1 if UNCOVERED, UNJUSTIFIED_TRUE, or DIVERGED.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY="$REPO_ROOT/.claude/patterns/state-registry.json"
SKILLS_DIR="$REPO_ROOT/.claude/skills"

if [[ ! -f "$REGISTRY" ]]; then
  echo "ERROR: state-registry.json not found at $REGISTRY" >&2
  exit 1
fi

python3 - "$REGISTRY" "$SKILLS_DIR" <<'PYTHON_SCRIPT'
import json, sys, os, glob, re

registry_path = sys.argv[1]
skills_dir = sys.argv[2]

registry = json.load(open(registry_path))

# Keys that are not skills (no state files)
SKIP_KEYS = {"trace_schemas"}

uncovered = []
diverged = []
unjustified_true = []

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

# --- Output report ---
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

print(f"Summary: {len(uncovered)} uncovered, {len(diverged)} diverged, {len(unjustified_true)} unjustified_true")

# Exit code: 1 if UNCOVERED, UNJUSTIFIED_TRUE, or DIVERGED, 0 otherwise
if uncovered or unjustified_true or diverged:
    sys.exit(1)
PYTHON_SCRIPT
