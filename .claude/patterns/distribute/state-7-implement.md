# STATE 7: IMPLEMENT

**PRECONDITIONS:**
- User has approved the ads config (STATE 6 POSTCONDITIONS met)

**ACTIONS:**

### 7a: UTM capture on landing page

- Read the analytics stack file (`.claude/stacks/analytics/<value>.md`) to understand the tracking API
- Ensure `visit_landing` event captures `utm_source`, `utm_medium`, `utm_campaign` from URL params
- experiment/EVENTS.yaml has these as optional properties on `visit_landing` — the surface must parse them from URL params and pass them to the tracking call
- **web-app**: parse from `window.location.search` in the landing page component
- **service (co-located)**: parse from the request URL in the root route handler and embed in the HTML response's tracking script
- **cli (detached) or service (detached)**: add an inline `<script>` in `site/index.html` that parses `window.location.search` and fires the tracking call via the analytics snippet

- When experiment.yaml has `variants`, also capture `utm_content` from URL params alongside UTM params. This maps to the variant slug and enables per-variant attribution in analytics (e.g., filter `visit_landing` by `utm_content = "speed"` to see paid traffic for the speed variant).

### 7b: Add click ID capture

- Read the selected channel's stack file "Click ID" section to get the parameter name (e.g., `gclid` for google-ads, `twclid` for twitter, `rdt_cid` for reddit)
- Capture the channel's click ID from URL params on landing page load alongside UTM params
- Store the value as the generic `click_id` property in the `visit_landing` analytics event (experiment/EVENTS.yaml defines `click_id` as an optional property)
- Also capture `gclid` separately for backward compatibility (it remains an optional property on `visit_landing`)
- This enables conversion attribution in the channel's ad platform

### 7c: Feedback widget (post-activation)

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

### 7d: Demo mode recommendation

If the app requires signup/auth before the user can see value, add a note to the PR body recommending a demo/preview mode. This is a recommendation only — implementing the demo is a separate `/change` task.

### 7e: Conversion sync setup instructions

Add a `## Distribution Setup` section to the PR body with step-by-step instructions. Read the selected channel's stack file "Setup Instructions" section and include those steps. Also read the analytics stack file for provider-specific destination/integration instructions.

Also include analytics dashboard setup instructions (read the analytics stack file's Dashboard Navigation section for provider-specific terminology):

### Ads Dashboard Setup

1. Go to the analytics dashboard -> New dashboard -> "Ads Performance: {project_name}"
2. Add these insights (read the channel's stack file "UTM Parameters" section for the correct `utm_source` value):
   - **Traffic by Source**: Trend chart, event `visit_landing`, breakdown by `utm_source`, last 7 days
   - **Paid Funnel**: Funnel chart, events `visit_landing` (filtered: utm_source = {channel_source}) -> `signup_complete` -> `activate`, last 7 days
   - **Cost per Activation**: Number (manual calculation) — Total channel spend / activate count where utm_source = {channel_source}
   - **Feedback Summary**: Trend chart, event `feedback_submitted`, breakdown by `source` property, last 7 days

**POSTCONDITIONS:**
- UTM capture wired on landing page (utm_source, utm_medium, utm_campaign parsed from URL params)
- Click ID capture wired on landing page (channel-specific click ID + gclid for backward compatibility)
- `feedback_submitted` event added to experiment/EVENTS.yaml
- Feedback widget implemented per archetype (web-app: React component, service/cli: inline HTML)
- Demo mode recommendation noted if auth required (for PR body)
- Conversion sync setup instructions prepared (for PR body)

**VERIFY:**
```bash
(grep -q 'utm_source' src/app/page.tsx 2>/dev/null || grep -q 'utm_source' site/index.html 2>/dev/null) && grep -q 'feedback_submitted' experiment/EVENTS.yaml
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 7
```

**NEXT:** Read [state-8-verify-and-pr.md](state-8-verify-and-pr.md) to continue.
