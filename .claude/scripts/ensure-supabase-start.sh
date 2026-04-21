#!/usr/bin/env bash
# ensure-supabase-start.sh — Start local Supabase and register skill ownership.
#
# This is the recommended entry point for skills (/verify, /change, /bootstrap)
# that need a DB-backed local run. It writes an ownership marker at
# <git-common-dir>/transient-resources.json so that `lifecycle-finalize.sh`
# Step 7 (and `lifecycle-init.sh` Step 0.5 crash recovery) can stop the stack
# without touching a Supabase instance the user started manually.
#
# Behavior:
#   - If supabase is already running when invoked: treat as user-owned
#     unconditionally (no uptime heuristic). Do NOT write a marker.
#   - If supabase is not running: start it, apply migrations, then snapshot
#     (run_id, ancestors_run_ids, project_id, repo_root) into the marker.
#
# Preflight:
#   - Requires supabase/config.toml (equivalent check as make supabase-start)
#   - Requires Docker daemon up
#
# The marker is written under a python3 fcntl.flock advisory lock on
# <git-common-dir>/supabase.lock to serialize concurrent worktrees.

set -euo pipefail

PROJECT_DIR="$(git rev-parse --show-toplevel)"
COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
MARKER="$COMMON_DIR/transient-resources.json"
LOCK="$COMMON_DIR/supabase.lock"

if [[ ! -f "$PROJECT_DIR/supabase/config.toml" ]]; then
  echo "Error: supabase/config.toml not found. Run 'npx supabase init' first (bootstrap does this automatically)." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker daemon is not running." >&2
  exit 1
fi

python3 - "$LOCK" "$PROJECT_DIR" "$MARKER" "$COMMON_DIR" << 'PYEOF'
import datetime
import fcntl
import json
import os
import re
import subprocess
import sys

lock_path = sys.argv[1]
project_dir = sys.argv[2]
marker_path = sys.argv[3]
common_dir = sys.argv[4]

# --- Read project_id from supabase/config.toml ---
conf_path = os.path.join(project_dir, "supabase", "config.toml")
project_id = ""
try:
    with open(conf_path) as f:
        for line in f:
            m = re.match(r'\s*project_id\s*=\s*"?([^"\s]+)"?', line)
            if m:
                project_id = m.group(1)
                break
except Exception as e:
    print(f"Warning: could not read project_id from {conf_path}: {e}", file=sys.stderr)

lf = open(lock_path, "w")
try:
    fcntl.flock(lf, fcntl.LOCK_EX)

    # --- Is supabase already running? ---
    try:
        status = subprocess.run(
            ["npx", "supabase", "status"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        already_running = status.returncode == 0
    except Exception:
        already_running = False

    if already_running:
        print("[ensure-supabase] already running — not claiming ownership (user-owned).", file=sys.stderr)
        sys.exit(0)

    # --- Start supabase + apply migrations ---
    print("[ensure-supabase] starting local Supabase...", file=sys.stderr)
    subprocess.check_call(
        [
            "npx", "supabase", "start",
            "-x", "realtime,storage,imgproxy,inbucket,pgadmin-schema-diff,migra,postgres-meta,studio,edge-runtime,logflare,pgbouncer,vector",
        ],
        cwd=project_dir,
    )
    subprocess.check_call(["npx", "supabase", "db", "reset"], cwd=project_dir)

    # --- Resolve active skill identity via lib-state.sh ---
    lib_path = os.path.join(project_dir, ".claude", "hooks", "lib-state.sh")
    run_id = ""
    ancestors_rids = []
    if os.path.isfile(lib_path):
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = project_dir
        try:
            ident = subprocess.run(
                ["bash", "-c", f"source '{lib_path}' && resolve_active_identity"],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if ident.returncode == 0 and ident.stdout.strip():
                parts = ident.stdout.strip().split("\t")
                if len(parts) >= 4:
                    run_id = parts[1]
                    try:
                        ancestors_rids = [
                            a.get("run_id", "")
                            for a in json.loads(parts[3])
                            if isinstance(a, dict) and a.get("run_id")
                        ]
                    except Exception:
                        ancestors_rids = []
        except Exception as e:
            print(f"Warning: resolve_active_identity failed: {e}", file=sys.stderr)

    # --- Write marker ---
    marker = {}
    if os.path.exists(marker_path):
        try:
            with open(marker_path) as f:
                marker = json.load(f)
        except Exception:
            marker = {}

    marker["supabase"] = {
        "owner": "skill",
        "started_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "run_id": run_id,
        "ancestors_run_ids": ancestors_rids,
        "started_by_script": "ensure-supabase-start.sh",
        "repo_root": project_dir,
        "project_id": project_id,
    }
    with open(marker_path, "w") as f:
        json.dump(marker, f, indent=2)

    print(
        f"[ensure-supabase] started; owner=skill run_id={run_id or '(no active context)'} project_id={project_id or '(unknown)'}",
        file=sys.stderr,
    )

finally:
    try:
        fcntl.flock(lf, fcntl.LOCK_UN)
    except Exception:
        pass
    lf.close()
PYEOF
