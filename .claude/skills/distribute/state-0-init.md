# STATE 0: INIT

**PRECONDITIONS:**
- Git repository exists in working directory
- Current branch is `main` (or resuming on existing `chore/distribute*` branch)

**ACTIONS:**

Read the archetype file at `.claude/archetypes/<type>.md` (type from experiment.yaml, default `web-app`). Resolve surface type per the archetype's capabilities (REF: `.claude/patterns/archetype-behavior-check.md` Compound Dimensions "Surface type resolution" + "Distribute gate"): if `stack.surface` is set in experiment.yaml, use it. Otherwise infer from archetype and stack configuration — `none` (pure API/CLI with no surface), `detached` (excluded hosting), or `co-located` (hosting present). If surface is `none`, check for a manually created deploy manifest at `.runs/deploy-manifest.json`. If the manifest exists and contains a `canonical_url`, read the URL and continue — the user followed `/deploy`'s guidance to create a manual manifest for their surface-less deployment, so `/distribute` should honor that. If the manifest does not exist, stop **before creating a branch**: "The /distribute skill generates ad campaigns that drive traffic to a surface page. No surface is configured. Options: (1) add `stack.surface: co-located` or `detached` to experiment.yaml, then run `make clean && /bootstrap` to rebuild with the surface enabled (warning: `make clean` deletes all generated code — commit or back up your work first), then run `/distribute`; (2) create `.runs/deploy-manifest.json` manually (see `/deploy` output for the schema) if you have a deployed URL, then re-run `/distribute`; or (3) distribute manually — for CLI tools: `npm publish` to npm registry, GitHub Releases for binaries, Homebrew for macOS; for services: API marketplace listings, documentation links, or direct outreach. See the archetype file for details."

If surface ≠ none: verify the surface stack file exists at `.claude/stacks/surface/<surface_type>.md`. If missing, stop: "Surface type resolved to `<surface_type>`, but the stack file `.claude/stacks/surface/<surface_type>.md` does not exist. Set `stack.surface` explicitly in experiment.yaml to one of: `none`, `co-located`, `detached`." Then proceed regardless of archetype. Follow `.claude/patterns/branch.md`. Branch: `chore/distribute`.

Parse `$ARGUMENTS` for `--phase 1` or `--phase 2`. If no `--phase` flag is present, default to phase 1. Store the parsed phase value (integer: 1 or 2) for inclusion in the context file.

Merge distribute-specific fields into context:
```bash
# Parse phase from $ARGUMENTS (default: 1)
PHASE=1
if echo "$ARGUMENTS" | grep -qE '\-\-phase\s+2'; then PHASE=2; fi

bash .claude/scripts/init-context.sh distribute "{\"phase\":$PHASE}"
```

> **Branch cleanup on failure:** Any "stop" below leaves you on a feature branch. Include in the stop message: "To abort: `git checkout main && git branch -D chore/distribute`. To fix and retry: address the prerequisite, then re-run `/distribute`."

1. Verify `experiment/experiment.yaml` exists and is complete. If not, stop: "No experiment found. Create `experiment/experiment.yaml` from the template first, then run `/bootstrap`."
2. Verify `experiment/EVENTS.yaml` exists. If not, stop: "experiment/EVENTS.yaml not found. This file defines all analytics events and is required."
3. Verify `experiment/EVENTS.yaml` contains an `events` key that is a dict (flat map). If not, stop: "experiment/EVENTS.yaml is malformed — the `events` key is missing or not a dict. Run `make validate` to diagnose, or restore the file from the template."
4. Verify `package.json` exists. If not, stop: "No app found. Run `/bootstrap` first to create the app, deploy it, then run `/distribute`."
5. Verify the app is deployed: check `landing_url` in existing `experiment/ads.yaml`, or check `surface_url` (then `canonical_url`) in `.runs/deploy-manifest.json`, or ask the user for the deployed URL. For CLI archetype, the surface URL IS the target URL. If the user does not have a deployed URL, stop: "The app must be deployed before running `/distribute` — ad campaigns need a live surface page. Run `/deploy` first, then re-run `/distribute`."

Write the preconditions artifact:
```bash
python3 -c "
import json
preconditions = {
    'deployed_url': '<url>'
}
json.dump(preconditions, open('.runs/distribute-preconditions.json', 'w'), indent=2)
"
```

**POSTCONDITIONS:**

If surface is `none`: skill has terminated with user guidance. No further states apply. Do not advance state or create context.

If surface ≠ `none`:
- Current branch is `chore/distribute` (or `chore/distribute-N` if prior branch exists)
- Branch is not `main`
- `.runs/distribute-context.json` exists with `phase` field
- `.runs/distribute-preconditions.json` written with field: `deployed_url`

**VERIFY:**
```bash
test -f .runs/distribute-context.json && python3 -c "import json; ctx=json.load(open('.runs/distribute-context.json')); assert 'phase' in ctx, 'phase missing'; assert ctx['phase'] in (1,2), 'phase must be 1 or 2'" && python3 -c "import json; p=json.load(open('.runs/distribute-preconditions.json')); assert p.get('deployed_url')"
```

**STATE TRACKING:** After postconditions pass (surface ≠ none only), mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 0
```

**NEXT:** Read [state-1-config-wizard.md](state-1-config-wizard.md) to continue.
