#!/usr/bin/env bash
# lifecycle-init.sh — Phase 1: Initialize skill execution from skill.yaml manifest.
# Usage: bash .claude/scripts/lifecycle-init.sh <skill> [extra_json]
# Examples:
#   bash .claude/scripts/lifecycle-init.sh solve
#   bash .claude/scripts/lifecycle-init.sh change '{"preliminary_type":null}'
#   bash .claude/scripts/lifecycle-init.sh iterate '{"mode":"check"}'
#
# Steps:
#   1. Parse .claude/skills/<skill>/skill.yaml → .runs/<skill>-manifest.json
#   2. If modes present + extra has mode field → select that mode's states
#   3. If branch field present + not in worktree → create branch
#   4. Create canonical context via init-context.sh <skill>
#
# Fallback: if skill.yaml not found → warn, call init-context.sh only (v1 compat)
set -euo pipefail

SKILL="${1:-}"
EXTRA="${2:-}"

if [[ -z "$SKILL" ]]; then
  echo "ERROR: lifecycle-init.sh — skill name required" >&2
  echo "Usage: bash .claude/scripts/lifecycle-init.sh <skill> [extra_json]" >&2
  exit 1
fi

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"
SKILL_YAML="$PROJECT_DIR/.claude/skills/$SKILL/skill.yaml"
MANIFEST="$PROJECT_DIR/.runs/$SKILL-manifest.json"

# --- Step 1: Check for skill.yaml ---
if [[ ! -f "$SKILL_YAML" ]]; then
  echo "WARN: lifecycle-init.sh — $SKILL_YAML not found, falling back to v1 (init-context.sh only)" >&2
  bash "$PROJECT_DIR/.claude/scripts/init-context.sh" "$SKILL" "$EXTRA"
  exit 0
fi

# --- Step 2: Parse YAML → manifest.json ---
mkdir -p "$PROJECT_DIR/.runs"

EXTRA_ENV="$EXTRA" python3 - "$SKILL_YAML" "$MANIFEST" << 'PYEOF'
import sys, json, os, re

yaml_path = sys.argv[1]
manifest_path = sys.argv[2]
extra_str = os.environ.get("EXTRA_ENV", "")

# --- Regex YAML fallback (defined before use) ---

