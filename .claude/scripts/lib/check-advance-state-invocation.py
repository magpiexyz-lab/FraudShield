#!/usr/bin/env python3
"""Detect whether a Bash command actually invokes advance-state.sh.

Used by .claude/hooks/state-completion-gate.sh and
.claude/hooks/phase-boundary-gate.sh to filter out false-positive matches
where the literal text "advance-state.sh" appears inside heredoc bodies,
single/double-quoted strings, --body / --body-file argument values, or
comments — without actually being the head of a Bash command.

Closes #1223. Wired in by both hooks via:

    if ! printf '%s' "$COMMAND" | python3 .../check-advance-state-invocation.py; then
      exit 0   # not an actual invocation
    fi
    SKILL=$(printf '%s' "$COMMAND" | python3 .../check-advance-state-invocation.py --print-skill)
    STATE_ID=$(printf '%s' "$COMMAND" | python3 .../check-advance-state-invocation.py --print-state-id)

Behavior contract
-----------------
* `__main__` reads the full command from stdin.
* Default mode (no flag): exit 0 when the command DOES invoke
  advance-state.sh at a command-head position, exit 1 otherwise. This
  matches the existing `grep -qE` semantics (exit 0 means "fire").
* `--print-skill` / `--print-state-id`: print the parsed skill / state_id
  argument to stdout (empty if not detectable). Exit 0 always.
* On parse exceptions (malformed shlex, etc.) the helper FAILS OPEN —
  returns the same status as "not an invocation" — so callers do NOT
  silently change a previously-allowing path into a blocking one.

Heredoc handling
----------------
Heredoc bodies are scanned line-by-line and stripped before tokenization,
so `gh issue create --body "$(cat <<EOF ... advance-state.sh ... EOF)"`
no longer matches. The scan supports:
  * `<<DELIM` and `<<-DELIM` (tab-strip variant)
  * Quoted delimiters (`<<'EOF'`, `<<"EOF"`)
  * Custom delimiter names (`PYEOF`, `SCRIPTEND`, etc.)
  * Multiple heredocs in a single command (loop until stable)

Quoted-string handling
----------------------
After heredoc stripping, shlex.split (POSIX mode) is used to tokenize.
shlex correctly preserves single/double-quoted regions as a single token,
so `--body "...advance-state.sh..."` becomes one token whose VALUE contains
the script name but whose token POSITION is not a command head — the
walker below skips it.

Command-head detection
----------------------
A token is at command-head position if it is at index 0 OR the previous
token is one of the segment separators: && || ; | & ( ).
"""
from __future__ import annotations

import os
import re
import shlex
import sys


_SEGMENT_SEPARATORS = {"&&", "||", ";", "|", "&", "(", ")"}
_HEREDOC_START = re.compile(
    r"<<(-)?\s*(?P<quote>['\"]?)(?P<delim>[A-Za-z_][A-Za-z0-9_]*)(?P=quote)"
)


def strip_heredoc_bodies(cmd: str) -> str:
    """Remove heredoc bodies. Preserves the heredoc-introducer line.

    Iterates until no more heredocs can be stripped (handles nested forms in
    sequence). Each removal replaces the body with a sentinel line so that
    line-numbering changes are visible in failure messages.
    """
    while True:
        m = _HEREDOC_START.search(cmd)
        if not m:
            return cmd

        delim = m.group("delim")
        strip_indent = bool(m.group(1))  # `<<-` permits leading tabs

        # Find the start of the line CONTAINING the introducer; the body
        # begins on the line AFTER that.
        intro_line_end = cmd.find("\n", m.end())
        if intro_line_end == -1:
            # No newline after the introducer — heredoc body is empty (no
            # body lines to consume). Treat as already-stripped to make
            # progress and break the loop.
            return cmd[: m.end()] + cmd[m.end():]

        body_start = intro_line_end + 1

        # Walk lines looking for the closing delimiter on its own line.
        idx = body_start
        end_of_close = None
        while idx < len(cmd):
            line_end = cmd.find("\n", idx)
            if line_end == -1:
                line = cmd[idx:]
                next_idx = len(cmd)
            else:
                line = cmd[idx:line_end]
                next_idx = line_end + 1
            stripped = line.lstrip("\t") if strip_indent else line
            if stripped.strip() == delim:
                end_of_close = next_idx
                break
            idx = next_idx

        if end_of_close is None:
            # Unterminated heredoc — strip to end-of-string and stop.
            return cmd[:body_start] + "\n"

        cmd = cmd[:body_start] + cmd[end_of_close:]
        # Loop again to strip any remaining heredocs.


def parse_invocation(cmd: str) -> tuple[bool, str, str]:
    """Return (is_invocation, skill, state_id).

    Fails open on malformed input — returns (False, "", "").
    """
    try:
        cleaned = strip_heredoc_bodies(cmd)
    except Exception:
        return False, "", ""

    try:
        tokens = shlex.split(cleaned, posix=True, comments=False)
    except ValueError:
        # Unbalanced quotes — fail open.
        return False, "", ""

    n = len(tokens)
    for i, tok in enumerate(tokens):
        is_head = (i == 0) or (i > 0 and tokens[i - 1] in _SEGMENT_SEPARATORS)
        if not is_head:
            continue

        # Direct invocation: <path>/advance-state.sh <skill> <state_id>
        if tok.endswith("advance-state.sh") and tok != "advance-state.sh" or (
            tok == "advance-state.sh" and (i == 0 or tokens[i - 1] in _SEGMENT_SEPARATORS)
        ) or (
            "/" in tok and os.path.basename(tok) == "advance-state.sh"
        ):
            skill = tokens[i + 1] if i + 1 < n else ""
            state_id = tokens[i + 2] if i + 2 < n else ""
            return True, skill, state_id

        # Indirect invocation: bash <path>/advance-state.sh <skill> <state_id>
        if tok == "bash" and i + 1 < n:
            next_tok = tokens[i + 1]
            if next_tok.endswith("advance-state.sh"):
                skill = tokens[i + 2] if i + 2 < n else ""
                state_id = tokens[i + 3] if i + 3 < n else ""
                return True, skill, state_id

    return False, "", ""


def main() -> int:
    args = sys.argv[1:]
    cmd = sys.stdin.read()
    is_invocation, skill, state_id = parse_invocation(cmd)

    if not args:
        # Default mode: exit 0 when the command IS an invocation, else 1.
        return 0 if is_invocation else 1

    if "--print-skill" in args:
        sys.stdout.write(skill or "")
        return 0
    if "--print-state-id" in args:
        sys.stdout.write(state_id or "")
        return 0

    # Unknown flag — fail open.
    return 1


if __name__ == "__main__":
    sys.exit(main())
