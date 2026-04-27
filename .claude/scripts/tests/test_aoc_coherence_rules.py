#!/usr/bin/env python3
"""Behavioral tests for AOC v1 coherence rules R1/R2/R3.

Validates that verify-linter.sh dispatches correctly to the three new rule
types introduced by agent-output-contract.md:

- R1 verdict_vocab_consistency — catches agent files that emit verdicts
  outside the registry's allowed_verdicts for that agent, and
  evaluate-hard-gate-predicates.py predicates that reference non-registry
  verdict literals.
- R2 ledger_ownership — catches writes to gated paths (.runs/fix-ledger.jsonl,
  .runs/fix-log.md) from files outside the allowed_writers list.
- R3 consumer_coverage — catches consumer files that do not reference the
  canonical source (.runs/fix-ledger.jsonl).

Also verifies the --strict-aoc CLI flag makes these rules blocking even
when --warn-only is set.

Run via: python3 .claude/scripts/tests/test_aoc_coherence_rules.py
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
LIB_DIR = os.path.join(REAL_REPO, ".claude", "scripts", "lib")


def _setup_repo(tmpdir, rules, files):
    """Create a minimal repo skeleton scanned by verify-linter.sh.

    rules: dict written as template-coherence-rules.json
    files: {relpath: content} to write before the linter runs
    """
    os.makedirs(os.path.join(tmpdir, ".claude/scripts"), exist_ok=True)
    os.makedirs(os.path.join(tmpdir, ".claude/patterns"), exist_ok=True)
    shutil.copy(LINTER, os.path.join(tmpdir, ".claude/scripts/verify-linter.sh"))
    # Copy lib/ alongside the linter so the upcoming Python-package refactor
    # (which puts business logic under .claude/scripts/lib/linter/) doesn't
    # break this fixture. Idempotent today: linter is still self-contained.
    if os.path.isdir(LIB_DIR):
        shutil.copytree(
            LIB_DIR,
            os.path.join(tmpdir, ".claude/scripts/lib"),
            dirs_exist_ok=True,
        )
    with open(os.path.join(tmpdir, ".claude/patterns/state-registry.json"), "w") as f:
        json.dump({}, f)
    with open(os.path.join(tmpdir, ".claude/patterns/template-coherence-rules.json"), "w") as f:
        json.dump(rules, f)
    for rel, content in files.items():
        full = os.path.join(tmpdir, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as fh:
            fh.write(content)


def _run_linter(tmpdir, *extra_args):
    result = subprocess.run(
        ["bash", os.path.join(tmpdir, ".claude/scripts/verify-linter.sh"), *extra_args],
        capture_output=True,
        text=True,
        cwd=tmpdir,
    )
    return result.returncode, result.stdout, result.stderr


# --- Fixtures --------------------------------------------------------------

MINIMAL_REGISTRY = {
    "verdict_agents_schema": {
        "demo-agent": {
            "allowed_verdicts": ["pass", "fail"],
            "allowed_results": ["clean", "fixed"],
        }
    }
}


MINIMAL_PREDICATES = """\
#!/usr/bin/env python3
# Stub predicate file — refs only registry verdicts.
# t.get('verdict') == 'pass'
# t.get('verdict') in ('pass', 'fail')
"""


# --- R1 verdict_vocab_consistency ------------------------------------------


class TestR1VerdictVocab(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _base_rule(self):
        return {
            "rules": [{
                "id": "aoc-verdict-vocab-consistency",
                "type": "verdict_vocab_consistency",
                "severity": "block",
                "registry_path": ".claude/patterns/agent-registry.json",
                "agent_files_glob": ".claude/agents/*.md",
                "predicate_file": ".claude/scripts/evaluate-hard-gate-predicates.py",
            }]
        }

    def test_compliant_agent_passes(self):
        """Agent emitting registry-declared verdict has no findings."""
        files = {
            ".claude/patterns/agent-registry.json": json.dumps(MINIMAL_REGISTRY),
            ".claude/scripts/evaluate-hard-gate-predicates.py": MINIMAL_PREDICATES,
            ".claude/agents/demo-agent.md": (
                "# Demo Agent\n\n"
                '`"verdict": "pass"` is valid.\n'
                '`"verdict": "fail"` also valid.\n'
            ),
        }
        _setup_repo(self.tmpdir, self._base_rule(), files)
        rc, out, _ = _run_linter(self.tmpdir, "--strict-aoc")
        self.assertEqual(rc, 0, f"expected clean, got:\n{out}")

    def test_pre_aoc_legacy_verdict_is_blocked(self):
        """Agent emitting pre-AOC legacy verdict (e.g. 'all fixed') triggers R1."""
        files = {
            ".claude/patterns/agent-registry.json": json.dumps(MINIMAL_REGISTRY),
            ".claude/scripts/evaluate-hard-gate-predicates.py": MINIMAL_PREDICATES,
            ".claude/agents/demo-agent.md": (
                "# Demo Agent\n\n"
                '`"verdict": "all fixed"` is the legacy drift we want to catch.\n'
            ),
        }
        _setup_repo(self.tmpdir, self._base_rule(), files)
        rc, out, _ = _run_linter(self.tmpdir, "--strict-aoc")
        self.assertEqual(rc, 1, f"expected blocking, got clean:\n{out}")
        self.assertIn("aoc-verdict-vocab-consistency", out)
        self.assertIn("all fixed", out)

    def test_predicate_references_non_registry_verdict_is_blocked(self):
        """evaluate-hard-gate-predicates.py referencing a verdict literal not in registry triggers R1."""
        files = {
            ".claude/patterns/agent-registry.json": json.dumps(MINIMAL_REGISTRY),
            ".claude/scripts/evaluate-hard-gate-predicates.py": (
                '#!/usr/bin/env python3\n'
                "# Stub\n"
                "# t.get('verdict') == 'weirdo'\n"
            ),
            ".claude/agents/demo-agent.md": '# Demo\n',
        }
        _setup_repo(self.tmpdir, self._base_rule(), files)
        rc, out, _ = _run_linter(self.tmpdir, "--strict-aoc")
        self.assertEqual(rc, 1, f"expected blocking, got:\n{out}")
        self.assertIn("weirdo", out)


# --- R2 ledger_ownership ---------------------------------------------------


class TestR2LedgerOwnership(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _base_rule(self):
        return {
            "rules": [{
                "id": "aoc-fix-ledger-ownership",
                "type": "ledger_ownership",
                "severity": "block",
                "allowed_writers": [
                    ".claude/scripts/write-fix-ledger.py",
                    ".claude/scripts/render-fix-log.py",
                ],
                "gated_paths": [
                    ".runs/fix-ledger.jsonl",
                    ".runs/fix-log.md",
                ],
            }]
        }

    def test_no_writes_passes(self):
        """Template files that only READ gated paths (cat/json.load) pass."""
        files = {
            ".claude/agents/reader.md": (
                "# Reader\n\n"
                "Run `wc -l .runs/fix-ledger.jsonl` to count fixes.\n"
                "Read `.runs/fix-log.md` for human-readable summary.\n"
            ),
            ".claude/scripts/write-fix-ledger.py": "#!/usr/bin/env python3\nopen('.runs/fix-ledger.jsonl', 'w')\n",
            ".claude/scripts/render-fix-log.py": "#!/usr/bin/env python3\nopen('.runs/fix-log.md', 'w')\n",
        }
        _setup_repo(self.tmpdir, self._base_rule(), files)
        rc, out, _ = _run_linter(self.tmpdir, "--strict-aoc")
        self.assertEqual(rc, 0, f"expected clean, got:\n{out}")

    def test_unauthorized_shell_write_is_blocked(self):
        """Unauthorized `echo >> .runs/fix-log.md` triggers R2."""
        files = {
            ".claude/agents/bad-writer.md": (
                "# Bad\n\n"
                "```bash\n"
                "echo 'Fix (bad): test.ts — manual' >> .runs/fix-log.md\n"
                "```\n"
            ),
            ".claude/scripts/write-fix-ledger.py": "#!/usr/bin/env python3\n",
            ".claude/scripts/render-fix-log.py": "#!/usr/bin/env python3\n",
        }
        _setup_repo(self.tmpdir, self._base_rule(), files)
        rc, out, _ = _run_linter(self.tmpdir, "--strict-aoc")
        self.assertEqual(rc, 1, f"expected blocking, got:\n{out}")
        self.assertIn("aoc-fix-ledger-ownership", out)
        self.assertIn("bad-writer.md", out)

    def test_unauthorized_python_write_is_blocked(self):
        """Unauthorized `open('.runs/fix-ledger.jsonl', 'a')` triggers R2."""
        files = {
            ".claude/scripts/bad-writer.py": (
                "open('.runs/fix-ledger.jsonl', 'a').write('spoof\\n')\n"
            ),
            ".claude/scripts/write-fix-ledger.py": "#!/usr/bin/env python3\n",
            ".claude/scripts/render-fix-log.py": "#!/usr/bin/env python3\n",
        }
        _setup_repo(self.tmpdir, self._base_rule(), files)
        rc, out, _ = _run_linter(self.tmpdir, "--strict-aoc")
        self.assertEqual(rc, 1, f"expected blocking, got:\n{out}")
        self.assertIn("bad-writer.py", out)


# --- R3 consumer_coverage --------------------------------------------------


class TestR3ConsumerCoverage(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _base_rule(self):
        return {
            "rules": [{
                "id": "aoc-consumer-coverage",
                "type": "consumer_coverage",
                "severity": "block",
                "canonical_source": ".runs/fix-ledger.jsonl",
                "consumers": [".claude/hooks/demo-consumer.sh"],
            }]
        }

    def test_consumer_referencing_ledger_passes(self):
        files = {
            ".claude/hooks/demo-consumer.sh": (
                "#!/usr/bin/env bash\n"
                "wc -l .runs/fix-ledger.jsonl\n"
            )
        }
        _setup_repo(self.tmpdir, self._base_rule(), files)
        rc, out, _ = _run_linter(self.tmpdir, "--strict-aoc")
        self.assertEqual(rc, 0, f"expected clean, got:\n{out}")

    def test_consumer_missing_ledger_reference_is_blocked(self):
        files = {
            ".claude/hooks/demo-consumer.sh": (
                "#!/usr/bin/env bash\n"
                "# Reads only the prose fix-log.md; ledger reference absent.\n"
                "cat .runs/fix-log.md | wc -l\n"
            )
        }
        _setup_repo(self.tmpdir, self._base_rule(), files)
        rc, out, _ = _run_linter(self.tmpdir, "--strict-aoc")
        self.assertEqual(rc, 1, f"expected blocking, got:\n{out}")
        self.assertIn("aoc-consumer-coverage", out)


# --- Flag matrix: --strict-aoc x --warn-only ------------------------------


class TestStrictAocFlagMatrix(unittest.TestCase):
    """--strict-aoc must override --warn-only for AOC rule-type findings."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _setup_with_violation(self):
        rules = {"rules": [{
            "id": "aoc-fix-ledger-ownership",
            "type": "ledger_ownership",
            "severity": "block",
            "allowed_writers": [".claude/scripts/write-fix-ledger.py"],
            "gated_paths": [".runs/fix-ledger.jsonl"],
        }]}
        files = {
            ".claude/scripts/write-fix-ledger.py": "#!/usr/bin/env python3\n",
            ".claude/agents/bad.md": "```bash\necho x >> .runs/fix-ledger.jsonl\n```\n",
        }
        _setup_repo(self.tmpdir, rules, files)

    def test_no_flags_blocks(self):
        self._setup_with_violation()
        rc, _, _ = _run_linter(self.tmpdir)
        self.assertEqual(rc, 1)

    def test_warn_only_alone_does_not_block(self):
        self._setup_with_violation()
        rc, _, _ = _run_linter(self.tmpdir, "--warn-only")
        self.assertEqual(rc, 0)

    def test_warn_only_plus_strict_aoc_blocks(self):
        """--strict-aoc overrides --warn-only for R2."""
        self._setup_with_violation()
        rc, out, _ = _run_linter(self.tmpdir, "--warn-only", "--strict-aoc")
        self.assertEqual(rc, 1, f"expected blocking, got:\n{out}")

    def test_strict_aoc_alone_blocks(self):
        self._setup_with_violation()
        rc, _, _ = _run_linter(self.tmpdir, "--strict-aoc")
        self.assertEqual(rc, 1)


