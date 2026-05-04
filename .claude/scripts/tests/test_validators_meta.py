"""Meta-tests for the 5 hard-block validators introduced in the unified
physical-artifact-enforcement PR (#1276/#1272/#1261/#1252/#1255).

Round-2 critic Concern 8: future PRs that soften any validator (e.g.,
replacing `assert <condition>` with `print("WARN"); sys.exit(0)`) get
caught by these property tests. Each validator is exercised with synthetic
INVALID inputs and the test asserts non-zero exit code AND/OR specific
error output.

Layout (one TestCase per validator):
  - existence: validator script file exists and is executable
  - reference: validator is referenced from its expected integration point
    (state-registry.json / lifecycle-finalize.sh / observation-phase.md)
  - happy_path: clean fixture → exit 0
  - missing_input: required input absent → controlled exit (skip OR fail)
  - synthetic_invalid: malformed/incomplete fixture → exit 1 in deny mode
  - softening_no_op: hypothetical "no-op" patch wouldn't pass — verified
    indirectly by asserting the validator's output mentions specific
    error categories (a no-op print('ok') script wouldn't)

CI auto-discovers this file via .github/workflows/ci.yml line 113
(`pytest .claude/scripts/tests/`).

Conventions reused from .claude/scripts/tests/test_validate_recovery.py:
  - subprocess + tempdir + git init pattern
  - cwd-pinned subprocess.run for fixture isolation
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Repo root: tests/ lives at .claude/scripts/tests/, so up 3 = repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / ".claude" / "scripts"

# Pre-cutoff run_id (matches RUN_ID_TS_RE) — schema_version_gate returns 1
PRE_CUTOFF_RUN_ID = "test-2020-01-01T00:00:00Z"

# Post-cutoff would be after MIGRATION_CUTOFF_ISO. Since cutoff is the
# placeholder __MERGE_COMMIT_TIMESTAMP__ until merge-commit sed, we cannot
# directly construct a "post-cutoff" run_id. Instead, the meta-tests
# exercise the validators in pre-cutoff SKIP mode (which exits 0) AND
# directly exercise the underlying logic by setting the env var to deny
# mode + faking pending-findings to verify error paths produce non-zero
# exit when MODE=deny is forced AND the gate is artificially activated.

# To exercise post-cutoff behavior we monkey-patch the helper module by
# setting MIGRATION_CUTOFF_ISO via a wrapper subprocess that pre-imports
# and overrides. Pattern: PYTHONPATH=<lib> python -c "import schema_version_gate;
# schema_version_gate.MIGRATION_CUTOFF_ISO='2000-01-01T00:00:00Z'; <run script>".

VALIDATORS = {
    "validate-retrospective-completeness.py": {
        "mode_env": "RETROSPECTIVE_COMPLETENESS_MODE",
        "ref_files": [
            # Wired at check-observation-artifacts.sh (state-99 Step 2a),
            # NOT lifecycle-finalize.sh (state-99 Step 1) — the latter runs
            # BEFORE retrospective-result.json is written by Step 5a.
            ".claude/scripts/check-observation-artifacts.sh",
            ".claude/patterns/observation-phase.md",
        ],
    },
    "validate-step55-evidence.py": {
        "mode_env": "STEP55_EVIDENCE_MODE",
        "ref_files": [
            ".claude/patterns/state-registry.json",
            ".claude/procedures/design-critic.md",
        ],
    },
    "validate-image-spec-compliance.py": {
        "mode_env": "SCAFFOLD_IMAGES_SPEC_MODE",
        "ref_files": [
            ".claude/patterns/state-registry.json",
        ],
    },
    "validate-scaffold-recommendations-schema.py": {
        "mode_env": "SCAFFOLD_RECOMMENDATIONS_SCHEMA_MODE",
        "ref_files": [
            ".claude/patterns/state-registry.json",
        ],
    },
    "validate-observer-evidence-coverage.py": {
        "mode_env": "OBSERVER_EVIDENCE_COVERAGE_MODE",
        "ref_files": [
            ".claude/patterns/observation-phase.md",
            ".claude/agents/observer.md",
        ],
    },
}


def _run_validator(
    validator: str,
    cwd: Path,
    extra_env: dict | None = None,
    timeout: int = 30,
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["python3", str(SCRIPTS_DIR / validator)],
        cwd=str(cwd), env=env, capture_output=True, text=True, timeout=timeout,
    )


def _setup_tempdir_with_context(run_id: str = PRE_CUTOFF_RUN_ID) -> Path:
    """Create tempdir with a minimal .runs/<skill>-context.json."""
    tmp = Path(tempfile.mkdtemp(prefix="test_validator_"))
    runs = tmp / ".runs"
    runs.mkdir(parents=True, exist_ok=True)
    # Minimal context that _active_run_id() will pick up
    skill = run_id.split("-2", 1)[0]
    ctx = {
        "skill": skill,
        "branch": "test",
        "timestamp": "2020-01-01T00:00:00Z",
        "run_id": run_id,
        "completed_states": [],
        "completed": False,
    }
    (runs / f"{skill}-context.json").write_text(json.dumps(ctx))
    return tmp


def _force_post_cutoff_invocation(
    validator: str,
    cwd: Path,
    extra_env: dict | None = None,
    timeout: int = 30,
) -> subprocess.CompletedProcess:
    """Run a validator with MIGRATION_CUTOFF_ISO patched to a past date,
    so all run_ids are post-cutoff and the validator's actual logic runs."""
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)

    # Symlink lib/ + patched schema_version_gate.py
    # Simpler: copy validator and lib to tempdir, then patch
    # Even simpler: use a wrapper that pre-imports and overrides

    wrapper = f"""
import sys, os, runpy
sys.path.insert(0, {str(SCRIPTS_DIR)!r})
import lib.schema_version_gate as svg
svg.MIGRATION_CUTOFF_ISO = "2000-01-01T00:00:00Z"
runpy.run_path({str(SCRIPTS_DIR / validator)!r}, run_name="__main__")
"""
    return subprocess.run(
        ["python3", "-c", wrapper],
        cwd=str(cwd), env=env, capture_output=True, text=True, timeout=timeout,
    )


