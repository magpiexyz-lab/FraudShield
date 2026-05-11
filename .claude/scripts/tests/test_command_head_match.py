#!/usr/bin/env python3
"""test_command_head_match.py — regression for issue #1366 + sibling sweep.

`verify-pr-gate.sh:13`, `observe-commit-gate.sh:17`, and `skill-commit-gate.sh:19`
previously used bare substring matches (`*"gh pr create"*`, `*"git commit"*`)
to detect command invocations in `tool_input.command`. These false-fired on
grep patterns, heredoc prose, JSON literals, single/double-quoted strings,
and env-var assignments containing the literal substring.

The fix replaces each substring with a command-head regex anchored at start
of $COMMAND or after a shell separator (;, &, |), with whitespace-tolerant
boundaries:

    (^|[;\\&\\|])[[:space:]]*<head>([[:space:]]|$)

This test is Layer-1: it isolates the regex semantics from hook side-effects
(which depend on .runs/ evidence and branch state) by driving the regex
through a small bash `-c` shim. The regex strings are duplicated from the
hooks; drift would surface as a test failure here AND in V1's full-suite run.
"""
from __future__ import annotations

import subprocess
import unittest


GH_PR_CREATE_RE = r'(^|[;\&\|])[[:space:]]*gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'
GIT_COMMIT_RE   = r'(^|[;\&\|])[[:space:]]*git[[:space:]]+commit([[:space:]]|$)'


def regex_matches(regex: str, command: str) -> bool:
    """Run the regex against $command in bash; True iff matches."""
    proc = subprocess.run(
        [
            "bash", "-c",
            f'COMMAND="$1"; if [[ "$COMMAND" =~ {regex} ]]; then echo MATCH; else echo NOMATCH; fi',
            "_", command,
        ],
        capture_output=True, text=True, timeout=5,
    )
    return proc.stdout.strip() == "MATCH"


class TestGhPrCreateRegex(unittest.TestCase):
    """Regex contract for verify-pr-gate.sh:13 (#1366)."""

    def _match(self, command: str) -> bool:
        return regex_matches(GH_PR_CREATE_RE, command)

    # --- TRUE positives (must trigger the hook) ---
    def test_bare_command_matches(self):
        self.assertTrue(self._match("gh pr create"))

    def test_with_flags_matches(self):
        self.assertTrue(self._match("gh pr create --title foo"))

    def test_after_and_separator_matches(self):
        self.assertTrue(self._match("cd /tmp && gh pr create"))

    def test_after_semicolon_separator_matches(self):
        self.assertTrue(self._match("echo a; gh pr create"))

    def test_multiple_spaces_matches(self):
        self.assertTrue(self._match("gh   pr   create"))

    # --- FALSE positives (must NOT trigger after the fix) ---
    def test_grep_pattern_does_not_match(self):
        self.assertFalse(self._match('grep "gh pr create" file.txt'))

    def test_single_quoted_does_not_match(self):
        self.assertFalse(self._match("echo 'gh pr create'"))

    def test_env_var_assignment_does_not_match(self):
        self.assertFalse(self._match("GH_PR_CREATE=1 ./script"))

    def test_create_fork_subcommand_does_not_match(self):
        self.assertFalse(self._match("gh pr create-fork"))


class TestGitCommitRegex(unittest.TestCase):
    """Regex contract shared by observe-commit-gate.sh:17 and skill-commit-gate.sh:19 (#1366 sibling sweep)."""

    def _match(self, command: str) -> bool:
        return regex_matches(GIT_COMMIT_RE, command)

    # --- TRUE positives ---
    def test_bare_command_matches(self):
        self.assertTrue(self._match("git commit"))

    def test_with_message_flag_matches(self):
        self.assertTrue(self._match('git commit -m "msg"'))

    def test_after_and_separator_matches(self):
        self.assertTrue(self._match("cd /tmp && git commit -am foo"))

    def test_after_semicolon_separator_matches(self):
        self.assertTrue(self._match("git status; git commit"))

    def test_amend_subcommand_matches(self):
        self.assertTrue(self._match("git commit --amend"))

    # --- FALSE positives ---
    def test_grep_pattern_does_not_match(self):
        self.assertFalse(self._match('grep "git commit" history.log'))

    def test_double_quoted_does_not_match(self):
        self.assertFalse(self._match('echo "git commit"'))

    def test_committed_word_does_not_match(self):
        self.assertFalse(self._match("git committed"))

    def test_commit_tree_plumbing_does_not_match(self):
        self.assertFalse(self._match("git commit-tree"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
