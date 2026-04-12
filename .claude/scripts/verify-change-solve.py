#!/usr/bin/env python3
"""VERIFY script for change state 3: validate solve-trace.json and change-challenge.json.

Checks:
- solve_depth matches the complexity formula
- solve-trace.json has all required fields
- change-challenge.json exists with valid structure
- Full mode requires critic_rounds > 0
"""
import json

ctx = json.load(open(".runs/change-context.json"))
sd = ctx.get("solve_depth")
assert sd in ("light", "full"), "solve_depth=%s" % sd

pt = ctx.get("preliminary_type", "")
aa = ctx.get("affected_areas", 0)
assert not (
    pt in ("Feature", "Upgrade") and isinstance(aa, int) and aa >= 3 and sd != "full"
), "Formula requires full (type=%s,areas=%s) but got %s" % (pt, aa, sd)

st = json.load(open(".runs/solve-trace.json"))
required = [
    "mode",
    "problem_decomposition",
    "constraint_enumeration",
    "solution_design",
    "self_check",
    "output",
]
missing = [k for k in required if k not in st]
assert not missing, "solve-trace.json missing: %s" % missing

# Prevention analysis: required when preliminary_type is Fix
pt = ctx.get("preliminary_type", "")
pa = st.get("prevention_analysis")
if pt == "Fix":
    assert pa is not None, "prevention_analysis required when preliminary_type=Fix"
    assert isinstance(pa, dict), "prevention_analysis must be a dict"
    for field in ("root_cause_addressed", "recurrence_risk", "scope"):
        assert field in pa, "prevention_analysis missing %s" % field
    assert pa["recurrence_risk"] in ("none", "guarded", "unguarded"), (
        "recurrence_risk invalid: %s" % pa["recurrence_risk"]
    )

cc = json.load(open(".runs/change-challenge.json"))
assert isinstance(cc.get("critic_rounds"), int), "critic_rounds missing or not int"
assert isinstance(cc.get("concerns"), list), "concerns missing or not list"
assert not (sd == "full" and cc["critic_rounds"] == 0), "full mode but critic_rounds=0"
ta = cc.get("round_1_type_a_count", 0)
assert not (ta > 0 and cc["critic_rounds"] < 2), (
    "round_1_type_a_count=%d but critic_rounds=%d — round 2 required when TYPE A > 0"
    % (ta, cc["critic_rounds"])
)
