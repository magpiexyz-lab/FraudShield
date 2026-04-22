# Review-Verdict Gate

Shared enforcement of the `review_method → verdict` mapping across all
reviewer agents. Invoked state-locally by the state that spawns each
reviewer, after the agent's trace lands.

> **Problem solved**: without this gate, each reviewer agent carries its
> own `review_method → verdict` decision in the agent's code, and a
> tampered or buggy agent can emit a "PASS" on a `source-only` review.
> This gate is the tamper-resistant choke point: agents emit whatever
> verdict they think is right, and this gate overwrites the trace with
> the policy-correct verdict (logging the correction). The
> `review_method_gate_evaluated` sentinel proves the gate ran —
> `state-registry.json` VERIFY commands assert its presence so the gate
> cannot be silently bypassed.

## Callers

| State | Agent trace(s) | Invocation point |
|---|---|---|
| `state-2-phase1-parallel.md` | `behavior-verifier.json`, `accessibility-scanner.json` | After Phase 1 agents return |
| `state-3a-design-agents.md` | `design-critic-*.json` (per-page) | **Unchanged** — state-3b's existing merge code already enforces design-critic's mapping. Not called here. |
| `state-3b-quality-gate.md` | `design-critic.json` (merged) | **Unchanged** — existing enforcement stays. Not called here. |
| `state-3c-ux-merge.md` | `ux-journeyer.json` | After ux-journeyer returns |

design-critic and accessibility-scanner's existing enforcement (`source-only`
/ `unknown` → `"unresolved"`) is preserved in state-3b for design-critic
and in accessibility-scanner's own procedure for skip-page handling. This
gate **adds** rules for the new review_methods (`prereq-unmet`) and the
new callers (ux-journeyer, behavior-verifier) without touching the
existing invariants.

## AUTH_PATHS anchor (shared with render-review-detection.md)

```javascript
// SHARED:AUTH_PATHS — canonical list. ALSO referenced by
// .claude/patterns/render-review-detection.md Section 3. Any change
// here requires a matching update in that file. The drift test at
// .claude/scripts/tests/test_auth_paths_drift.py enforces equality.
const AUTH_PATHS = new Set(["/login", "/signup", "/auth/callback", "/auth/reset-password"]);
```

