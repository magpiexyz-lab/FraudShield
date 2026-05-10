#!/usr/bin/env python3
"""VERIFY script for resolve state 5d: validate resolve-challenge.json schema.

Checks:
- challenges array is non-empty
- Each entry has agent_label, final_label (valid values)
- override_reason required when labels differ
- critic_rounds and round_1_type_a_count consistency
- Adversarial trace exists (resolve-challenger or solve-critic)
"""
import json
import os
import sys

d = json.load(open(".runs/resolve-challenge.json"))
cs = d.get("challenges", [])
assert isinstance(cs, list) and len(cs) > 0, "challenges empty"

valid_labels = ("sound", "challenged", "needs-revision")
for i, c in enumerate(cs):
    assert "agent_label" in c, f"challenges[{i}] missing agent_label"
    assert "final_label" in c, f"challenges[{i}] missing final_label"
    assert c["agent_label"] in valid_labels, f"challenges[{i}] invalid agent_label: {c['agent_label']}"
    assert c["final_label"] in valid_labels, f"challenges[{i}] invalid final_label: {c['final_label']}"
    if c["agent_label"] != c["final_label"]:
        reason = c.get("override_reason", "").strip()
        assert reason, f"challenges[{i}] override_reason required when labels differ"

cr = d.get("critic_rounds")
ta = d.get("round_1_type_a_count", 0)
assert cr is not None, "critic_rounds missing"
assert not (ta > 0 and cr < 2), (
    "round_1_type_a_count=%d but critic_rounds=%d — round 2 required when TYPE A > 0" % (ta, cr)
)

assert os.path.exists(".runs/agent-traces/resolve-challenger.json") or os.path.exists(
    ".runs/agent-traces/solve-critic.json"
), "adversarial trace missing (resolve-challenger.json or solve-critic.json)"
