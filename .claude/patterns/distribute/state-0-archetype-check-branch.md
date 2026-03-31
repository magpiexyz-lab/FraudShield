# STATE 0: ARCHETYPE_CHECK_BRANCH

**PRECONDITIONS:**
- Git repository exists in working directory
- Current branch is `main` (or resuming on existing `chore/distribute*` branch)

**ACTIONS:**

Read the archetype file at `.claude/archetypes/<type>.md` (type from experiment.yaml, default `web-app`). Resolve surface type: if `stack.surface` is set in experiment.yaml, use it. Otherwise infer: if the archetype is `service` and the experiment defines no `golden_path` and no endpoints that serve HTML (pure API with no user-facing surface), infer `none`; if the archetype's `excluded_stacks` includes `hosting`, infer `detached`; if the archetype is `service` or `web-app`, check `stack.services[0].hosting` — present → `co-located`; absent → `detached`. If surface is `none`, stop **before creating a branch**: "The /distribute skill generates ad campaigns that drive traffic to a surface page. No surface is configured. Options: (1) add `stack.surface: co-located` or `detached` to experiment.yaml, run `/bootstrap` to generate the surface page, then run `/distribute`, or (2) distribute manually — for CLI tools: `npm publish` to npm registry, GitHub Releases for binaries, Homebrew for macOS; for services: API marketplace listings, documentation links, or direct outreach. See the archetype file for details."

If surface ≠ none, proceed regardless of archetype. Follow `.claude/patterns/branch.md`. Branch: `chore/distribute`.

Create `.claude/runs/distribute-context.json` to initialize state tracking:
```bash
cat > .claude/runs/distribute-context.json << CTXEOF
{"skill":"distribute","branch":"$(git branch --show-current)","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","run_id":"distribute-$(date -u +%Y-%m-%dT%H:%M:%SZ)","completed_states":[0]}
CTXEOF
```

**POSTCONDITIONS:**
- Current branch is `chore/distribute` (or `chore/distribute-N` if prior branch exists)
- Branch is not `main`
- `.claude/runs/distribute-context.json` exists

**VERIFY:**
```bash
git branch --show-current | grep -q 'chore/distribute' && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 0
```

**NEXT:** Read [state-1-validate-preconditions.md](state-1-validate-preconditions.md) to continue.