# --- write-fix-ledger.py dedup (Gap 1 fix) --------------------------------


class TestWriteFixLedgerDedup(unittest.TestCase):
    """Verifies the AOC v1 FLS v1 consolidator does NOT double-count lead-merge
    aggregate fixes. design-critic writes per-page sub-traces (design-critic-
    landing.json, design-critic-pricing.json) whose fixes are concatenated
    into the merged design-critic.json by merge-design-critic-traces.py.
    Without dedup, the ledger would have 2 rows per fix."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.traces = os.path.join(self.tmpdir, ".runs", "agent-traces")
        os.makedirs(self.traces, exist_ok=True)
        # Mirror the registry (only lead_merge_aggregate_agents is read).
        os.makedirs(os.path.join(self.tmpdir, ".claude", "patterns"), exist_ok=True)
        with open(os.path.join(self.tmpdir, ".claude/patterns/agent-registry.json"), "w") as f:
            json.dump({
                "lead_merge_aggregate_agents": [
                    "design-critic", "scaffold-pages", "scaffold-images",
                    "implementer", "visual-implementer"
                ]
            }, f)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_trace(self, name, fixes):
        path = os.path.join(self.traces, f"{name}.json")
        trace = {
            "agent": name.split("-")[0] + "-" + name.split("-")[1] if "-" in name else name,
            "run_id": "t1",
            "timestamp": "2026-04-23T12:00:00Z",
            "fixes": fixes,
        }
        # Override: for design-critic and sub-traces, the trace's `agent` field
        # is always the base name (not per-page).
        trace["agent"] = "design-critic"
        with open(path, "w") as f:
            json.dump(trace, f)

    def _run_consolidator(self):
        result = subprocess.run(
            ["python3", os.path.join(REAL_REPO, ".claude/scripts/write-fix-ledger.py"),
             "--run-id", "t1"],
            capture_output=True, text=True, cwd=self.tmpdir
        )
        return result.returncode, result.stdout, result.stderr

    def _ledger_rows(self):
        ledger = os.path.join(self.tmpdir, ".runs/fix-ledger.jsonl")
        if not os.path.isfile(ledger):
            return []
        return [json.loads(l) for l in open(ledger) if l.strip()]

    def test_submerged_traces_skipped_when_aggregate_present(self):
        """5 per-page fixes + aggregate of 5 → 5 ledger rows (not 10)."""
        self._write_trace("design-critic-landing", [
            {"file": "hero.tsx", "symptom": "low contrast", "fix": "bg-slate-900"},
            {"file": "cta.tsx", "symptom": "weak CTA", "fix": "larger button"},
        ])
        self._write_trace("design-critic-pricing", [
            {"file": "tier.tsx", "symptom": "cramped", "fix": "added padding"},
            {"file": "table.tsx", "symptom": "alignment", "fix": "right-aligned prices"},
            {"file": "faq.tsx", "symptom": "spacing", "fix": "increased margin"},
        ])
        # Merged aggregate concatenates all 5 fixes.
        self._write_trace("design-critic", [
            {"file": "hero.tsx", "symptom": "low contrast", "fix": "bg-slate-900"},
            {"file": "cta.tsx", "symptom": "weak CTA", "fix": "larger button"},
            {"file": "tier.tsx", "symptom": "cramped", "fix": "added padding"},
            {"file": "table.tsx", "symptom": "alignment", "fix": "right-aligned prices"},
            {"file": "faq.tsx", "symptom": "spacing", "fix": "increased margin"},
        ])
        rc, out, err = self._run_consolidator()
        self.assertEqual(rc, 0, f"consolidator failed: {err}")
        rows = self._ledger_rows()
        self.assertEqual(len(rows), 5, f"expected 5 (aggregate only), got {len(rows)}: "
                         f"ledger double-counted sub-trace fixes")
        # Every row should have batch_id == "design-critic" (the aggregate).
        for r in rows:
            self.assertEqual(r["batch_id"], "design-critic",
                             f"row should originate from aggregate: {r}")

    def test_sub_traces_emit_rows_when_aggregate_absent(self):
        """If only sub-traces exist (no merge yet), sub-trace rows are included.
        This prevents a failed merge step from silently dropping all fixes."""
        self._write_trace("design-critic-landing", [
            {"file": "hero.tsx", "symptom": "low contrast", "fix": "bg-slate-900"},
        ])
        # No merged design-critic.json.
        rc, out, err = self._run_consolidator()
        self.assertEqual(rc, 0, f"consolidator failed: {err}")
        rows = self._ledger_rows()
        self.assertEqual(len(rows), 1, f"expected 1 row, got {len(rows)}")
        self.assertEqual(rows[0]["batch_id"], "design-critic-landing")

    def test_non_aggregate_agent_unaffected_by_dedup(self):
        """security-fixer is not a lead_merge_aggregate_agent; its fixes
        always go into the ledger directly."""
        path = os.path.join(self.traces, "security-fixer.json")
        with open(path, "w") as f:
            json.dump({
                "agent": "security-fixer", "run_id": "t1",
                "timestamp": "2026-04-23T12:00:00Z",
                "fixes": [
                    {"file": "a.ts", "symptom": "missing auth", "fix": "added middleware"},
                    {"file": "b.ts", "symptom": "leak", "fix": "redacted"},
                ],
            }, f)
        rc, out, err = self._run_consolidator()
        self.assertEqual(rc, 0)
        rows = self._ledger_rows()
        self.assertEqual(len(rows), 2)


if __name__ == "__main__":
    unittest.main()
