# STATE 3: FILE_ISSUE

**PRECONDITIONS:**
- Retro document generated and shown to user (STATE 2 POSTCONDITIONS met)

**ACTIONS:**

### File as GitHub Issue

1. Determine the target repo: use the current repo via `gh repo view --json nameWithOwner --jq '.nameWithOwner'`. If `gh` is not available or the command fails, ask the user: "Where should I file this retro? Enter a repo in `owner/repo` format, or say 'skip' to print it to the terminal instead."
2. If the user says "skip", print the retro to the terminal and stop.

File the issue:
```
gh issue create \
  --title "Retro: <experiment-name> -- <outcome>" \
  --label "retro" \
  --body "<structured retro content>"
```

### Error Handling
- If `gh issue create` fails with a label error (e.g., label "retro" doesn't exist): retry **without** the `--label "retro"` flag. The user may not have triage permissions to create labels.
- If `gh issue create` fails for any other reason: show the full error message and suggest:
  - Check GitHub authentication: `gh auth status`
  - Try filing manually by copying the retro content above
- If the issue is created successfully, show the issue URL.

### Q-score

Compute retro quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.claude/runs/retro-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
python3 .claude/scripts/write-q-score.py \
  --skill retro --scope retro --archetype N/A \
  --gate 1.0 --dims '{"sections": 1.0, "completion": 1.0}' \
  --run-id "$RUN_ID" || true
```

### Next steps

After filing the retro, guide the user:
- If the archetype is `web-app` or `service` and cloud infrastructure was deployed: "If you're done with this experiment, run `/teardown` to remove cloud resources (Vercel, Supabase, etc.)."
- If the archetype is `cli` and `surface` is `none` (or no surface was deployed): "CLI tools with no surface have no cloud infrastructure to tear down. If you want to unpublish the npm package, run `npm unpublish <name>` (within 72 hours of publish) or deprecate it with `npm deprecate <name> \"Experiment concluded\"`."
- If the archetype is `cli` and `surface` is `detached` or `co-located` (default for CLI is `detached`): "Your marketing surface is deployed to cloud infrastructure. Run `/teardown` to remove it. For the npm package, run `npm unpublish <name>` (within 72 hours of publish) or deprecate it with `npm deprecate <name> \"Experiment concluded\"`."
- For all archetypes: "Your source code, experiment.yaml, and experiment history are preserved on the main branch."

**POSTCONDITIONS:**
- GitHub issue filed (or user chose to skip)
- Issue URL shown to user (if filed)
- Next steps guidance provided

**VERIFY:**
```bash
echo "Retro issue filed (or skipped) and next steps provided"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh retro 3
```

**NEXT:** Read [state-4-skill-epilogue.md](state-4-skill-epilogue.md) to continue.
