---
description: "Verify PostHog tracking is correctly configured before paid ads launch. Run after /deploy, before manually creating a Google Ads campaign."
type: analysis-only
reads: []
stack_categories: []
requires_approval: false
references:
  - .claude/stacks/analytics/posthog.md
branch_prefix: ""
modifies_specs: false
---
Verify PH/DB/Vercel/Stripe setup is ads-ready. $ARGUMENTS

Optional flags (parsed from $ARGUMENTS):
- `--static-only`: skip Layer B (live smoke test) -- dev-iteration mode only
- `--url <URL>`: override Vercel auto-detect for Layer B target

## Lifecycle

1. Parse `$ARGUMENTS` for `--static-only` and `--url <URL>` flags using a small bash block in this dispatcher:
   ```bash
   STATIC_ONLY=false
   DEPLOY_URL=""
   for arg in $ARGUMENTS; do
     case "$arg" in
       --static-only) STATIC_ONLY=true ;;
       --url) DEPLOY_URL_NEXT=1 ;;
       *) if [ "${DEPLOY_URL_NEXT:-}" = "1" ]; then DEPLOY_URL="$arg"; DEPLOY_URL_NEXT=0; fi ;;
     esac
   done
   ```
2. Run `bash .claude/scripts/lifecycle-init.sh ads-ready`.
3. Inject flags into the context via the canonical helper. State 1 always runs and short-circuits internally based on `static_only`; `skip_states` is intentionally not used here.
   ```bash
   PAYLOAD=$(python3 -c "
   import json
   print(json.dumps({
       'static_only': '$STATIC_ONLY' == 'true',
       'deploy_url': '$DEPLOY_URL' or None,
   }))
   ")
   bash .claude/scripts/init-context.sh ads-ready "$PAYLOAD"
   ```
4. State execution loop:
   a. Run: `NEXT=$(bash .claude/scripts/lifecycle-next.sh ads-ready)`
   b. If NEXT is "FINALIZE" -> skill complete
   c. If NEXT does not start with "/" -> STOP with error (print NEXT for diagnosis)
   d. Read the state file at $NEXT and execute its ACTIONS section
   e. After ACTIONS complete, run the state's STATE TRACKING command
      (the `bash .claude/scripts/advance-state.sh` call in the state file)
   f. Return to step 4a

## Do NOT
- Modify any code files -- this skill is analysis-only
- Create branches or PRs
- Auto-fix detected issues -- operators or `/change` own the fix