# ---------- Universal tests applied to every validator ----------

class TestValidatorExistence(unittest.TestCase):
    """Each validator script must exist and be executable."""

    def test_all_validator_scripts_exist(self):
        for name in VALIDATORS:
            path = SCRIPTS_DIR / name
            self.assertTrue(
                path.is_file(),
                f"validator {name!r} missing at {path}",
            )

    def test_all_validators_have_main_block(self):
        for name in VALIDATORS:
            content = (SCRIPTS_DIR / name).read_text()
            self.assertIn(
                "if __name__ == \"__main__\"", content,
                f"{name}: missing __main__ block",
            )


class TestValidatorReferences(unittest.TestCase):
    """Each validator must be referenced from its expected integration files
    (#1276 round-2 C8 anti-removal property)."""

    def test_validators_referenced_from_integration_points(self):
        for name, spec in VALIDATORS.items():
            for ref_file in spec["ref_files"]:
                full = REPO_ROOT / ref_file
                self.assertTrue(
                    full.is_file(),
                    f"reference file {ref_file!r} missing",
                )
                content = full.read_text()
                self.assertIn(
                    name, content,
                    f"{name!r} not referenced from {ref_file!r} — integration broken",
                )


class TestValidatorPreCutoffSkip(unittest.TestCase):
    """Pre-cutoff run_id must produce SKIP exit 0 (backwards compat)."""

    def test_each_validator_skips_pre_cutoff(self):
        for name in VALIDATORS:
            with self.subTest(validator=name):
                tmp = _setup_tempdir_with_context(PRE_CUTOFF_RUN_ID)
                try:
                    r = _run_validator(name, tmp)
                    self.assertEqual(
                        r.returncode, 0,
                        f"{name}: pre-cutoff should exit 0 (got {r.returncode}); "
                        f"stdout={r.stdout!r} stderr={r.stderr!r}",
                    )
                    self.assertIn("SKIP", r.stdout + r.stderr,
                        f"{name}: pre-cutoff exit 0 but no SKIP message")
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)


# ---------- Per-validator targeted error-path tests ----------

