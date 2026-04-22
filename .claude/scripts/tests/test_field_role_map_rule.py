#!/usr/bin/env python3
"""Behavioral tests for verify-linter.sh check_field_role_map().

Validates that the cross-file coherence rule catches the regressions it's
designed for (#1024 prevention class) and doesn't false-positive.

Tests construct a temporary repo skeleton with:
  - .claude/scripts/verify-linter.sh (symlink or copy from real one)
  - .claude/patterns/state-registry.json (minimal valid)
  - .claude/patterns/template-coherence-rules.json (configurable per test)
  - .claude/scripts/lib/derive_pages.py (real one)
  - test consumer files (varied per test)

Then runs verify-linter and asserts CROSS_FILE_CONTRADICTION findings match
expectations.

Run via: python3 .claude/scripts/tests/test_field_role_map_rule.py
Or via:  bash .claude/scripts/tests/run-all.sh
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest


REAL_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
LINTER = os.path.join(REAL_REPO, ".claude", "scripts", "verify-linter.sh")


def _setup_minimal_repo(tmpdir: str, rules: dict, consumers: dict[str, str]):
    """Create a minimal repo skeleton for the linter to scan.

    rules: dict to write as template-coherence-rules.json
    consumers: dict of {relative_path: content} for files in the rule
    """
    # Mirror the linter and lib into tmpdir so it has the same path layout
    os.makedirs(os.path.join(tmpdir, ".claude/scripts/lib"), exist_ok=True)
    os.makedirs(os.path.join(tmpdir, ".claude/patterns"), exist_ok=True)
    os.makedirs(os.path.join(tmpdir, ".claude/skills"), exist_ok=True)

    # Copy the real linter script (it computes REPO_ROOT from its own location)
    shutil.copy(LINTER, os.path.join(tmpdir, ".claude/scripts/verify-linter.sh"))
    # Empty registry (no skills) — lint won't find any state files; that's fine
    with open(os.path.join(tmpdir, ".claude/patterns/state-registry.json"), "w") as f:
        json.dump({}, f)
    # Rules file
    with open(os.path.join(tmpdir, ".claude/patterns/template-coherence-rules.json"), "w") as f:
        json.dump(rules, f)
    # Consumer files
    for rel_path, content in consumers.items():
        full = os.path.join(tmpdir, rel_path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(content)


def _run_linter(tmpdir: str) -> tuple[int, str]:
    """Run linter in tmpdir; return (exit_code, stdout)."""
    result = subprocess.run(
        ["bash", os.path.join(tmpdir, ".claude/scripts/verify-linter.sh")],
        capture_output=True,
        text=True,
        cwd=tmpdir,
    )
    return result.returncode, result.stdout


class TestFieldRoleMapRule(unittest.TestCase):
    """Validate check_field_role_map() catches drift and accepts compliant code."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_consumer_with_canonical_function_passes(self):
        """Consumer that calls derive_scope_pages() has no findings."""
        rules = {"rules": [{
            "id": "test-rule",
            "type": "field_role_map",
            "field": "golden_path",
            "canonical_function": "derive_scope_pages",
            "consumers": [".claude/agents/test-consumer.md"],
        }]}
        consumers = {
            ".claude/agents/test-consumer.md": "# Test\n\nCall `derive_scope_pages(experiment)` to get pages.\n"
        }
        _setup_minimal_repo(self.tmpdir, rules, consumers)
        rc, out = _run_linter(self.tmpdir)
        self.assertEqual(rc, 0, f"linter should pass, got: {out}")
        self.assertNotIn("CROSS_FILE_CONTRADICTION", out)

    def test_consumer_with_pragma_passes(self):
        """Consumer with coherence-allow pragma is accepted."""
        rules = {"rules": [{
            "id": "test-rule",
            "type": "field_role_map",
            "field": "golden_path",
            "canonical_function": "derive_scope_pages",
            "consumers": [".claude/agents/test-consumer.md"],
        }]}
        consumers = {
            ".claude/agents/test-consumer.md": (
                "<!-- coherence-allow: raw-golden_path (sequence-step) -->\n"
                "# Test\n\nIterate over golden_path in order.\n"
            )
        }
        _setup_minimal_repo(self.tmpdir, rules, consumers)
        rc, out = _run_linter(self.tmpdir)
        self.assertEqual(rc, 0, f"linter should pass, got: {out}")

    def test_consumer_without_canonical_or_pragma_fails(self):
        """Consumer that mentions neither canonical nor pragma triggers finding."""
        rules = {"rules": [{
            "id": "test-rule",
            "type": "field_role_map",
            "field": "golden_path",
            "canonical_function": "derive_scope_pages",
            "consumers": [".claude/agents/test-consumer.md"],
        }]}
        consumers = {
            ".claude/agents/test-consumer.md": "# Test\n\nReads golden_path[0] from experiment.yaml.\n"
        }
        _setup_minimal_repo(self.tmpdir, rules, consumers)
        rc, out = _run_linter(self.tmpdir)
        self.assertNotEqual(rc, 0, "linter should fail (missing canonical and pragma)")
        self.assertIn("CROSS_FILE_CONTRADICTION", out)
        self.assertIn("test-consumer.md", out)

    def test_forbidden_len_pattern_fails_even_with_pragma(self):
        """len(golden_path) is forbidden UNCONDITIONALLY — pragma cannot whitelist it.

        This is the #1024 prevention guarantee: count-based access defeats
        the centralization purpose, so it's blocked regardless of pragma.
        """
        rules = {"rules": [{
            "id": "test-rule",
            "type": "field_role_map",
            "field": "golden_path",
            "canonical_function": "derive_scope_pages",
            "consumers": [".claude/agents/test-consumer.md"],
        }]}
        consumers = {
            ".claude/agents/test-consumer.md": (
                "<!-- coherence-allow: raw-golden_path (sequence-step) -->\n"
                "# Test\n\n"
                "Also calls derive_scope_pages(experiment) for some things.\n"
                "Then: count = len(golden_path)\n"  # Forbidden!
            )
        }
        _setup_minimal_repo(self.tmpdir, rules, consumers)
        rc, out = _run_linter(self.tmpdir)
        self.assertNotEqual(rc, 0, "linter should fail on len(golden_path)")
        self.assertIn("forbidden count-based access", out)
        self.assertIn("len(golden_path", out)

    def test_forbidden_set_pattern_fails(self):
        """set(golden_path) is also forbidden unconditionally."""
        rules = {"rules": [{
            "id": "test-rule",
            "type": "field_role_map",
            "field": "golden_path",
            "canonical_function": "derive_scope_pages",
            "consumers": [".claude/agents/test-consumer.md"],
        }]}
        consumers = {
            ".claude/agents/test-consumer.md": (
                "# Test\n\n"
                "Has derive_scope_pages mention.\n"
                "But also: pages = set(golden_path)\n"
            )
        }
        _setup_minimal_repo(self.tmpdir, rules, consumers)
        rc, out = _run_linter(self.tmpdir)
        self.assertNotEqual(rc, 0, "linter should fail on set(golden_path)")
        self.assertIn("forbidden count-based access", out)

    def test_missing_consumer_file_fails(self):
        """Consumer listed in rule but not present on disk → finding."""
        rules = {"rules": [{
            "id": "test-rule",
            "type": "field_role_map",
            "field": "golden_path",
            "canonical_function": "derive_scope_pages",
            "consumers": [".claude/nonexistent/missing-file.md"],
        }]}
        _setup_minimal_repo(self.tmpdir, rules, consumers={})
        rc, out = _run_linter(self.tmpdir)
        self.assertNotEqual(rc, 0)
        self.assertIn("not found on disk", out)

    def test_warn_only_flag_returns_zero_even_with_findings(self):
        """--warn-only suppresses non-zero exit code."""
        rules = {"rules": [{
            "id": "test-rule",
            "type": "field_role_map",
            "field": "golden_path",
            "canonical_function": "derive_scope_pages",
            "consumers": [".claude/agents/test-consumer.md"],
        }]}
        consumers = {
            ".claude/agents/test-consumer.md": "# Test\n\nReads golden_path raw.\n"
        }
        _setup_minimal_repo(self.tmpdir, rules, consumers)
        result = subprocess.run(
            ["bash", os.path.join(self.tmpdir, ".claude/scripts/verify-linter.sh"), "--warn-only"],
            capture_output=True,
            text=True,
            cwd=self.tmpdir,
        )
        self.assertEqual(result.returncode, 0, "--warn-only should exit 0")
        self.assertIn("CROSS_FILE_CONTRADICTION", result.stdout)

    def test_json_flag_emits_valid_json(self):
        """--json produces parseable JSON with summary counts."""
        rules = {"rules": []}
        _setup_minimal_repo(self.tmpdir, rules, consumers={})
        result = subprocess.run(
            ["bash", os.path.join(self.tmpdir, ".claude/scripts/verify-linter.sh"), "--json"],
            capture_output=True,
            text=True,
            cwd=self.tmpdir,
        )
        self.assertEqual(result.returncode, 0)
        data = json.loads(result.stdout)
        self.assertIn("summary", data)
        self.assertIn("cross_file_contradiction", data["summary"])
        self.assertEqual(data["summary"]["cross_file_contradiction"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
