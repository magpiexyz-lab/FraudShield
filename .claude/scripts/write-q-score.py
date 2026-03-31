#!/usr/bin/env python3
"""Shared Q-score writer — consolidates all Q computation and storage.

Usage (compute mode):
  python3 .claude/scripts/write-q-score.py \
    --skill <name> --scope <scope> --archetype <arch> \
    --gate <0|1> --dims '{"dim1": 0.9}' \
    [--r-human <float>] [--run-id <id>] \
    [--build-attempts N] [--fix-log-entries N] \
    [--hard-gate-failure] [--process-violation] \
    [--overall-verdict pass|fail]

Usage (raw mode — pre-built entry):
  python3 .claude/scripts/write-q-score.py --raw '{"skill":"verify",...}'

Exit 0 always — never blocks the caller.
"""
import argparse
import datetime
import json
import os
import sys


def compute_q(gate, dimension_scores, r_human=0.0):
    """Q_skill = Gate * (1 - R), R = 0.3 * R_system + 0.7 * R_human."""
    active = list(dimension_scores.values())
    r_system = round(1 - (sum(active) / max(len(active), 1)), 3) if active else 0.0
    r = round(0.3 * r_system + 0.7 * r_human, 3)
    q_skill = round(gate * (1 - r), 3)
    return q_skill, r_system, r


def write_entry(entry):
    """Write entry to verify-history.jsonl via pluggable backend."""
    backend = os.environ.get('SKILL_HISTORY_BACKEND', 'local')

    if backend == 'local':
        os.makedirs('.claude/runs', exist_ok=True)
        with open('.claude/runs/verify-history.jsonl', 'a') as f:
            f.write(json.dumps(entry) + '\n')
        print(f"Q-score: {entry['q_skill']} (Gate={entry['gate']}, R={entry.get('r_system', 0)}) "
              f"— appended to verify-history.jsonl")

    elif backend == 'api':
        import urllib.request
        endpoint = os.environ.get('SKILL_HISTORY_ENDPOINT', '')
        if endpoint:
            req = urllib.request.Request(
                endpoint,
                data=json.dumps(entry).encode(),
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            try:
                urllib.request.urlopen(req, timeout=5)
                print(f"Q-score: {entry['q_skill']} — sent to {endpoint}")
            except Exception as e:
                # Fallback to local on API failure
                os.makedirs('.claude/runs', exist_ok=True)
                with open('.claude/runs/verify-history.jsonl', 'a') as f:
                    f.write(json.dumps(entry) + '\n')
                print(f"Q-score: {entry['q_skill']} — API failed ({e}), fell back to local")
        else:
            # No endpoint configured, fall back to local
            os.makedirs('.claude/runs', exist_ok=True)
            with open('.claude/runs/verify-history.jsonl', 'a') as f:
                f.write(json.dumps(entry) + '\n')
            print(f"Q-score: {entry['q_skill']} — no API endpoint, fell back to local")

    else:
        print(f"Q-score: {entry['q_skill']} (tracking disabled)")


def main():
    parser = argparse.ArgumentParser(description='Compute and record Q-score')
    parser.add_argument('--raw', type=str, help='Pre-built entry JSON (raw mode)')
    parser.add_argument('--skill', type=str)
    parser.add_argument('--scope', type=str)
    parser.add_argument('--archetype', type=str, default='N/A')
    parser.add_argument('--gate', type=float, default=1.0)
    parser.add_argument('--dims', type=str, default='{}')
    parser.add_argument('--r-human', type=float, default=0.0)
    parser.add_argument('--run-id', type=str, default='')
    parser.add_argument('--build-attempts', type=int, default=0)
    parser.add_argument('--fix-log-entries', type=int, default=0)
    parser.add_argument('--hard-gate-failure', action='store_true')
    parser.add_argument('--process-violation', action='store_true')
    parser.add_argument('--overall-verdict', type=str, default='pass')
    args = parser.parse_args()

    # Raw mode: write pre-built entry directly
    if args.raw:
        entry = json.loads(args.raw)
        write_entry(entry)
        return

    # Compute mode: calculate Q and build entry
    dims = json.loads(args.dims)
    q_skill, r_system, r = compute_q(args.gate, dims, args.r_human)

    ts = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    run_id = args.run_id if args.run_id else f"{args.skill}-{ts}"

    entry = {
        'timestamp': ts,
        'run_id': run_id,
        'skill': args.skill,
        'scope': args.scope or args.skill,
        'archetype': args.archetype,
        'build_attempts': args.build_attempts,
        'fix_log_entries': args.fix_log_entries,
        'hard_gate_failure': args.hard_gate_failure,
        'process_violation': args.process_violation,
        'overall_verdict': args.overall_verdict,
        'dimension_scores': dims,
        'gate': args.gate,
        'r_system': r_system,
        'r_human': args.r_human,
        'q_skill': q_skill,
    }

    write_entry(entry)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"Q-score: warning — scoring failed ({e})", file=sys.stderr)
        sys.exit(0)  # Never block the caller
