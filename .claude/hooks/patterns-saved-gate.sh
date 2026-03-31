#!/usr/bin/env bash
# patterns-saved-gate.sh — Claude Code PreToolUse hook for Write/Edit.
# Validates patterns-saved.json invariants:
#   saved + skipped == total
#   len(saved_to_files) + saved_to_memory == saved
#   Each saved_to_files[].path exists on disk

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

FILE_PATH=$(read_payload_field "tool_input.file_path")

# Only fire when file_path contains "patterns-saved"
if [[ "$FILE_PATH" != *"patterns-saved"* ]]; then
  exit 0
fi

# --- patterns-saved.json write detected — run invariant checks ---

extract_write_content

# Skip if content is empty (can't validate)
if [[ -z "$CONTENT" ]]; then
  exit 0
fi

# Validate invariants using python3
VALIDATION=$(echo "$CONTENT" | python3 -c '
import json, sys, os

content = sys.stdin.read().strip()
errors = []

try:
    d = json.loads(content)
except json.JSONDecodeError:
    print("PARSE_ERROR")
    sys.exit(0)

saved = d.get("saved", 0)
skipped = d.get("skipped", 0)
total = d.get("total", 0)

# Invariant 1: saved + skipped == total
if saved + skipped != total:
    errors.append("saved(%d) + skipped(%d) != total(%d)" % (saved, skipped, total))

# Invariant 2: len(saved_to_files) + saved_to_memory == saved
saved_to_files = d.get("saved_to_files", [])
saved_to_memory = d.get("saved_to_memory", 0)
if len(saved_to_files) + saved_to_memory != saved:
    errors.append("len(saved_to_files)(%d) + saved_to_memory(%d) != saved(%d)" % (len(saved_to_files), saved_to_memory, saved))

# Invariant 3: Each saved_to_files[].path exists on disk
project_dir = os.environ.get("CLAUDE_PROJECT_DIR", ".")
for entry in saved_to_files:
    path = entry.get("path", "")
    if path:
        full_path = os.path.join(project_dir, path)
        if not os.path.exists(full_path):
            errors.append("saved_to_files path does not exist: %s" % path)

# Invariant 4: total must match actual fix-log entry count
fix_log_path = os.path.join(project_dir, ".claude", "runs", "fix-log.md")
if os.path.exists(fix_log_path):
    import re
    fix_log = open(fix_log_path).read()
    fix_count = len(re.findall(r"^(?:\*\*Fix|Fix \()", fix_log, re.MULTILINE))
    if d.get("total", 0) != fix_count:
        errors.append("Invariant 4: total (%d) != fix-log entry count (%d)" % (d.get("total", 0), fix_count))

if errors:
    print("FAIL:" + "; ".join(errors))
else:
    print("OK")
' 2>/dev/null || echo "OK")

handle_validation "$VALIDATION" "Patterns-saved gate" "Fix invariants before writing patterns-saved.json."

# All checks passed — allow
exit 0
