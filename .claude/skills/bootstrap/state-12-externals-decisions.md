# STATE 12: EXTERNALS_DECISIONS

**PRECONDITIONS:**
- Scaffold done, all subagents returned (STATE 11b POSTCONDITIONS met)
- Externals classification table available from scaffold-externals

**ACTIONS:**

> **BLOCKING -- present to user even if classification seems obvious.**
> The purpose is explicit user buy-in on external dependencies, not
> efficiency. Even if scaffold-externals reports "No external
> dependencies", confirm to the user: "No external dependencies
> detected. Proceeding." NEVER self-decide. NEVER skip this interaction.

After the externals subagent returns its classification table:

1. **Present classification to user**: show the core/non-core table and
   collect decisions (Fake Door / Skip / Full Integration / Provide now /
   Provision at deploy) for each dependency.
2. **Collect credentials**: for "Provide now" choices, ask the user for
   credential values.
3. **Execute remaining work** -- explicit externals checklist:

   For each decision where `user_choice` is one of {Provide now, Provision at deploy, Full Integration}:
   - [ ] Generate `.claude/stacks/external/<service-slug>.md` using the external stack file
         template (service name, classification, required env vars, integration notes)
   - [ ] Run `python3 .claude/scripts/validate-frontmatter.py .claude/stacks/external/<service-slug>.md`
         to verify frontmatter is well-formed
   - [ ] Add env var guard: create or update the relevant API route to return 503 with
         `{ error: "<service> not configured" }` when the required env var is missing
   - [ ] Update `.env.example` with the new env var(s) and descriptive comments

   Additional steps by decision type:
   - **Provide now**: write user-provided credential values to `.env.local`
   - **Provision at deploy**: add placeholder values to `.env.example` with
     `# Set during deployment` comment; add to `.env.local` as empty strings
   - **Full Integration**: write credentials to `.env.local`, verify integration
     with a smoke check (e.g., import succeeds, env var is non-empty at runtime)

   After all externals are processed: create Fake Door entries (see below).

If the externals subagent reported "No external dependencies", confirm
to the user and proceed.

### Fake Door Integration

If the externals analysis reported Fake Door features, the bootstrap lead
creates them directly:

For each Fake Door feature, generate a component in the page folder where the
feature would naturally appear (e.g., `src/app/dashboard/sms-fake-door.tsx`):
- Real, polished UI using shadcn components (Card + Button + Dialog), following `.claude/patterns/design.md`
- On button click: `track("activate", { action: "[feature-name]", fake_door: true })`
- Shows a Dialog: "[Feature Name] is coming soon -- we're building this now."
- Import and render the Fake Door component in the parent page where the feature would naturally live
- The component should look like a real feature entry point -- not a placeholder or disabled button

**Fake Door VERIFY**: For each Fake Door component created:
- Confirm the file is in `src/app/<page>/` (NOT in `src/components/`)
- Confirm the parent page imports and renders the component
- If either check fails, move/fix the component immediately

Check off in `.runs/current-plan.md`:
- `- [x] Externals user decisions collected`

Write the externals decisions to disk as a durable artifact:
```bash
cat > externals-decisions.json << 'EXTEOF'
{
  "has_externals": <true|false>,
  "user_confirmed": true,
  "decisions": [<array of {"service","feature","classification","user_choice"}>],
  "fake_doors": [<array of {"feature","service","target_page","component_name","component_export_name","action_label"}>],
  "timestamp": "<ISO 8601>"
}
EXTEOF
```
If no external dependencies: `has_externals` is `false`, arrays are `[]`.

**BG2.5 Externals Gate**: Spawn the `gate-keeper` agent (`subagent_type: gate-keeper`). Pass: "Execute BG2.5 Externals Gate. Verify: (1) externals-decisions.json exists with correct structure (has_externals, user_confirmed, decisions, fake_doors, timestamp); (2) for each decision where user_choice is 'Provide now', 'Provision at deploy', or 'Full Integration': .env.example contains the required env var(s); (3) for each such decision: grep the relevant API route file for a 503 response guard referencing the service's env var — BLOCK if any route is missing the guard."

Check off in `.runs/current-plan.md`: `- [x] BG2.5 Externals Gate passed`

**POSTCONDITIONS:**
- BG2.5 Externals Gate verdict is PASS
- User decisions collected for all external dependencies
- Fake Door components created (if any)
- Env vars written (if any)

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/gate-verdicts/bg2.5.json')); assert d.get('verdict')=='PASS', 'BG2.5 verdict is %s' % d.get('verdict'); assert d.get('timestamp','')!='', 'timestamp empty'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 12
```

**NEXT:** Read [state-13-merged-validation.md](state-13-merged-validation.md) to continue.
