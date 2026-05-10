#!/usr/bin/env bash
# Synthetic test fixture for hook_silent_skip_friction_pairing rule.
# This hook contains an unfrictioned, un-pragma'd `exit 0` that the rule
# must flag.
set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

FILE_PATH=$(read_payload_field "tool_input.file_path")
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# This is the violation: a bare `exit 0` with no preceding friction call
# within the lookback window AND no `# friction-skip:` pragma on this or
# the directly preceding line.
exit 0