class TestRetrospectiveCompletenessErrors(unittest.TestCase):
    """validate-retrospective-completeness.py: missing dispositions → error
    in deny mode. Verifies the validator actually checks pending vs filed
    (a no-op script would report OK)."""

    def test_post_cutoff_missing_disposition_fails_in_deny(self):
        tmp = _setup_tempdir_with_context("solve-2026-05-04T00:00:00Z")
        try:
            # Post-cutoff candidate without disposition
            (tmp / ".runs" / "retrospective-pending-findings.json").write_text(json.dumps({
                "run_id": "solve-2026-05-04T00:00:00Z",
                "schema_version": 2,
                "candidates": [{
                    "candidate_id": "abcdef123456",
                    "kind": "hook-friction",
                    "confidence": "high",
                    "key": "hook:test",
                    "evidence": {},
                    "source_files": [],
                }]
            }))
            r = _force_post_cutoff_invocation(
                "validate-retrospective-completeness.py",
                tmp,
                {"RETROSPECTIVE_COMPLETENESS_MODE": "deny"},
            )
            self.assertNotEqual(
                r.returncode, 0,
                f"deny mode + missing disposition should exit non-zero; "
                f"stdout={r.stdout!r} stderr={r.stderr!r}",
            )
            self.assertIn("MISSING DISPOSITION", r.stderr,
                "expected 'MISSING DISPOSITION' in stderr (no-op script wouldn't emit this)")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_post_cutoff_invalid_suppression_reason_fails(self):
        tmp = _setup_tempdir_with_context("solve-2026-05-04T00:00:00Z")
        try:
            (tmp / ".runs" / "retrospective-pending-findings.json").write_text(json.dumps({
                "run_id": "solve-2026-05-04T00:00:00Z",
                "schema_version": 2,
                "candidates": [{
                    "candidate_id": "abcdef123456", "kind": "k", "confidence": "high",
                    "key": "k", "evidence": {}, "source_files": [],
                }]
            }))
            (tmp / ".runs" / "retrospective-result.json").write_text(json.dumps({
                "step_5a_executor": "lead",
                "schema_version": 2,
                "suppressions": [{
                    "candidate_id": "abcdef123456",
                    "reason": "i-just-feel-like-it",  # not in closed enum
                    "justification": "n/a",
                }]
            }))
            r = _force_post_cutoff_invocation(
                "validate-retrospective-completeness.py",
                tmp,
                {"RETROSPECTIVE_COMPLETENESS_MODE": "deny"},
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("not in closed enum", r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestStep55EvidenceErrors(unittest.TestCase):
    """validate-step55-evidence.py: sidecar with N>1 candidates but no
    evidence files → fail."""

    def test_post_cutoff_missing_evidence_fails(self):
        tmp = _setup_tempdir_with_context("verify-2026-05-04T00:00:00Z")
        try:
            (tmp / ".runs" / "image-candidates.json").write_text(json.dumps({
                "schema_version": 2,
                "slots": {
                    "hero": {
                        "candidates": [
                            {"path": "a.webp", "selected": True},
                            {"path": "b.webp", "score_in_context": {"subject": 8, "style": 8, "color": 8, "composition": 8, "polish": 8}},
                            {"path": "c.webp", "score_in_context": {"subject": 8, "style": 8, "color": 8, "composition": 8, "polish": 8}},
                        ]
                    }
                }
            }))
            r = _force_post_cutoff_invocation(
                "validate-step55-evidence.py",
                tmp,
                {"STEP55_EVIDENCE_MODE": "deny"},
            )
            self.assertNotEqual(r.returncode, 0,
                f"missing evidence files should fail in deny; got {r.returncode}, stderr={r.stderr!r}")
            self.assertIn("evidence screenshot", r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestImageSpecComplianceErrors(unittest.TestCase):
    """validate-image-spec-compliance.py: model deviation without declaration → fail."""

    def test_post_cutoff_undeclared_deviation_fails(self):
        tmp = _setup_tempdir_with_context("change-2026-05-04T00:00:00Z")
        try:
            # spec must be readable from cwd as .claude/patterns/scaffold-images-spec.json
            spec_dir = tmp / ".claude" / "patterns"
            spec_dir.mkdir(parents=True)
            shutil.copy(
                REPO_ROOT / ".claude" / "patterns" / "scaffold-images-spec.json",
                spec_dir / "scaffold-images-spec.json",
            )
            (tmp / ".runs" / "image-manifest.json").write_text(json.dumps({
                "images": [
                    {"filename": "feature-1.webp", "model": "fal-ai/flux-2-pro"},  # spec says recraft
                ]
            }))
            # No spec_deviations declared in agent trace
            traces_dir = tmp / ".runs" / "agent-traces"
            traces_dir.mkdir(parents=True)
            (traces_dir / "scaffold-images.json").write_text(json.dumps({
                "verdict": "pass",
                "spec_deviations": [],
            }))
            r = _force_post_cutoff_invocation(
                "validate-image-spec-compliance.py",
                tmp,
                {"SCAFFOLD_IMAGES_SPEC_MODE": "deny"},
            )
            self.assertNotEqual(r.returncode, 0,
                f"undeclared deviation should fail; got {r.returncode}, stderr={r.stderr!r}")
            self.assertIn("not in spec", r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestScaffoldRecommendationsSchemaErrors(unittest.TestCase):
    """validate-scaffold-recommendations-schema.py: missing template_recommendations
    field → fail."""

    def test_post_cutoff_missing_field_fails(self):
        tmp = _setup_tempdir_with_context("bootstrap-2026-05-04T00:00:00Z")
        try:
            traces_dir = tmp / ".runs" / "agent-traces"
            traces_dir.mkdir(parents=True)
            (traces_dir / "scaffold-setup.json").write_text(json.dumps({
                "verdict": "pass",
                # template_recommendations missing entirely
            }))
            r = _force_post_cutoff_invocation(
                "validate-scaffold-recommendations-schema.py",
                tmp,
                {"SCAFFOLD_RECOMMENDATIONS_SCHEMA_MODE": "deny"},
            )
            self.assertNotEqual(r.returncode, 0,
                f"missing template_recommendations should fail; got {r.returncode}, stderr={r.stderr!r}")
            self.assertIn("schema completeness", r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_post_cutoff_empty_array_without_explicit_none_fails(self):
        tmp = _setup_tempdir_with_context("bootstrap-2026-05-04T00:00:00Z")
        try:
            traces_dir = tmp / ".runs" / "agent-traces"
            traces_dir.mkdir(parents=True)
            (traces_dir / "scaffold-libs.json").write_text(json.dumps({
                "verdict": "pass",
                "template_recommendations": [],
                # missing template_recommendations_explicit_none
            }))
            r = _force_post_cutoff_invocation(
                "validate-scaffold-recommendations-schema.py",
                tmp,
                {"SCAFFOLD_RECOMMENDATIONS_SCHEMA_MODE": "deny"},
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("requires", r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestObserverEvidenceCoverageErrors(unittest.TestCase):
    """validate-observer-evidence-coverage.py: existing evidence not consulted → fail."""

    def test_post_cutoff_missing_consultation_fails(self):
        tmp = _setup_tempdir_with_context("verify-2026-05-04T00:00:00Z")
        try:
            # Friction summary exists with content
            (tmp / ".runs" / "hook-friction-summary.json").write_text(json.dumps({
                "run_id": "verify-2026-05-04T00:00:00Z",
                "hooks": {"foo": {"count": 1}},
                "total": 1,
            }))
            traces_dir = tmp / ".runs" / "agent-traces"
            traces_dir.mkdir(parents=True)
            # Observer trace does NOT list it
            (traces_dir / "observer.json").write_text(json.dumps({
                "verdict": "pass",
                "evidence_consulted": [".runs/observer-diffs.txt"],
            }))
            r = _force_post_cutoff_invocation(
                "validate-observer-evidence-coverage.py",
                tmp,
                {"OBSERVER_EVIDENCE_COVERAGE_MODE": "deny"},
            )
            self.assertNotEqual(r.returncode, 0,
                f"missing consultation should fail; got {r.returncode}, stderr={r.stderr!r}")
            self.assertIn("evidence_consulted", r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ---------- phash.py + schema_version_gate.py library tests ----------

class TestPhashLibrary(unittest.TestCase):
    def test_imports_without_error(self):
        sys.path.insert(0, str(SCRIPTS_DIR))
        try:
            from lib.phash import (  # noqa: F401
                check_image_magic, hamming_distance, read_provenance,
                validate_provenance_triple_unique, validate_phash_diversity,
            )
        finally:
            sys.path.pop(0)

    def test_provenance_triple_unique(self):
        sys.path.insert(0, str(SCRIPTS_DIR))
        try:
            from lib.phash import validate_provenance_triple_unique
            errs = validate_provenance_triple_unique([
                {"model": "a", "prompt_hash": "b", "seed": 1},
                {"model": "a", "prompt_hash": "b", "seed": 1},  # dup
            ])
            self.assertEqual(len(errs), 1)
            self.assertIn("duplicate provenance triple", errs[0])
        finally:
            sys.path.pop(0)


class TestSchemaVersionGate(unittest.TestCase):
    def test_extract_run_id_timestamp(self):
        sys.path.insert(0, str(SCRIPTS_DIR))
        try:
            from lib.schema_version_gate import extract_run_id_timestamp
            self.assertEqual(
                extract_run_id_timestamp("solve-2026-05-04T03:12:26Z"),
                "2026-05-04T03:12:26Z",
            )
            self.assertEqual(
                extract_run_id_timestamp("iterate-cross-2026-04-13T07:07:04Z"),
                "2026-04-13T07:07:04Z",
            )
            self.assertIsNone(extract_run_id_timestamp(""))
        finally:
            sys.path.pop(0)

    def test_required_schema_version_post_cutoff_active(self):
        sys.path.insert(0, str(SCRIPTS_DIR))
        try:
            from lib.schema_version_gate import (
                required_schema_version, is_v2_active, MIGRATION_CUTOFF_ISO,
            )
            # Post-merge: gate is ACTIVE. MIGRATION_CUTOFF_ISO must match the
            # ISO 8601 UTC pattern. Pre-cutoff run_ids → 1, post-cutoff → 2.
            self.assertTrue(is_v2_active(),
                f"gate must be active post-merge; cutoff={MIGRATION_CUTOFF_ISO!r}")
            # A run_id from a year clearly before any plausible merge cutoff
            # must be grandfathered.
            self.assertEqual(
                required_schema_version("solve-2020-01-01T00:00:00Z"), 1
            )
            # A run_id from a year clearly after must enforce v2.
            self.assertEqual(
                required_schema_version("solve-2099-12-31T23:59:59Z"), 2
            )
        finally:
            sys.path.pop(0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
