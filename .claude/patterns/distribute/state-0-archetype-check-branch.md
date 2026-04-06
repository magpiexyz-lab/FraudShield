# STATE 0: ARCHETYPE_CHECK_BRANCH

**PRECONDITIONS:**
- Git repository exists in working directory
- Current branch is `main` (or resuming on existing `chore/distribute*` branch)

**ACTIONS:**

Read the archetype file at `.claude/archetypes/<type>.md` (type from experiment.yaml, default `web-app`). Resolve surface type per the archetype's capabilities (REF: `.claude/patterns/archetype-behavior-check.md`): if `stack.surface` is set in experiment.yaml, use it. Otherwise infer from archetype and stack configuration — `none` (pure API/CLI with no surface), `detached` (excluded hosting), or `co-located` (hosting present). If surface is `none`, stop **before creating a branch**: "The /distribute skill generates ad campaigns that drive traffic to a surface page. No surface is configured. Options: (1) add `stack.surface: co-located` or `detached` to experiment.yaml, then run `make clean && /bootstrap` to rebuild with the surface enabled (warning: `make clean` deletes all generated code — commit or back up your work first), then run `/distribute`; or (2) distribute manually — for CLI tools: `npm publish` to npm registry, GitHub Releases for binaries, Homebrew for macOS; for services: API marketplace listings, documentation links, or direct outreach. See the archetype file for details."

If surface ≠ none: verify the surface stack file exists at `.claude/stacks/surface/<surface_type>.md`. If missing, stop: "Surface type resolved to `<surface_type>`, but the stack file `.claude/stacks/surface/<surface_type>.md` does not exist. Set `stack.surface` explicitly in experiment.yaml to one of: `none`, `co-located`, `detached`." Then proceed regardless of archetype. Follow `.claude/patterns/branch.md`. Branch: `chore/distribute`.

Parse `$ARGUMENTS` for `--phase 1` or `--phase 2`. If no `--phase` flag is present, default to phase 1. Store the parsed phase value (integer: 1 or 2) for inclusion in the context file.

Create `.runs/distribute-context.json` to initialize state tracking:
```bash
# Parse phase from $ARGUMENTS (default: 1)
PHASE=1
if echo "$ARGUMENTS" | grep -qE '\-\-phase\s+2'; then PHASE=2; fi

cat > .runs/distribute-context.json << CTXEOF
{"skill":"distribute","branch":"$(git branch --show-current)","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","run_id":"distribute-$(date -u +%Y-%m-%dT%H:%M:%SZ)","completed_states":[0],"phase":$PHASE}
CTXEOF
```

**POSTCONDITIONS:**

If surface is `none`: skill has terminated with user guidance. No further states apply. Do not advance state or create context.

If surface ≠ `none`:
- Current branch is `chore/distribute` (or `chore/distribute-N` if prior branch exists)
- Branch is not `main`
- `.runs/distribute-context.json` exists

**VERIFY:**
```bash
if [ ! -f .runs/distribute-context.json ]; then echo "OK"; else git branch --show-current | grep -q 'chore/distribute' && echo "OK" || echo "FAIL"; fi
```

**STATE TRACKING:** After postconditions pass (surface ≠ none only), mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 0
```

**NEXT:** Read [state-1-validate-preconditions.md](state-1-validate-preconditions.md) to continue.
