import { PostHog } from "posthog-node";

const PROJECT_NAME = "fraudshield"; // Replaced by bootstrap with kebab-case experiment.yaml `name` (^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$, enforced by /bootstrap state-3 — see .claude/scripts/lib/validate_experiment_yaml.py). Must NEVER be edited at runtime; identity stability across deploys depends on this constant being immutable for an MVP's lifetime.
const PROJECT_OWNER = "magpie"; // Replaced by bootstrap with experiment.yaml `owner`
export const POSTHOG_KEY = process.env.POSTHOG_SERVER_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "phc_TEAM_KEY";
export const POSTHOG_HOST = "https://us.i.posthog.com";
const POSTHOG_PLACEHOLDER = "phc_TEAM_KEY";

const isMisconfigured = !POSTHOG_KEY || POSTHOG_KEY === POSTHOG_PLACEHOLDER;
// Server-side has full env access — gate on hosting-platform indicators.
// `VERCEL === "1"` is the canonical Vercel deploy indicator (see TEMPLATE.md).
// `RAILWAY_ENVIRONMENT_NAME` is the Railway equivalent. Add other host indicators here
// when introducing new hosting stack files.
const isHostingPlatform = process.env.VERCEL === "1" || !!process.env.RAILWAY_ENVIRONMENT_NAME;

if (isMisconfigured && isHostingPlatform) {
  console.error(
    "[analytics-server] PostHog is not configured for this deployment — server events will not be sent. " +
    "Set NEXT_PUBLIC_POSTHOG_KEY (or POSTHOG_SERVER_KEY) in your hosting platform, " +
    "or replace 'phc_TEAM_KEY' in src/lib/analytics-server.ts."
  );
}

export async function trackServerEvent(
  event: string,
  distinctId: string,
  properties?: Record<string, unknown>
) {
  if (isMisconfigured) return;
  const client = new PostHog(POSTHOG_KEY, {
    host: POSTHOG_HOST,
  });

  client.capture({
    distinctId,
    event,
    properties: {
      ...properties,
      project_name: PROJECT_NAME,
      project_owner: PROJECT_OWNER,
    },
  });

  await client.shutdown();
}
