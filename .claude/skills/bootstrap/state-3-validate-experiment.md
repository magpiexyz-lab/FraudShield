# STATE 3: VALIDATE_EXPERIMENT

**PRECONDITIONS:**
- Archetype and stack resolved (STATE 2 POSTCONDITIONS met)
- All stack files and archetype file are in context

**ACTIONS:**

- Every one of these fields must be present and non-empty (strings must be non-blank, lists must have at least one item): `name`, `owner`, `type`, `description`, `thesis`, `target_user`, `distribution`, `behaviors`, `stack`, plus fields from the archetype's `required_experiment_fields` (e.g., `golden_path` for web-app, `endpoints` for service)
- If ANY field still contains "TODO" or is missing: stop, list exactly which fields need to be filled in, and do nothing else
- If the archetype requires pages (web-app): verify `golden_path` includes at least one entry with `page: landing`
- If the archetype requires `endpoints` (service): verify `endpoints` is a non-empty list
- If the archetype requires `commands` (cli): verify `commands` is a non-empty list
- Verify `name` is lowercase with hyphens only (no spaces, no uppercase)
- For each category in the archetype's `excluded_stacks` list: if that category is present in experiment.yaml `stack`, stop and tell the user: "The `<archetype>` archetype excludes `<category>`. Remove `<category>: <value>` from your experiment.yaml `stack` section, or switch to a different archetype."
- For each category in the archetype's `required_stacks` list: verify the category is present in experiment.yaml `stack`. Per-service categories (`framework`, `hosting`, `ui`, `testing`) map to `stack.services[]` keys (`runtime` for framework, others by name). Shared categories (`database`, `auth`, `analytics`, `payment`, `email`) map to `stack.<category>`. If a required category is missing, stop and tell the user: "The `<archetype>` archetype requires `<category>`. Add it to your experiment.yaml `stack` section — shared categories go at the top level (e.g., `database: supabase`), per-service categories go under `stack.services[]` (e.g., `hosting: vercel` under a service entry)."
- Validate stack dependencies per `patterns/stack-dependency-validation.md` — read the Dependency Matrix, Compatibility Constraints, and Error Message Templates sections. Use the canonical error messages from that file for all stop messages. Key checks: payment requires auth+database; email requires auth+database; auth_providers requires auth; playwright incompatible with service/cli.
  - Validate framework-archetype compatibility: web-app requires nextjs; cli requires commander
- Verify `stack.testing` is present. If absent: stop — "Testing framework required. Add `testing: playwright` (web-app) or `testing: vitest` (service/cli) to experiment.yaml `stack` and re-run `/bootstrap`."
- If `stack.auth_providers` is present:
  - Verify it is a non-empty list of strings. If empty: stop — "auth_providers is empty. Either add providers (e.g., `[google, github]`) or remove the field."
  - Warn (don't stop) for unrecognized slugs — Supabase may add new providers.
- If `variants` is present in experiment.yaml and the archetype is NOT `web-app`: stop — "Variants (A/B landing page testing) are only supported for the web-app archetype. Remove the `variants` field from experiment.yaml, or switch to `type: web-app`."
- If `variants` is present in experiment.yaml, validate the variants list:
  - Must be a list with at least 2 entries (testing 1 variant = no variants — tell the user to remove the field)
  - Each variant must have: `slug`, `headline`, `subheadline`, `cta`, `pain_points` (all non-empty)
  - Each `slug` must be lowercase, start with a letter, and use only a-z, 0-9, hyphens
  - Slugs must be unique across all variants
  - No slug may collide with a page name from `golden_path`
  - `pain_points` must have exactly 3 items per variant
  - If any validation fails: stop and list the specific errors

- **Write validation trace artifact** (`.runs/bootstrap-validation-trace.json`):
  ```bash
  python3 -c "
  import json
  trace = {
      'experiment_valid': True,
      'checks_passed': ['name', 'hypothesis', 'behaviors', 'golden_path', 'stack'],
      'warnings': []  # any non-blocking warnings
  }
  json.dump(trace, open('.runs/bootstrap-validation-trace.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- All required fields present and non-empty <!-- enforced by agent behavior, not VERIFY gate -->
- `name` matches `^[a-z][a-z0-9-]*$` <!-- enforced by agent behavior, not VERIFY gate -->
- No TODO values remain <!-- enforced by agent behavior, not VERIFY gate -->
- Archetype-specific fields validated <!-- enforced by agent behavior, not VERIFY gate -->
- Stack dependency rules satisfied (payment->auth+db, email->auth+db) <!-- enforced by agent behavior, not VERIFY gate -->
- Quality/testing dependency satisfied if applicable <!-- enforced by agent behavior, not VERIFY gate -->
- Variant structure valid if applicable <!-- enforced by agent behavior, not VERIFY gate -->
- `.runs/bootstrap-validation-trace.json` exists with `experiment_valid` field

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/bootstrap-validation-trace.json')); assert d.get('experiment_valid') is True, 'experiment_valid is %s' % d.get('experiment_valid')"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 3
```

**NEXT:** Read [state-3a-bg1-gate.md](state-3a-bg1-gate.md) to continue.