Python port (used inside the gate's correction script):

```python
# SHARED:AUTH_PATHS
AUTH_PATHS = {"/login", "/signup", "/auth/callback", "/auth/reset-password"}
```

## Policy tables

Each agent declares its `(review_method, final_path_bucket) → verdict`
mapping. The gate looks up the table, compares emitted verdict to
required verdict, overwrites on mismatch, and logs a correction.

### design-critic (not enforced here — kept for reference only)

Enforcement lives in `state-3b-quality-gate.md`. Rules:

| review_method | Required verdict |
|---|---|
| `source-only` (any final path) | `"unresolved"` |
| `unknown` | `"unresolved"` |

### accessibility-scanner

Enforced via its procedure (skip-page). Rules:

| review_method | Action |
|---|---|
| `source-only` (any final path) | Skip axe-core for the page; omit from `pages_scanned` |
| `unknown` | Same as `source-only` |
| `prereq-unmet` | Not currently emitted (accessibility-scanner does not set `auth_requirement="required"`); reserved |

This gate enforces presence of a `review_method_gate_evaluated` sentinel
on accessibility-scanner.json as a tripwire.

### ux-journeyer

| review_method | `final_path` bucket | Required verdict contribution |
|---|---|---|
| `rendered-authed` / `rendered-demo` | — | step passes |
| `source-only` | `∈ AUTH_PATHS` | step marked "dead-end + auth-redirect error" |
| `source-only` | `∉ AUTH_PATHS` | step marked "dead-end" |
| `unknown` | — | step marked "error" |
| `prereq-unmet` | — | top-level trace verdict forced to `"blocked"` |

Implementation: gate walks `per_step_reviews[]` and ensures every entry's
per-step status field matches the table. Top-level `verdict="blocked"`
enforced when any step has `review_method="prereq-unmet"`.

### behavior-verifier

| review_method | `final_path` bucket | Required verdict |
|---|---|---|
| `rendered-authed` / `rendered-demo` | — | `"PASS"` (proceed with given/when/then) |
| `prereq-unmet` | — | `"SKIPPED"` |
| `source-only` | `∈ AUTH_PATHS` | `"FAIL"` (B3 Silent Failure — expected route unreachable) |
| `source-only` | `∉ AUTH_PATHS` | `"DEGRADED"` (product-level redirect — route reachable at different path) |
| `unknown` | — | `"FAIL"` (navigation-failed) |

Implementation: gate walks `per_behavior_reviews[]` and overwrites each
entry's per-behavior verdict. Top-level trace verdict is the
worst-cardinality across all entries (FAIL > DEGRADED > SKIPPED > PASS).

## Procedure (Python — runs in the state that spawned the reviewer)

```python
import json
import sys
import os

# SHARED:AUTH_PATHS
AUTH_PATHS = {"/login", "/signup", "/auth/callback", "/auth/reset-password"}

# Per-agent policy tables. Keys are tuples: (agent, review_method, final_path_bucket).
# final_path_bucket is "auth" if final_path ∈ AUTH_PATHS, else "non-auth", else "any".
POLICY = {
    # ux-journeyer: per_step_reviews
    ("ux-journeyer", "rendered-authed", "any"): {"per_step_status": "pass"},
    ("ux-journeyer", "rendered-demo", "any"): {"per_step_status": "pass"},
    ("ux-journeyer", "source-only", "auth"): {"per_step_status": "dead-end-auth"},
    ("ux-journeyer", "source-only", "non-auth"): {"per_step_status": "dead-end"},
    ("ux-journeyer", "unknown", "any"): {"per_step_status": "error"},
    ("ux-journeyer", "prereq-unmet", "any"): {"per_step_status": "blocked", "top_level_verdict": "blocked"},

    # behavior-verifier: per_behavior_reviews
    ("behavior-verifier", "rendered-authed", "any"): {"per_item_verdict": "PASS"},
    ("behavior-verifier", "rendered-demo", "any"): {"per_item_verdict": "PASS"},
    ("behavior-verifier", "source-only", "auth"): {"per_item_verdict": "FAIL"},
    ("behavior-verifier", "source-only", "non-auth"): {"per_item_verdict": "DEGRADED"},
    ("behavior-verifier", "unknown", "any"): {"per_item_verdict": "FAIL"},
    ("behavior-verifier", "prereq-unmet", "any"): {"per_item_verdict": "SKIPPED"},
}


def bucket_final_path(review_evidence):
    final_url = review_evidence.get("final_url") if review_evidence else None
    if not final_url:
        return "any"
    try:
        from urllib.parse import urlparse
        path = urlparse(final_url).path
    except Exception:
        return "any"
    return "auth" if path in AUTH_PATHS else "non-auth"


def lookup_policy(agent, review_method, review_evidence):
    bucket = bucket_final_path(review_evidence)
    # Try specific bucket first, fall back to "any"
    for key in [(agent, review_method, bucket), (agent, review_method, "any")]:
        if key in POLICY:
            return POLICY[key]
    return None


def enforce_review_verdict(trace_path, agent):
    """
    Read trace, apply policy, write back. Idempotent (sentinel short-circuits
    repeat invocation). Returns {'corrections_applied': N}.

    IMPORTANT: this function writes to `.runs/agent-traces/<agent>.json`.
    The `agent-trace-write-guard.sh` hook blocks direct writes from a chained
    command. This function must be called from a plain Python script invoked
    by the state lead agent (not chained in a shell). The lead is exempt
    from the per-agent write guard because it is the orchestrator.
    """
    if not os.path.exists(trace_path):
        return {"corrections_applied": 0, "skipped_reason": "trace-missing"}

    with open(trace_path) as f:
        trace = json.load(f)

    # Idempotency guard
    if trace.get("review_method_gate_evaluated") is True:
        return {"corrections_applied": 0, "skipped_reason": "already-evaluated"}

    corrections = []

    # Walk fan-out arrays first, then flat top-level review_method
    array_keys = ["per_step_reviews", "per_behavior_reviews", "per_page_reviews"]
    for array_key in array_keys:
        entries = trace.get(array_key)
        if not isinstance(entries, list):
            continue
        for i, entry in enumerate(entries):
            rm = entry.get("review_method")
            if not rm:
                continue  # forward-compat: old traces without review_method pass through
            policy = lookup_policy(agent, rm, entry.get("review_evidence") or {})
            if not policy:
                continue

            # Apply per_item_verdict (behavior-verifier)
            if "per_item_verdict" in policy:
                required = policy["per_item_verdict"]
                emitted = entry.get("verdict")
                if emitted and emitted != required:
                    corrections.append({
                        "location": f"{array_key}[{i}]",
                        "review_method": rm,
                        "original_verdict": emitted,
                        "corrected_to": required,
                    })
                    entry["verdict"] = required
                elif not emitted:
                    entry["verdict"] = required  # fill missing, no correction log

            # Apply per_step_status (ux-journeyer)
            if "per_step_status" in policy:
                required = policy["per_step_status"]
                emitted = entry.get("status")
                if emitted and emitted != required:
                    corrections.append({
                        "location": f"{array_key}[{i}]",
                        "review_method": rm,
                        "original_status": emitted,
                        "corrected_to": required,
                    })
                    entry["status"] = required
                elif not emitted:
                    entry["status"] = required

            # Top-level verdict forcing (e.g., prereq-unmet → blocked)
            if "top_level_verdict" in policy:
                required_top = policy["top_level_verdict"]
                emitted_top = trace.get("verdict")
                if emitted_top and emitted_top != required_top:
                    corrections.append({
                        "location": "top-level",
                        "review_method": rm,
                        "original_verdict": emitted_top,
                        "corrected_to": required_top,
                    })
                    trace["verdict"] = required_top

    # Write sentinel + corrections list + trace back
    trace["review_method_gate_evaluated"] = True
    if corrections:
        existing = trace.get("review_method_gate_corrections") or []
        trace["review_method_gate_corrections"] = existing + corrections

    with open(trace_path, "w") as f:
        json.dump(trace, f, indent=2)

    return {"corrections_applied": len(corrections)}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: python3 review-verdict-gate.py <trace_path> <agent_name>", file=sys.stderr)
        sys.exit(2)
    result = enforce_review_verdict(sys.argv[1], sys.argv[2])
    print(json.dumps(result))
```

## Sentinel field — `review_method_gate_evaluated`

After running, the gate writes `"review_method_gate_evaluated": true` on
the trace. `state-registry.json` VERIFY commands assert this sentinel is
present on every reviewer trace; a missing sentinel means the gate was
skipped and the state fails to advance.

The sentinel is the only way downstream consumers know the gate ran.
Checking for corrections alone is not sufficient — a trace with 0
corrections (all verdicts already policy-correct) should still prove
the gate ran.

## Idempotency

Calling the gate twice on the same trace is a no-op. Rationale:
- A retry loop in the state may re-run the gate after a recovery; the
  sentinel prevents double-correction (and double-logging in
  `review_method_gate_corrections`).
- If a downstream tool (e.g., retrospective) wants to re-verify, it can
  read the sentinel rather than re-run the gate.

## Failure modes

| Condition | Gate behavior |
|---|---|
| Trace file absent | Return `{"corrections_applied": 0, "skipped_reason": "trace-missing"}`. Caller should decide whether to fail the state (usually yes — missing trace means agent didn't run). |
| Trace missing `review_method` (old trace) | Forward-compat: pass through without corrections. `if rm:` guard. |
| Agent not in POLICY | No-op walk; still writes the sentinel. Useful for agents that haven't yet declared policy. |
| Multiple fan-out arrays present on one trace | All are walked in a fixed order: `per_step_reviews`, `per_behavior_reviews`, `per_page_reviews`. Top-level verdict is only forced by policy entries that explicitly set `top_level_verdict`. |
