"""Tests for state-registry.json structural validation."""
import json
import os
import re
import pytest

REGISTRY_PATH = os.path.join(
    os.path.dirname(__file__), "..", ".claude", "patterns", "state-registry.json"
)


def load_registry():
    with open(REGISTRY_PATH) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Registry top-level structure
# ---------------------------------------------------------------------------


class TestRegistryStructure:
    def test_is_valid_json(self):
        reg = load_registry()
        assert isinstance(reg, dict)

    def test_skill_sections_are_dicts(self):
        reg = load_registry()
        for key, val in reg.items():
            assert isinstance(val, dict), f"Top-level key '{key}' must be a dict"


# ---------------------------------------------------------------------------
# State entry format validation (string or object)
# ---------------------------------------------------------------------------


class TestStateEntryFormats:
    def test_all_entries_are_string_or_object(self):
        reg = load_registry()
        for skill, states in reg.items():
            for state_id, entry in states.items():
                assert isinstance(entry, (str, dict)), (
                    f"{skill}.{state_id}: entry must be str or dict, "
                    f"got {type(entry).__name__}"
                )

    def test_object_entries_have_verify_key(self):
        reg = load_registry()
        skip_sections = {"trace_schemas"}
        for skill, states in reg.items():
            if skill in skip_sections:
                continue
            for state_id, entry in states.items():
                if isinstance(entry, dict):
                    assert "verify" in entry, (
                        f"{skill}.{state_id}: object entry must have 'verify' key"
                    )

    def test_object_entries_verify_is_string(self):
        reg = load_registry()
        skip_sections = {"trace_schemas"}
        for skill, states in reg.items():
            if skill in skip_sections:
                continue
            for state_id, entry in states.items():
                if isinstance(entry, dict):
                    assert isinstance(entry["verify"], str), (
                        f"{skill}.{state_id}: 'verify' must be a string"
                    )

    def test_object_entries_calls_is_list(self):
        reg = load_registry()
        skip_sections = {"trace_schemas"}
        for skill, states in reg.items():
            if skill in skip_sections:
                continue
            for state_id, entry in states.items():
                if isinstance(entry, dict) and "calls" in entry:
                    assert isinstance(entry["calls"], list), (
                        f"{skill}.{state_id}: 'calls' must be a list"
                    )

    def test_calls_entries_have_required_keys(self):
        reg = load_registry()
        skip_sections = {"trace_schemas"}
        for skill, states in reg.items():
            if skill in skip_sections:
                continue
            for state_id, entry in states.items():
                if isinstance(entry, dict) and "calls" in entry:
                    for i, call in enumerate(entry["calls"]):
                        assert isinstance(call, dict), (
                            f"{skill}.{state_id}.calls[{i}]: must be a dict"
                        )
                        assert "path" in call, (
                            f"{skill}.{state_id}.calls[{i}]: must have 'path'"
                        )
                        assert "artifact" in call, (
                            f"{skill}.{state_id}.calls[{i}]: must have 'artifact'"
                        )


# ---------------------------------------------------------------------------
# Current registry baseline
# ---------------------------------------------------------------------------

# Object-format entries that have been intentionally upgraded
KNOWN_OBJECT_ENTRIES = {
    ("change", "2"),
    ("change", "3"),
    ("change", "6"),
    ("verify", "7b"),
}


class TestRegistryBaseline:
    def test_entry_count(self):
        """Confirm total entry count hasn't changed unexpectedly."""
        reg = load_registry()
        count = 0
        for skill, states in reg.items():
            if skill == "trace_schemas":
                continue
            count += len(states)
        assert count >= 100, f"Expected ~147 state entries, found {count}"

    def test_known_object_entries_are_objects(self):
        """Entries listed in KNOWN_OBJECT_ENTRIES must be object format."""
        reg = load_registry()
        for skill, state_id in KNOWN_OBJECT_ENTRIES:
            entry = reg[skill][state_id]
            assert isinstance(entry, dict), (
                f"{skill}.{state_id}: expected object format"
            )

    def test_non_listed_entries_are_strings(self):
        """Entries NOT in KNOWN_OBJECT_ENTRIES must still be strings."""
        reg = load_registry()
        skip_sections = {"trace_schemas"}
        for skill, states in reg.items():
            if skill in skip_sections:
                continue
            for state_id, entry in states.items():
                if (skill, state_id) in KNOWN_OBJECT_ENTRIES:
                    continue
                assert isinstance(entry, str), (
                    f"{skill}.{state_id}: unexpected object entry — "
                    f"add to KNOWN_OBJECT_ENTRIES if intentional"
                )


# ---------------------------------------------------------------------------
# State ordering (keys should be in ascending order within each skill)
# ---------------------------------------------------------------------------


def _state_sort_key(state_id):
    """Sort key for state IDs: numeric first, then alpha suffixes."""
    m = re.match(r"^(\d+)(.*)$", state_id)
    if m:
        return (int(m.group(1)), m.group(2))
    return (999, state_id)


class TestStateOrdering:
    def test_state_keys_in_ascending_order(self):
        reg = load_registry()
        skip_sections = {"trace_schemas"}
        for skill, states in reg.items():
            if skill in skip_sections:
                continue
            keys = list(states.keys())
            sorted_keys = sorted(keys, key=_state_sort_key)
            assert keys == sorted_keys, (
                f"{skill}: state keys out of order: {keys} vs expected {sorted_keys}"
            )