def _parse_inline(value):
    """Parse an inline YAML value."""
    if value.startswith('[') and value.endswith(']'):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            # Bare-word flow sequence: [foo, bar] -> ["foo", "bar"]
            inner = value[1:-1].strip()
            if not inner:
                return []
            return [item.strip().strip('"').strip("'") for item in inner.split(',')]
    if (value.startswith('"') and value.endswith('"')) or \
       (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    if value.lower() == 'true':
        return True
    if value.lower() == 'false':
        return False
    try:
        return int(value)
    except ValueError:
        pass
    return value

def _collect_block(lines, start, parent_indent):
    """Collect lines that are indented more than parent_indent."""
    block = []
    i = start
    while i < len(lines):
        line = lines[i]
        stripped = line.rstrip()
        if not stripped or stripped.lstrip().startswith('#'):
            block.append(line)
            i += 1
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= parent_indent:
            break
        block.append(line)
        i += 1
    return block, i

def _parse_block_sequence(block_lines):
    """Parse a YAML block sequence (list of items)."""
    items = []
    current_item = {}
    for line in block_lines:
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        if s.startswith('- '):
            if current_item:
                items.append(current_item)
            current_item = {}
            rest = s[2:].strip()
            m = re.match(r'([\w-]+):\s*(.*)', rest)
            if m:
                current_item[m.group(1)] = _parse_inline(m.group(2).strip())
        else:
            m = re.match(r'\s*([\w-]+):\s*(.*)', s)
            if m:
                current_item[m.group(1)] = _parse_inline(m.group(2).strip())
    if current_item:
        items.append(current_item)
    return items

def _parse_block_map(block_lines):
    """Parse a YAML block map (dict of key: value or nested maps)."""
    result = {}
    i = 0
    while i < len(block_lines):
        line = block_lines[i]
        stripped = line.rstrip()
        if not stripped or stripped.lstrip().startswith('#'):
            i += 1
            continue
        indent = len(line) - len(line.lstrip())
        m = re.match(r'\s*([\w-]+):\s*(.*)', stripped)
        if m:
            k, v = m.group(1), m.group(2).strip()
            if v:
                result[k] = _parse_inline(v)
                i += 1
            else:
                sub_block, i = _collect_block(block_lines, i + 1, indent)
                result[k] = _parse_block(k, sub_block)
        else:
            i += 1
    return result

def _parse_block(key, block_lines):
    """Parse a block of indented YAML lines."""
    first_content = None
    for line in block_lines:
        s = line.strip()
        if s and not s.startswith('#'):
            first_content = s
            break
    if first_content and first_content.startswith('- '):
        return _parse_block_sequence(block_lines)
    return _parse_block_map(block_lines)

def _regex_parse_yaml(text):
    """Parse the constrained YAML subset used in skill.yaml files."""
    result = {}
    lines = text.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.rstrip()
        if not stripped or stripped.lstrip().startswith('#'):
            i += 1
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            m = re.match(r'^([\w-]+):\s*(.*)', stripped)
            if m:
                key, value = m.group(1), m.group(2).strip()
                if value:
                    result[key] = _parse_inline(value)
                    i += 1
                else:
                    block, i = _collect_block(lines, i + 1, 0)
                    result[key] = _parse_block(key, block)
            else:
                i += 1
        else:
            i += 1
    return result

# --- YAML parsing: try PyYAML, fallback to regex ---
try:
    import yaml
    with open(yaml_path) as f:
        data = yaml.safe_load(f)
except ImportError:
    with open(yaml_path) as f:
        text = f.read()
    data = _regex_parse_yaml(text)

# --- Step 3: Mode selection ---
if "modes" in data and extra_str:
    try:
        extra_data = json.loads(extra_str)
        mode = extra_data.get("mode")
        if mode and mode in data["modes"]:
            data["active_mode"] = mode
    except (json.JSONDecodeError, TypeError):
        pass

# Default to "default" mode when modes present but no mode specified
if "modes" in data and "active_mode" not in data and "default" in data["modes"]:
    data["active_mode"] = "default"

# --- Write manifest ---
with open(manifest_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF

# --- Step 3a: Clean stale artifacts from prior runs ---
STALE_ARTIFACTS=(
  "$PROJECT_DIR/.runs/observe-result.json"
  "$PROJECT_DIR/.runs/epilogue-context.json"
  "$PROJECT_DIR/.runs/observer-diffs.txt"
  "$PROJECT_DIR/.runs/observe-evidence-check.json"
  "$PROJECT_DIR/.runs/compliance-audit-result.json"
  "$PROJECT_DIR/.runs/q-dimensions.json"
  "$PROJECT_DIR/.runs/commit-message.txt"
  "$PROJECT_DIR/.runs/pr-body.md"
  "$PROJECT_DIR/.runs/pr-title.txt"
  "$PROJECT_DIR/.runs/delivery-skip.flag"
)
for f in "${STALE_ARTIFACTS[@]}"; do
  rm -f "$f"
done
rm -rf "$PROJECT_DIR/.runs/gate-verdicts/"

# --- Step 3b: Validate experiment.yaml (if exists) ---
EXPERIMENT_YAML="$PROJECT_DIR/experiment/experiment.yaml"
VALIDATE_SCRIPT="$PROJECT_DIR/scripts/validate-experiment.py"

SKIP_VALIDATE=""
if [[ -f "$MANIFEST" ]]; then
  SKIP_VALIDATE=$(python3 -c "import json; print(json.load(open('$MANIFEST')).get('skip_experiment_validation',''))" 2>/dev/null || echo "")
fi

if [[ -z "$SKIP_VALIDATE" && -f "$EXPERIMENT_YAML" && -f "$VALIDATE_SCRIPT" ]]; then
  VALIDATE_EXIT=0
  python3 "$VALIDATE_SCRIPT" || VALIDATE_EXIT=$?
  if [[ $VALIDATE_EXIT -eq 1 ]]; then
    echo "ERROR: experiment.yaml validation failed" >&2
    exit 1
  fi
  # exit code 0 = pass, exit code 2 = warnings only, continue
fi

# --- Step 4: Branch creation ---
BRANCH=$(python3 -c "import json; print(json.load(open('$MANIFEST')).get('branch',''))" 2>/dev/null || echo "")

if [[ -n "$BRANCH" && -z "${CLAUDE_WORKTREE:-}" ]]; then
  # Extract slug from EXTRA if present
  SLUG=""
  if [[ -n "$EXTRA" ]]; then
    SLUG=$(python3 -c "
import json
try:
    d = json.loads('''$EXTRA''')
    print(d.get('slug',''))
except: print('')
" 2>/dev/null || echo "")
  fi
  if [[ -n "$SLUG" ]]; then
    BRANCH="${BRANCH//\{slug\}/$SLUG}"
  else
    # Remove {slug} placeholder and any trailing hyphen
    BRANCH="${BRANCH//\{slug\}/}"
    BRANCH="${BRANCH%-}"
  fi
  git checkout -b "$BRANCH" 2>/dev/null || echo "WARN: lifecycle-init.sh — branch $BRANCH already exists or checkout failed" >&2
fi

# --- Step 5: Create canonical context (run_id, branch, timestamp) ---
CTX_SKILL="$SKILL"
if [[ -n "$EXTRA" ]]; then
  MODE=$(python3 -c "import json; d=json.loads('''$EXTRA'''); m=d.get('mode',''); print(m if m and m!='default' else '')" 2>/dev/null || echo "")
  [[ -n "$MODE" ]] && CTX_SKILL="${SKILL}-${MODE}"
fi
bash "$PROJECT_DIR/.claude/scripts/init-context.sh" "$CTX_SKILL"
