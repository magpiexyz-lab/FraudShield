# STATE 3: IMPLEMENT_AND_VERIFY

**PRECONDITIONS:**
- Analytics validated (STATE 2 POSTCONDITIONS met)

**ACTIONS:**

### 3a: UTM capture on landing page

- Read the analytics stack file (`.claude/stacks/analytics/<value>.md`) to understand the tracking API
- Ensure `visit_landing` event captures `utm_source`, `utm_medium`, `utm_campaign` from URL params
- experiment/EVENTS.yaml has these as optional properties on `visit_landing` — the surface must parse them from URL params and pass them to the tracking call
- **Idempotent**: If UTM capture already exists in the landing page file (grep for `utm_source`), skip this step
- **web-app**: parse from `window.location.search` in the landing page component
- **service (co-located)**: parse from the request URL in the root route handler and embed in the HTML response's tracking script
- **cli (detached) or service (detached)**: add an inline `<script>` in `site/index.html` that parses `window.location.search` and fires the tracking call via the analytics snippet

- When experiment.yaml has `variants`, also capture `utm_content` from URL params alongside UTM params. This maps to the variant slug and enables per-variant attribution in analytics (e.g., filter `visit_landing` by `utm_content = "speed"` to see paid traffic for the speed variant).

### 3a.5: UTM capture on sitelink destination pages

Read `golden_path` from `experiment/experiment.yaml`. For each non-landing page in the golden_path that has a user-facing route:

- **web-app**: Check if the page's route file (e.g., `src/app/{page}/page.tsx`) captures UTM parameters. If not, wire UTM + click ID capture using the same pattern as step 3a (parse `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` from URL params and include in the page's analytics event).
- **Idempotent**: If the page already captures `utm_source` (grep the page file), skip it.
- **Anchor sitelinks**: No action needed — anchor sitelinks land on the same landing page, which already has UTM capture from step 3a. The `utm_content` parameter distinguishes sitelink traffic.

> **Note:** This step runs before ads.yaml is generated (state 3 precedes state 4). It wires UTM capture for all golden_path pages preemptively, not just sitelink-specific ones. The sitelink pages are a subset — this ensures any page a sitelink might point to is ready for attribution tracking.

### 3b: Add click ID capture