# ---------------------------------------------------------------------------
# Bidirectional file <-> registry sync validation
# ---------------------------------------------------------------------------

SKILLS_DIR = os.path.join(
    os.path.dirname(__file__), "..", ".claude", "skills"
)


def _discover_state_files():
    """Find all state-*.md files under .claude/skills/*/."""
    import glob
    return sorted(glob.glob(os.path.join(SKILLS_DIR, "*", "state-*.md")))


def _extract_advance_state_calls(filepath):
    """Parse advance-state.sh <skill> <state> from a state file.

    Uses the skill name from the call, NOT the directory name.
    Handles multi-mode: iterate/state-c0-*.md -> iterate-check.c0
    """
    results = []
    with open(filepath) as f:
        for line in f:
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            m = re.search(
                r'(?:bash\s+\S*/|\./)advance-state\.sh\s+([a-z][-a-z]*)\s+([a-z0-9_]+)',
                stripped,
            )
            if m:
                results.append((m.group(1), m.group(2)))
    return results


class TestForwardSync:
    """Every state file on disk must have a matching registry entry."""

    def test_every_state_file_has_registry_entry(self):
        reg = load_registry()
        missing = []
        for f in _discover_state_files():
            for skill, state_id in _extract_advance_state_calls(f):
                if skill not in reg or state_id not in reg.get(skill, {}):
                    missing.append(
                        f"{skill}.{state_id} (from {os.path.basename(f)})"
                    )
        assert not missing, (
            f"{len(missing)} unregistered entries:\n"
            + "\n".join(f"  {m}" for m in missing)
        )

    def test_every_state_file_has_advance_state_call(self):
        no_call = []
        for f in _discover_state_files():
            if not _extract_advance_state_calls(f):
                no_call.append(os.path.relpath(f))
        assert not no_call, (
            f"{len(no_call)} state files lack advance-state.sh call:\n"
            + "\n".join(f"  {f}" for f in no_call)
        )


class TestReverseSync:
    """Every registry entry must have a corresponding state file."""

    def test_every_registry_entry_has_state_file(self):
        reg = load_registry()
        skip = {"trace_schemas"}
        file_map = {}
        for f in _discover_state_files():
            for skill, state_id in _extract_advance_state_calls(f):
                file_map[(skill, state_id)] = f
        missing = []
        for skill, states in reg.items():
            if skill in skip:
                continue
            for state_id in states:
                if (skill, state_id) not in file_map:
                    missing.append(f"{skill}.{state_id}")
        assert not missing, (
            f"{len(missing)} orphan registry entries:\n"
            + "\n".join(f"  {m}" for m in missing)
        )


class TestPostconditionSyntax:
    """Verify postcondition commands are syntactically valid."""

    def test_python_commands_parse(self):
        import ast
        reg = load_registry()
        skip = {"trace_schemas"}
        errors = []
        for skill, states in reg.items():
            if skill in skip:
                continue
            for state_id, entry in states.items():
                cmd = (
                    entry.get("verify", entry)
                    if isinstance(entry, dict)
                    else entry
                )
                if not isinstance(cmd, str):
                    continue
                for m in re.finditer(
                    r'python3 -c "(.*?)"(?:\s|$|\|)', cmd, re.DOTALL
                ):
                    code = m.group(1).replace('\\"', '"')
                    try:
                        ast.parse(code)
                    except SyntaxError as e:
                        errors.append(f"{skill}.{state_id}: {e}")
        assert not errors, (
            f"{len(errors)} syntax errors:\n" + "\n".join(errors)
        )

    def test_object_entries_structure(self):
        reg = load_registry()
        skip = {"trace_schemas"}
        errors = []
        for skill, states in reg.items():
            if skill in skip:
                continue
            for state_id, entry in states.items():
                if not isinstance(entry, dict):
                    continue
                if "verify" not in entry:
                    errors.append(f"{skill}.{state_id}: missing 'verify'")
                elif not isinstance(entry["verify"], str):
                    errors.append(f"{skill}.{state_id}: 'verify' not string")
                if "calls" in entry and not isinstance(entry["calls"], list):
                    errors.append(f"{skill}.{state_id}: 'calls' not list")
        assert not errors, "\n".join(errors)


# ---------------------------------------------------------------------------
# Verify-linter integration (VERIFY-POSTCONDITIONS drift detection)
# ---------------------------------------------------------------------------


class TestVerifyLinterClean:
    """verify-linter.sh must report 0 uncovered, 0 diverged, 0 unjustified_true."""

    def test_verify_linter_passes(self):
        import subprocess

        repo_root = os.path.join(os.path.dirname(__file__), "..")
        linter = os.path.join(repo_root, ".claude", "scripts", "verify-linter.sh")
        result = subprocess.run(
            ["bash", linter],
            capture_output=True,
            text=True,
            cwd=repo_root,
        )
        assert result.returncode == 0, (
            f"verify-linter.sh failed (exit {result.returncode}):\n"
            f"{result.stdout}\n{result.stderr}"
        )
        assert "0 uncovered" in result.stdout, f"Expected 0 uncovered:\n{result.stdout}"
        assert "0 diverged" in result.stdout, f"Expected 0 diverged:\n{result.stdout}"
        assert "0 unjustified_true" in result.stdout, (
            f"Expected 0 unjustified_true:\n{result.stdout}"
        )
