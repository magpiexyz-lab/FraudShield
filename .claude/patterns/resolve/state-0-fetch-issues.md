# STATE 0: FETCH_ISSUES

**PRECONDITIONS:**
- Git repository exists in working directory
- GitHub CLI (`gh`) is authenticated

**ACTIONS:**

Determine which issues to resolve:

- If the user specified issue number(s): `gh issue view <N> --json number,title,body,labels,state,comments`
- If the user said "resolve open issues": `gh issue list --state open --limit 20 --json number,title,body,labels`
- If the user said "resolve observations": `gh issue list --label observation --state open --limit 20 --json number,title,body,labels`

- If the user said "--refine" or "refine":

  **Step 1 — Resolve template repo:**
  ```bash
  TEMPLATE_REPO=$(git remote get-url template 2>/dev/null | sed 's|.*github.com[:/]||;s|\.git$||')
  ```
  If empty → stop: "No template remote configured. Run any skill first (STATE 0 auto-configures it), or manually: `git remote add template <url>`."

  **Step 2 — Read GitHub trace issues (team data):**
  ```bash
  gh issue list --repo $TEMPLATE_REPO --label trace --json number,title --limit 50
  ```
  For each trace issue, read comments:
  ```bash
  gh api repos/$TEMPLATE_REPO/issues/<N>/comments --jq '.[].body'
  ```
  Parse each comment body as JSON trace entry (fields: `template_version`, `team_member`, `state_results`, `skill`, `run_id`).
  Fallback: if GitHub unavailable, read local `.runs/verify-history.jsonl`.

  **Step 3 — Read GitHub observation issues:**
  ```bash
  gh issue list --repo $TEMPLATE_REPO --label observation --state open \
    --json number,title,body --limit 50
  ```

  **Step 4 — Per-file staleness filter:**
  For each trace entry's `state_results`, for each `state_id`:
  - Resolve state file path: glob `.claude/patterns/<skill>/state-<id>-*.md`
  - `trace_hash = trace.template_version[state_file_path]`
  - `current_hash = $(git hash-object <state_file_path>)`
  - If `trace_hash != current_hash` → mark "stale" (skip this state's data)
  - If `trace_hash == current_hash` → mark "relevant" (include in analysis)

  For observation issues: do NOT apply file_version hash filtering. All open observations pass through to STATE 2, which performs semantic staleness verification (reads the file, confirms the specific pattern/text described in the issue is gone or fixed). File hash changes may be unrelated to the reported bug.

  Note: staleness is per-file — one trace may have some stale and some relevant states.

  **Step 5 — Compute per-state failure_rate (relevant data only):**
  For each `(skill, state_id)` combination:
  - `total` = count of traces with this state in `state_results`
  - `fails` = count where `state_results[state_id].first_pass == false`
  - If `total < 5` → mark `INSUFFICIENT_DATA`, skip
  - `failure_rate = fails / total`
  - `team_member_count` = count of distinct `team_member` with `first_pass==false`

  **Step 6 — Generate refine issues (failure_rate > 0.10):**
  Severity:
  - `failure_rate > 0.30 AND team_member_count >= 2` → HIGH
  - `failure_rate > 0.10` → MEDIUM
  - else → LOW (not generated as issues)

  For each qualifying state, create a real GitHub issue:
  ```bash
  gh issue create --repo $TEMPLATE_REPO --label refine \
    --title "Refine: <skill>/state-<id> — <rate>% failure rate (n=<total>)" \
    --body "<trace summary, no project-specific content>"
  ```

  **Step 7 — Team Version Report:**
  Print to user:
  ```
  | Member | CLAUDE.md Version | Behind | Known Fixed Issues |
  ```
  Group by `team_member`, use `template_version["CLAUDE.md"]` hash to determine version.

  **Step 8 — Merge issue_list:**
  `issue_list = refine_issues + relevant_observation_issues`

  **Step 9 — Write resolve-context.json:**
  Include `"mode": "refine"` and `trace_summary` dict keyed by `"<skill>/<state_id>"` with `{failure_rate, total, fails, team_members_affected, status}`.

Store the fetched issues as `issue_list`.

Clean stale epilogue artifacts and create context file to initialize state tracking:
```bash
rm -f .runs/observe-result.json
cat > .runs/resolve-context.json << CTXEOF
{"skill":"resolve","branch":"$(git branch --show-current)","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","run_id":"resolve-$(date -u +%Y-%m-%dT%H:%M:%SZ)","completed_states":[0],"issue_list":[]}
CTXEOF
```

**POSTCONDITIONS:**
- `issue_list` is populated with at least one issue
- `.runs/resolve-context.json` exists

**VERIFY:**
```bash
test -f .runs/resolve-context.json && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 0
```

**NEXT:** Read [state-1-read-context.md](state-1-read-context.md) to continue.
