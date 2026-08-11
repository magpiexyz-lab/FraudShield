#!/usr/bin/env python3
"""test_worktree_boundary_gate.py — runtime guard on Edit/Write/MultiEdit/NotebookEdit.

Exercises .claude/hooks/worktree-boundary-gate.sh added for issue #1225.

The hook fails loudly (exit 2) when an Edit/Write call from inside a non-primary
git worktree targets a path outside that worktree's root, with allowlisted
exceptions for /tmp, /var/tmp, and ~/.claude/projects/*/memory/*.

Hook protocol (Claude Code):
  exit 0 = allow
  exit non-zero = block

Run: python3 .claude/scripts/tests/test_worktree_boundary_gate.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
HOOK_SRC = ROOT / ".claude/hooks/worktree-boundary-gate.sh"


def _force_rmtree(path) -> None:
    """rmtree that actually works on git fixtures, on every platform.

    Two real-world failure modes this handles:
    - Windows: git marks files under .git/objects read-only; rmtree cannot
      delete them and the previous `ignore_errors=True` swallowed the failure
      — every test method silently leaked its full fixture tree under
      ~/.cache/wbgate-tests/ (the Lee 2026-08 accumulation). Fix: chmod the
      failing path writable and retry.
    - Everywhere: `git commit` in setUp can spawn background maintenance
      (`gc --auto`) that repacks loose objects WHILE tearDown walks the tree
      — rmtree then reports ENOENT for a just-vanished .git/objects/* entry.
      A handler that raises on that aborts the entire walk and leaks the
      whole fixture; a vanished entry is success, so it is skipped.

    Mechanics (each layer earned by an observed failure mode):
    - chmod is 0o700, never bare S_IWRITE: replacing a DIRECTORY's mode with
      write-only strips read+execute and locks the walk (and every later
      attempt) out of it — the d-w------- leak shape.
    - a top-down pre-pass makes every dir traversable BEFORE rmtree descends
      (fixes dirs whose perms already block scandir; onexc cannot resume a
      walk into a dir it failed to list).
    - up to 3 delete passes with a short backoff: background gc RECREATES
      pack files behind the walk, so the first pass can end ENOTEMPTY; a
      later pass runs after gc exits. The handler never raises — an abort
      mid-walk leaks everything not yet visited.
    """
    path = str(path)
    if not os.path.lexists(path):
        return

    def _handler(func, failed_path, exc):
        if isinstance(exc, FileNotFoundError):
            return  # entry vanished mid-walk (e.g. git background gc) — done
        try:
            os.chmod(failed_path, 0o700)
            func(failed_path)
        except OSError:
            pass  # leave it for a later pass / the post-check; never abort

    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    for root, dirs, _files in os.walk(path, topdown=True, onerror=lambda e: None):
        for d in dirs:
            sub = os.path.join(root, d)
            if not os.path.islink(sub):
                try:
                    os.chmod(sub, 0o700)
                except OSError:
                    pass

    for attempt in range(3):
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=_handler)
        else:  # onerror deprecated on 3.12+, required before
            shutil.rmtree(path, onerror=lambda f, p, ei: _handler(f, p, ei[1]))
        if not os.path.lexists(path):
            return
        time.sleep(0.2 * (attempt + 1))
    print(f"WARN: wbgate fixture cleanup left residue at {path}")


def _sweep_stale_fixtures(parent: Path, max_age_hours: float = 24) -> None:
    """Best-effort removal of leaked test_wbgate_* dirs older than the gate.

    Self-heals machines where a crashed/interrupted run (or the pre-fix
    Windows silent-leak bug) left fixtures behind. The age gate keeps the
    sweep from racing a concurrent pytest worker's live fixture (-n 2 runs).
    """
    try:
        cutoff = time.time() - max_age_hours * 3600
        for entry in parent.glob("test_wbgate_*"):
            if entry.stat().st_mtime < cutoff:
                _force_rmtree(entry)
    except OSError:
        pass


def _git(*args: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True
    )


class TestWorktreeBoundaryGate(unittest.TestCase):
    """Fixture: a real main repo + linked worktree under a tempdir.

    Layout:
      <tmp>/main/      — primary repo (cwd represents "main" or "non-worktree" runs)
      <tmp>/wt/        — linked worktree (cwd represents "in-worktree" runs)
      <tmp>/wt2/       — second linked worktree (cross-worktree denial test)
      <tmp>/home/      — fake $HOME (auto-memory allowlist test)
    """

    def setUp(self) -> None:
        # Use a fixture parent OUTSIDE the hook's allowlist (`/tmp`, `/var/tmp`).
        # Default tempfile.mkdtemp() returns `/tmp/...` on Linux which the hook
        # allowlists — making every "deny" assertion silently pass through.
        # Place fixtures under `~/.cache/wbgate-tests/` so the hook's tempdir
        # allowlist never short-circuits the in-worktree branch we want to test.
        # Canonicalize via realpath: macOS /var → /private/var symlinking, plus
        # git's own path canonicalization in rev-parse, mean lexical comparisons
        # break unless both sides are realpath. Tests assert exact strings.
        fixtures_parent = Path.home() / ".cache" / "wbgate-tests"
        fixtures_parent.mkdir(parents=True, exist_ok=True)
        _sweep_stale_fixtures(fixtures_parent)
        self.tmp = Path(
            os.path.realpath(
                tempfile.mkdtemp(prefix="test_wbgate_", dir=str(fixtures_parent))
            )
        )
        self.main = self.tmp / "main"
        self.main.mkdir()
        # init git repo and a baseline commit so `git worktree add` works.
        _git("init", "-q", "-b", "main", cwd=self.main)
        _git("config", "user.email", "test@test", cwd=self.main)
        _git("config", "user.name", "test", cwd=self.main)
        # Copy .claude tree (contains the hook + lib facade) into main.
        shutil.copytree(ROOT / ".claude", self.main / ".claude")
        _git("add", ".", cwd=self.main)
        _git("commit", "-qm", "init", cwd=self.main)
        # Linked worktrees. wt2 lives under main/.claude/worktrees/ to match the
        # template's actual convention (where the cross-worktree denial branch
        # in the hook explicitly looks for `<main>/.claude/worktrees/*`).
        self.wt = self.tmp / "wt"
        _git("worktree", "add", "-q", "-b", "wt-branch", str(self.wt), cwd=self.main)
        (self.main / ".claude" / "worktrees").mkdir(exist_ok=True)
        self.wt2 = self.main / ".claude" / "worktrees" / "wt2"
        _git("worktree", "add", "-q", "-b", "wt2-branch", str(self.wt2), cwd=self.main)
        # Fake HOME for auto-memory allowlist.
        self.home = self.tmp / "home"
        (self.home / ".claude" / "projects" / "proj1" / "memory").mkdir(parents=True)
        # Hook path resolved from the main copy (worktrees share .claude via copy).
        self.hook = self.main / ".claude/hooks/worktree-boundary-gate.sh"

    def tearDown(self) -> None:
        _force_rmtree(self.tmp)

    def _invoke(
        self,
        file_path: str,
        *,
        tool_name: str = "Write",
        notebook: bool = False,
        cwd: Path | None = None,
        claude_project_dir: Path | None = None,
    ) -> tuple[int, str]:
        """Run the hook. Returns (exit_code, stderr).

        cwd defaults to the linked worktree (the canonical "in-worktree" case).
        claude_project_dir defaults to the same worktree.
        """
        cwd = cwd if cwd is not None else self.wt
        cpd = claude_project_dir if claude_project_dir is not None else self.wt
        if notebook:
            payload_input = {"notebook_path": file_path, "new_source": "x"}
        elif tool_name == "Write":
            payload_input = {"file_path": file_path, "content": "{}"}
        elif tool_name == "MultiEdit":
            payload_input = {
                "file_path": file_path,
                "edits": [{"old_string": "x", "new_string": "y"}],
            }
        else:  # Edit
            payload_input = {"file_path": file_path, "old_string": "x", "new_string": "y"}
        payload = json.dumps({"tool_name": tool_name, "tool_input": payload_input})
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(cpd)
        env["HOME"] = str(self.home)
        proc = subprocess.run(
            ["bash", str(self.hook)],
            input=payload,
            capture_output=True,
            text=True,
            env=env,
            cwd=str(cwd),
            timeout=10,
        )
        return proc.returncode, proc.stderr

    # ---------- 1. Not in a (non-primary) worktree ----------

    def test_not_in_worktree_allows_anything(self) -> None:
        # cwd = main repo (primary). Even a "main repo" path must exit 0
        # because the boundary check is scoped to non-primary worktrees only.
        target = self.main / ".claude" / "test.md"
        rc, err = self._invoke(
            str(target), cwd=self.main, claude_project_dir=self.main
        )
        self.assertEqual(rc, 0, f"primary worktree must NO-OP; stderr={err}")

    # ---------- 2. In-worktree write allowed ----------

    def test_in_worktree_write_inside_allows(self) -> None:
        target = self.wt / ".claude" / "inside.md"
        rc, err = self._invoke(str(target))
        self.assertEqual(rc, 0, f"in-bounds write must allow; stderr={err}")
        self.assertEqual(err.strip(), "")

    # ---------- 3. In-worktree write to main repo denies + suggests ----------

    def test_in_worktree_write_to_main_repo_denies_with_suggestion(self) -> None:
        target = self.main / ".claude" / "out.md"
        rc, err = self._invoke(str(target))
        self.assertNotEqual(rc, 0, "out-of-bounds write must block")
        self.assertIn("outside the active worktree", err)
        self.assertIn("Did you mean", err)
        # Suggestion replaces main prefix with active-worktree prefix.
        self.assertIn(str(self.wt / ".claude" / "out.md"), err)

    # ---------- 4. Cross-worktree write denies ----------

    def test_in_worktree_write_to_different_worktree_denies(self) -> None:
        target = self.wt2 / ".claude" / "other.md"
        rc, err = self._invoke(str(target))
        self.assertNotEqual(rc, 0)
        self.assertIn("different worktree", err)

    # ---------- 5. Allowlist fast-paths ----------

    def test_tmp_path_allowed(self) -> None:
        rc, err = self._invoke("/tmp/scratch-1225.txt")
        self.assertEqual(rc, 0)
        self.assertEqual(err.strip(), "")

    def test_private_tmp_path_allowed(self) -> None:
        rc, err = self._invoke("/private/tmp/scratch-1225.txt")
        self.assertEqual(rc, 0)

    def test_var_tmp_path_allowed(self) -> None:
        rc, err = self._invoke("/var/tmp/scratch-1225.txt")
        self.assertEqual(rc, 0)

    def test_auto_memory_path_allowed(self) -> None:
        target = self.home / ".claude" / "projects" / "proj1" / "memory" / "MEMORY.md"
        rc, err = self._invoke(str(target))
        self.assertEqual(rc, 0, f"auto-memory write must allow; stderr={err}")

    # ---------- 6. Allowlist narrowness (first-principles reason #8) ----------

    def test_claude_cache_path_denied(self) -> None:
        # Per first-principles reason #8: the allowlist is narrow on purpose;
        # ~/.claude/cache is NOT a memory path and must be blocked.
        target = self.home / ".claude" / "cache" / "foo.json"
        rc, err = self._invoke(str(target))
        self.assertNotEqual(rc, 0, "narrow allowlist: ~/.claude/cache must block")

    # ---------- 7. Tool surface coverage ----------

    def test_edit_payload_same_behavior(self) -> None:
        target = self.main / ".claude" / "out.md"
        rc, err = self._invoke(str(target), tool_name="Edit")
        self.assertNotEqual(rc, 0)
        self.assertIn("outside the active worktree", err)

    def test_multiedit_payload_same_behavior(self) -> None:
        target = self.main / ".claude" / "out.md"
        rc, err = self._invoke(str(target), tool_name="MultiEdit")
        self.assertNotEqual(rc, 0)
        self.assertIn("outside the active worktree", err)

    def test_notebookedit_payload_uses_notebook_path(self) -> None:
        target = self.main / ".claude" / "out.ipynb"
        rc, err = self._invoke(str(target), tool_name="NotebookEdit", notebook=True)
        self.assertNotEqual(rc, 0)
        self.assertIn("outside the active worktree", err)

    # ---------- 8. Round-2 critic: paths with spaces ----------

    def test_path_with_spaces_does_not_break_dirname(self) -> None:
        # Regression test for the `xargs dirname` bug (round-2 critic concern #1).
        # Reconstruct the fixture with a workspace path containing a space.
        spaced_root = self.tmp / "with space"
        spaced_root.mkdir()
        spaced_root = Path(os.path.realpath(spaced_root))
        spaced_main = spaced_root / "main"
        spaced_main.mkdir()
        _git("init", "-q", "-b", "main", cwd=spaced_main)
        _git("config", "user.email", "test@test", cwd=spaced_main)
        _git("config", "user.name", "test", cwd=spaced_main)
        shutil.copytree(ROOT / ".claude", spaced_main / ".claude")
        _git("add", ".", cwd=spaced_main)
        _git("commit", "-qm", "init", cwd=spaced_main)
        spaced_wt = spaced_root / "wt-spaced"
        _git(
            "worktree",
            "add",
            "-q",
            "-b",
            "spaced-branch",
            str(spaced_wt),
            cwd=spaced_main,
        )
        target = spaced_main / ".claude" / "out.md"
        # Use the spaced worktree's own copy of the hook so paths line up.
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(spaced_wt)
        env["HOME"] = str(self.home)
        payload = json.dumps(
            {
                "tool_name": "Write",
                "tool_input": {"file_path": str(target), "content": "{}"},
            }
        )
        proc = subprocess.run(
            ["bash", str(spaced_main / ".claude/hooks/worktree-boundary-gate.sh")],
            input=payload,
            capture_output=True,
            text=True,
            env=env,
            cwd=str(spaced_wt),
            timeout=10,
        )
        # The deny path must trigger correctly — i.e., MAIN_ROOT must equal
        # spaced_main, NOT some xargs-mangled fragment. If `xargs dirname` were
        # used, MAIN_ROOT would be empty/mangled and the categorized branch
        # would mis-classify the deny.
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("outside the active worktree", proc.stderr)

    # ---------- 9. Round-2 critic: symlinked workspace ----------

    def test_symlinked_workspace_resolves_correctly(self) -> None:
        # Round-2 critic concern #4. Lead's session may use a symlinked workspace
        # path; CLAUDE_PROJECT_DIR is canonical. realpath comparison must allow
        # writes via the symlinked alias.
        link = self.tmp / "wt-symlink"
        os.symlink(self.wt, link)
        target = link / ".claude" / "via-sym.md"
        rc, err = self._invoke(str(target))
        self.assertEqual(rc, 0, f"symlinked-alias path must resolve and allow; stderr={err}")


class TestFixtureCleanup(unittest.TestCase):
    """The cleanup helpers themselves (no git fixtures needed)."""

    def test_force_rmtree_removes_read_only_files(self):
        # Reproduces the Windows leak shape: a nested read-only file (git
        # object perms). On Windows the plain rmtree fails here and the chmod
        # handler must kick in; on POSIX this proves the helper is harmless.
        tmp = Path(tempfile.mkdtemp(prefix="wbgate-helper-"))
        nested = tmp / "repo" / ".git" / "objects"
        nested.mkdir(parents=True)
        ro = nested / "pack-deadbeef.pack"
        ro.write_text("x")
        ro.chmod(0o444)
        _force_rmtree(tmp)
        self.assertFalse(tmp.exists(), "read-only tree must be fully removed")

    def test_sweep_removes_stale_keeps_fresh(self):
        parent = Path(tempfile.mkdtemp(prefix="wbgate-sweep-"))
        try:
            stale = parent / "test_wbgate_stale"
            (stale / "junk").mkdir(parents=True)
            old = time.time() - 48 * 3600
            os.utime(stale, (old, old))
            fresh = parent / "test_wbgate_fresh"
            fresh.mkdir()
            unrelated = parent / "not-a-fixture"
            unrelated.mkdir()
            os.utime(unrelated, (old, old))

            _sweep_stale_fixtures(parent, max_age_hours=24)

            self.assertFalse(stale.exists(), "48h-old fixture must be swept")
            self.assertTrue(fresh.exists(), "fresh fixture must survive (live-run race guard)")
            self.assertTrue(unrelated.exists(), "sweep must only touch test_wbgate_* entries")
        finally:
            _force_rmtree(parent)


if __name__ == "__main__":
    unittest.main(verbosity=2)
