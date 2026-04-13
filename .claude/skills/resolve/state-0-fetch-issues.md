# STATE 0: FETCH_ISSUES

**PRECONDITIONS:**
- Git repository exists in working directory
- GitHub CLI (`gh`) is authenticated

**ACTIONS:**

Determine which issues to resolve:

- If the user specified issue number(s): `gh issue view <N> --json number,title,body,labels,state,comments`
- If the user said "resolve open issues": `gh issue list --state open --search "-label:architecture" --limit 20 --json number,title,body,labels`
- If the user said "resolve observations": `gh issue list --label observation --search "-label:architecture" --state open --limit 20 --json number,title,body,labels`

- If the user said "--refine" or "refine":

  **Step 1 — Resolve template repo:**
  ```bash
  TEMPLATE_REPO="magpiexyz-lab/mvp-template"
  if ! git remote get-url template &>/dev/null; then
    git remote add template https://github.com/magpiexyz-lab/mvp-template.git
  fi
  ```

  **Step 2 — Compute trace analysis (offline):**
  ```bash
  python3 .claude/scripts/refine-analysis.py --repo $TEMPLATE_REPO
  ```
  Read `.runs/refine-analysis.json` — contains `trace_summary`, `team_versions`, and `stats`.
  Fallback: if the script fails or output is missing, read local `.runs/verify-history.jsonl` and compute inline.

  **Step 3 — Read GitHub observation issues:**
  ```bash
  gh issue list --repo $TEMPLATE_REPO --label observation --search "-label:architecture" --state open \
    --json number,title,body --limit 50
  ```

  For observation issues: do NOT apply file_version hash filtering. All open observations pass through to STATE 2, which performs semantic staleness verification (reads the file, confirms the specific pattern/text described in the issue is gone or fixed). File hash changes may be unrelated to the reported bug.

  **Step 4 — Generate refine issues (from trace_summary):**
  Read `trace_summary` from `.runs/refine-analysis.json`. For each entry with status `HIGH` or `MEDIUM`:

  ```bash
  gh issue create --repo $TEMPLATE_REPO --label refine \
    --title "Refine: <skill>/state-<id> — <rate>% failure rate (n=<total>)" \
    --body "<trace summary, no project-specific content>"
  ```

  **Step 5 — Team Version Report:**
  Read `team_versions` from `.runs/refine-analysis.json`. Print to user:
  ```
  | Member | CLAUDE.md Version | Behind | Known Fixed Issues |
  ```

  **Step 6 — Merge issue_list:**
  `issue_list = refine_issues + relevant_observation_issues`

  **Step 7 — Write resolve-context.json:**
  Include `"mode": "refine"` and `trace_summary` from `.runs/refine-analysis.json` (dict keyed by `"<skill>/<state_id>"` with `{failure_rate, total, fails, team_members_affected, status}`).

Store the fetched issues as `issue_list`.

**If `issue_list` is empty after fetching** (all open issues have the `architecture` label
and were excluded by the filter): report to the user:

> All open issues are deferred as architectural. Use `/solve` to address them.
> Run `/resolve #<N>` to force-process a specific architectural issue.

Then write resolve-context.json with empty `issue_list`, advance state 0, and **TERMINAL** —
skill ends. No triage needed, no PR, no further states. (The `_required_states` gate only
applies when a PR is created; with 0 issues there is no PR.)

Merge resolve-specific fields into context:
```bash
bash .claude/scripts/init-context.sh resolve '{"issue_list":[]}'
```

**POSTCONDITIONS:**
- `issue_list` is populated (may be empty if all issues are architecture-labeled — see early termination above)
- `.runs/resolve-context.json` exists

**VERIFY:**
```bash
test -f .runs/resolve-context.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 0
```

**NEXT:** Read [state-1-read-context.md](state-1-read-context.md) to continue.
