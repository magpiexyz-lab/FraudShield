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

    def test_has_agent_gates(self):
        reg = load_registry()
        assert "agent_gates" in reg

    def test_skill_sections_are_dicts(self):
        reg = load_registry()
        for key, val in reg.items():
            if key == "agent_gates":
                continue
            assert isinstance(val, dict), f"Top-level key '{key}' must be a dict"


# ---------------------------------------------------------------------------
# State entry format validation (string or object)
# ---------------------------------------------------------------------------


class TestStateEntryFormats:
    def test_all_entries_are_string_or_object(self):
        reg = load_registry()
        for skill, states in reg.items():
            if skill == "agent_gates":
                continue
            for state_id, entry in states.items():
                assert isinstance(entry, (str, dict)), (
                    f"{skill}.{state_id}: entry must be str or dict, "
                    f"got {type(entry).__name__}"
                )

    def test_object_entries_have_verify_key(self):
        reg = load_registry()
        for skill, states in reg.items():
            if skill == "agent_gates":
                continue
            for state_id, entry in states.items():
                if isinstance(entry, dict):
                    assert "verify" in entry, (
                        f"{skill}.{state_id}: object entry must have 'verify' key"
                    )

    def test_object_entries_verify_is_string(self):
        reg = load_registry()
        for skill, states in reg.items():
            if skill == "agent_gates":
                continue
            for state_id, entry in states.items():
                if isinstance(entry, dict):
                    assert isinstance(entry["verify"], str), (
                        f"{skill}.{state_id}: 'verify' must be a string"
                    )

    def test_object_entries_calls_is_list(self):
        reg = load_registry()
        for skill, states in reg.items():
            if skill == "agent_gates":
                continue
            for state_id, entry in states.items():
                if isinstance(entry, dict) and "calls" in entry:
                    assert isinstance(entry["calls"], list), (
                        f"{skill}.{state_id}: 'calls' must be a list"
                    )

    def test_calls_entries_have_required_keys(self):
        reg = load_registry()
        for skill, states in reg.items():
            if skill == "agent_gates":
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
}


class TestRegistryBaseline:
    def test_entry_count(self):
        """Confirm total entry count hasn't changed unexpectedly."""
        reg = load_registry()
        count = 0
        for skill, states in reg.items():
            if skill == "agent_gates":
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
        for skill, states in reg.items():
            if skill == "agent_gates":
                continue
            for state_id, entry in states.items():
                if (skill, state_id) in KNOWN_OBJECT_ENTRIES:
                    continue
                assert isinstance(entry, str), (
                    f"{skill}.{state_id}: unexpected object entry — "
                    f"add to KNOWN_OBJECT_ENTRIES if intentional"
                )


# ---------------------------------------------------------------------------
# Agent gates structure
# ---------------------------------------------------------------------------


class TestAgentGatesStructure:
    def test_each_skill_has_required_states(self):
        reg = load_registry()
        ag = reg.get("agent_gates", {})
        for skill, gates in ag.items():
            assert "_required_states" in gates, (
                f"agent_gates.{skill}: missing _required_states"
            )
            assert isinstance(gates["_required_states"], list)


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
        for skill, states in reg.items():
            if skill == "agent_gates":
                continue
            keys = list(states.keys())
            sorted_keys = sorted(keys, key=_state_sort_key)
            assert keys == sorted_keys, (
                f"{skill}: state keys out of order: {keys} vs expected {sorted_keys}"
            )