- Read the selected channel's stack file "Click ID" section to get the parameter name (e.g., `gclid` for google-ads, `twclid` for twitter, `rdt_cid` for reddit)
- Capture the channel's click ID from URL params on landing page load alongside UTM params
- Store the value as the generic `click_id` property in the `visit_landing` analytics event (experiment/EVENTS.yaml defines `click_id` as an optional property)
- Also capture `gclid` separately for backward compatibility (it remains an optional property on `visit_landing`)
- This enables conversion attribution in the channel's ad platform
- **Idempotent**: If click ID capture already exists (grep for the channel's click ID param name), skip this step

### 3c: Feedback widget (post-activation)

Add `feedback_submitted` to experiment/EVENTS.yaml `events` map:

```yaml
  feedback_submitted:
    funnel_stage: activate
    trigger: User submits post-activation feedback widget
    properties:
      source:
        type: string
        required: false
        description: "How the user found the product (e.g., google, friend, social)"
      feedback:
        type: string
        required: false
        description: Free-text feedback from the user
      activation_action:
        type: string
        required: true
        description: What activation action preceded this (from experiment.yaml thesis)
```

**web-app**: Add a `FeedbackWidget` component at `src/components/feedback-widget.tsx`:

- Uses shadcn `Dialog`, `Button`, `Label`, `Textarea`, and `Select` components (read the UI stack file for import conventions)
- Appears after the user completes the activation action (triggered via prop callback)
- Stores "shown" flag in localStorage to show only once per user
- Fires `feedback_submitted` event via `track()` from the analytics library (see analytics stack file for the import path and `track()` usage)
- Fields: "How did you find us?" (select: Google Search, Social Media, Friend/Referral, Other), "Any feedback?" (textarea)
- Non-blocking: user can dismiss without submitting

**service (co-located)**: Add a feedback form section to the root route's HTML response. Use inline HTML form + `<script>` that fires `feedback_submitted` via the analytics snippet. Style with inline CSS — no React/shadcn dependency.

**cli (detached) or service (detached)**: Add a feedback form section to `site/index.html`. Use inline HTML form + `<script>` that fires `feedback_submitted` via the analytics snippet. Style with inline CSS.

**Idempotent**: If the feedback widget already exists (web-app: glob `src/components/*feedback*`; service/cli: grep for `feedback_submitted` in the surface file), skip this step.

### 3d: project_name fix

- Read `project_name_mismatch` from `.runs/distribute-preconditions.json`
- If `true`: read `name` from experiment.yaml, replace `PROJECT_NAME` constant in both `src/lib/analytics.ts` and `src/lib/analytics-server.ts` with the correct value
- If `false` or field is absent: skip

### 3e: Ad-readiness verification

Post-implementation checks. Read `phase` from `.runs/distribute-context.json` and `channel` from `.runs/distribute-preconditions.json`.

**Phase 1 + google-ads: BLOCKING. Phase 2 + google-ads: WARNING (non-blocking). Other channels: skip.**

Checks:

**gclid capture:**
```bash
grep -r 'gclid' src/ site/ 2>/dev/null | grep -v node_modules | grep -v '.yaml' | grep -v '.md'
```
- PASS: at least one match in `.ts`/`.tsx`/`.js`/`.jsx` that reads `gclid` from URL params
- FAIL: landing page does not capture Google Click ID

**Unified funnel_stage:**
Read `experiment/EVENTS.yaml`. For every event in the `events` map, verify `funnel_stage` exists and is one of: `reach`, `demand`, `activate`, `monetize`, `retain`.
- PASS: all events have valid `funnel_stage`
- FAIL: list the event names missing `funnel_stage`

**Click ID in reach event properties:**
Read `experiment/EVENTS.yaml`. Find events where `funnel_stage` is `reach`. Verify at least one has `gclid` or `click_id` in its `properties`.
- PASS: reach event defines gclid/click_id
- FAIL: no reach event has gclid/click_id property

**UTM capture:**
```bash
grep -r 'utm_source' src/ site/ 2>/dev/null | grep -v node_modules | grep -v '.yaml' | grep -v '.md'
```
- PASS: at least one match that reads `utm_source` from URL params
- FAIL: landing page does not capture UTM parameters

**Conversion event exists:**
Read `experiment/EVENTS.yaml`. Check that at least one event has `funnel_stage: demand` or `funnel_stage: activate`.
- PASS: at least one demand/activate event exists
- FAIL (WARNING only, non-blocking): "No conversion events in EVENTS.yaml. The ad platform needs a demand or activate stage event to track conversions."

**If any of the first 4 checks fail after 3a-3d implementation:**
- This indicates a build or logic bug in the implementation
- Fix the issue and retry the failing checks (max 2 attempts)
- If still failing after retries, STOP with error: "Ad-readiness check failed after implementation and 2 fix attempts. Manual investigation required: [list failed checks]."

**If only conversion event check fails (and first 4 pass):** WARNING only, continue.

### 3f: Run verify.md

Before running verify.md, set skill attribution: use `"distribute"` as the skill value when creating verify-context.json. Since distribute does not use `current-plan.md`, pass the skill directly when creating verify-context.json.

Run the verification procedure per `.claude/patterns/verify.md`.

**Gate check:** Read `.runs/verify-report.md`. If it does not exist, STOP — go back and run verify.md. Do NOT proceed without a verification report.

### 3g: Commit to branch

- You are already on a `chore/distribute-*` branch
- Commit all changes with message: imperative mood describing the implementation (e.g., "Add UTM/gclid capture and feedback widget for distribution")
- Do NOT create a PR yet (that happens in State 5)

### Working memory for PR body (State 5)

Store the following in working memory for inclusion in the PR body during State 5:

**Demo mode recommendation:**
If the app requires signup/auth before the user can see value, note a recommendation for a demo/preview mode. This is a recommendation only — implementing the demo is a separate `/change` task.

**Conversion sync setup instructions:**
Read the selected channel's stack file "Setup Instructions" section and prepare step-by-step instructions. Also read the analytics stack file for provider-specific destination/integration instructions.

**Ads Dashboard Setup:**
Read the analytics stack file's Dashboard Navigation section for provider-specific terminology, then prepare these instructions:

1. Go to the analytics dashboard -> New dashboard -> "Ads Performance: {project_name}"
2. Add these insights (read the channel's stack file "UTM Parameters" section for the correct `utm_source` value):
   - **Traffic by Source**: Trend chart, event `visit_landing`, breakdown by `utm_source`, last 7 days
   - **Paid Funnel**: Funnel chart, events `visit_landing` (filtered: utm_source = {channel_source}) -> `signup_complete` -> `activate`, last 7 days
   - **Cost per Activation**: Number (manual calculation) — Total channel spend / activate count where utm_source = {channel_source}
   - **Feedback Summary**: Trend chart, event `feedback_submitted`, breakdown by `source` property, last 7 days

### Completion checkpoint

Write `.runs/distribute-impl-step-check.json`:
```bash
python3 -c "
import json, os, subprocess
steps = []
utm = subprocess.run(['grep','-rq','utm_source','src/','site/'], capture_output=True)
utm_wired = utm.returncode == 0
if utm_wired:
    steps.append('3a')
click = subprocess.run(['grep','-rq','gclid','src/','site/'], capture_output=True)
click_id_wired = click.returncode == 0
if click_id_wired:
    steps.append('3b')
fb = False
if os.path.exists('experiment/EVENTS.yaml'):
    fb = 'feedback_submitted' in open('experiment/EVENTS.yaml').read()
if fb:
    steps.append('3c')
steps.append('3d')  # project_name fix (no-op if mismatch was false)
steps.append('3e')  # ad-readiness checks ran
if os.path.exists('.runs/verify-report.md'):
    steps.append('3f')
steps.append('3g')  # commit
os.makedirs('.runs', exist_ok=True)
json.dump({
    'steps_completed': steps,
    'key_outputs': {
        'utm_wired': utm_wired,
        'click_id_wired': click_id_wired,
        'feedback_widget_added': fb,
        'ad_readiness_passed': len(steps) >= 5
    }
}, open('.runs/distribute-impl-step-check.json', 'w'), indent=2)
print('SELF-CHECK: wrote .runs/distribute-impl-step-check.json with', len(steps), 'steps')
"
```

This checkpoint is mandatory. Do not skip it.

**POSTCONDITIONS:**
- UTM capture wired on landing page (utm_source, utm_medium, utm_campaign parsed from URL params)
- Click ID capture wired on landing page (channel-specific click ID + gclid for backward compatibility)
- `feedback_submitted` event added to experiment/EVENTS.yaml
- Feedback widget implemented per archetype (web-app: React component, service/cli: inline HTML)
- project_name fixed if mismatch was recorded in preconditions
- Ad-readiness checks passed (Phase 1 + google-ads: blocking; Phase 2 + google-ads: warnings noted)
- verify.md completed and `.runs/verify-report.md` exists
- All changes committed to branch
- `.runs/distribute-impl-step-check.json` exists with at least 1 completed step

**VERIFY:**
```bash
test -f .runs/verify-report.md && (grep -q 'utm_source' src/app/page.tsx 2>/dev/null || grep -q 'utm_source' site/index.html 2>/dev/null) && python3 -c "import json; d=json.load(open('.runs/distribute-impl-step-check.json')); assert len(d.get('steps_completed',[])) > 0" && grep -q 'feedback_submitted' experiment/EVENTS.yaml
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 3
```

**NEXT:** Read [state-4-generate.md](state-4-generate.md) to continue.
