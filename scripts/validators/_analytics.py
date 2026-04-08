"""Analytics and ads schema validation checks."""
import re
import yaml

from ._utils import (
    extract_code_blocks,
    extract_prose,
)

__all__ = [
    "check_33_phantom_event_names",
    "check_38_ads_yaml_schema",
    "check_39_ads_campaign_name",
    "check_45_visit_landing_variant_property",
]

def check_33_phantom_event_names(
    skill_contents: dict[str, str],
    defined_events: set[str],
    global_props: set[str],
    event_props: set[str],
) -> list[str]:
    """Check 33: Backtick-wrapped event names in skill prose exist in experiment/EVENTS.yaml."""
    errors: list[str] = []
    skip_tokens = {
        "stack", "testing", "payment", "analytics", "database",
        "auth", "posthog", "supabase", "stripe", "nextjs",
        "funnel_stage", "events",
        "object_action", "track", "event_name",
        "name", "title", "owner", "problem", "solution",
        "target_user", "distribution", "thesis",
        "description", "behaviors",
        "page_name", "feature", "features", "pages", "variants",
    }

    for sf, content in skill_contents.items():
        prose = extract_prose(content)

        skill_defined_events: set[str] = set()
        skill_defined_props: set[str] = set()
        for yblock in extract_code_blocks(content, {"yaml"}):
            try:
                ydata = yaml.safe_load(yblock["code"])
            except yaml.YAMLError:
                continue
            event_items: list[dict] = []
            if isinstance(ydata, list):
                event_items = [item for item in ydata if isinstance(item, dict)]
            elif isinstance(ydata, dict):
                if "event" in ydata:
                    event_items = [ydata]
                elif "funnel_stage" in ydata:
                    # Single event definition in new flat format
                    event_items = [ydata]
                else:
                    # Flat events map: each value is an event definition
                    for key, val in ydata.items():
                        if isinstance(val, dict) and ("trigger" in val or "funnel_stage" in val):
                            edef = dict(val)
                            edef["event"] = key
                            event_items.append(edef)
            for item in event_items:
                if "event" in item:
                    skill_defined_events.add(item["event"])
                    for prop_name in (item.get("properties", {}) or {}).keys():
                        skill_defined_props.add(prop_name)

        for m in re.finditer(r"`([a-z][a-z0-9_]+)`", prose):
            token = m.group(1)
            if "/" in token or "." in token:
                continue
            start = max(0, m.start() - 100)
            end = min(len(prose), m.end() + 100)
            context = prose[start:end].lower()
            if not re.search(r"\bevent\b|\bfire\b", context):
                continue
            if token in defined_events:
                continue
            if token in global_props:
                continue
            if token in event_props:
                continue
            if token in skill_defined_events or token in skill_defined_props:
                continue
            context_before = prose[start:m.start()].lower()
            if re.search(r"(?:from|in)\s+events\.yaml", context_before):
                continue
            if re.search(r"events\.yaml", context.lower()):
                continue
            if token in skip_tokens:
                continue
            pos = content.find(f"`{token}`")
            line_num = content[:pos].count("\n") + 1 if pos >= 0 else "?"
            errors.append(
                f"[33] {sf}:{line_num}: prose references event name "
                f"'{token}' near event/fire context, but it is not "
                f"defined in experiment/EVENTS.yaml"
            )
    return errors


def check_38_ads_yaml_schema(ads_data: dict, ads_path: str) -> list[str]:
    """Check 38: Ads.yaml has valid schema."""
    errors: list[str] = []
    ads_channel = ads_data.get("channel", "google-ads")

    ads_universal_keys = [
        "campaign_name", "project_name", "landing_url",
        "budget", "targeting", "conversions", "guardrails", "thresholds",
    ]
    for key in ads_universal_keys:
        if key not in ads_data:
            errors.append(f"[38] {ads_path}: missing required key '{key}'")

    if ads_channel == "google-ads":
        for key in ("keywords", "ads"):
            if key not in ads_data:
                errors.append(f"[38] {ads_path}: missing required key '{key}' (channel: google-ads)")

        kw = ads_data.get("keywords", {})
        if isinstance(kw, dict):
            if len(kw.get("exact", []) or []) < 3:
                errors.append(f"[38] {ads_path}: keywords.exact needs at least 3 entries")
            if len(kw.get("phrase", []) or []) < 2:
                errors.append(f"[38] {ads_path}: keywords.phrase needs at least 2 entries")
            if len(kw.get("broad", []) or []) < 1:
                errors.append(f"[38] {ads_path}: keywords.broad needs at least 1 entry")
            if len(kw.get("negative", []) or []) < 2:
                errors.append(f"[38] {ads_path}: keywords.negative needs at least 2 entries")

        ads_list = ads_data.get("ads", [])
        if isinstance(ads_list, list):
            if len(ads_list) < 2:
                errors.append(f"[38] {ads_path}: ads needs at least 2 variations")
            for i, ad in enumerate(ads_list):
                if isinstance(ad, dict):
                    headlines = ad.get("headlines", []) or []
                    descriptions = ad.get("descriptions", []) or []
                    if len(headlines) < 5:
                        errors.append(f"[38] {ads_path}: ads[{i}] needs at least 5 headlines")
                    if len(descriptions) < 2:
                        errors.append(f"[38] {ads_path}: ads[{i}] needs at least 2 descriptions")

    elif ads_channel == "twitter":
        if "tweets" not in ads_data:
            errors.append(f"[38] {ads_path}: missing required key 'tweets' (channel: twitter)")
        tweets = ads_data.get("tweets", [])
        if isinstance(tweets, list):
            if len(tweets) < 2:
                errors.append(f"[38] {ads_path}: tweets needs at least 2 variations")
            for i, tw in enumerate(tweets):
                if isinstance(tw, dict):
                    text = tw.get("text", "")
                    if len(text) > 280:
                        errors.append(f"[38] {ads_path}: tweets[{i}] text exceeds 280 chars")

    elif ads_channel == "reddit":
        if "posts" not in ads_data:
            errors.append(f"[38] {ads_path}: missing required key 'posts' (channel: reddit)")
        posts = ads_data.get("posts", [])
        if isinstance(posts, list):
            if len(posts) < 2:
                errors.append(f"[38] {ads_path}: posts needs at least 2 variations")
            for i, post in enumerate(posts):
                if isinstance(post, dict):
                    headline = post.get("headline", "")
                    if len(headline) > 300:
                        errors.append(f"[38] {ads_path}: posts[{i}] headline exceeds 300 chars")

    budget = ads_data.get("budget", {})
    if isinstance(budget, dict):
        total = budget.get("total_budget_cents", 0) or 0
        if total > 50000:
            errors.append(
                f"[38] {ads_path}: budget.total_budget_cents ({total}) exceeds max 50000 ($500)"
            )

    guardrails = ads_data.get("guardrails", {})
    if isinstance(guardrails, dict):
        if ads_channel == "google-ads":
            max_cpc = guardrails.get("max_cpc_cents")
            if max_cpc is None:
                errors.append(f"[38] {ads_path}: missing guardrails.max_cpc_cents")
            elif not isinstance(max_cpc, int) or max_cpc <= 0:
                errors.append(
                    f"[38] {ads_path}: guardrails.max_cpc_cents must be an integer > 0 (got {max_cpc!r})"
                )

    thresholds = ads_data.get("thresholds", {})
    if isinstance(thresholds, dict):
        exp_act = thresholds.get("expected_activations")
        if exp_act is None:
            errors.append(f"[38] {ads_path}: missing thresholds.expected_activations")
        elif not isinstance(exp_act, int) or exp_act < 0:
            errors.append(
                f"[38] {ads_path}: thresholds.expected_activations must be an integer >= 0 (got {exp_act!r})"
            )
        go_signal = thresholds.get("go_signal")
        if not go_signal or not isinstance(go_signal, str) or not go_signal.strip():
            errors.append(f"[38] {ads_path}: thresholds.go_signal must be a non-empty string")
        no_go_signal = thresholds.get("no_go_signal")
        if not no_go_signal or not isinstance(no_go_signal, str) or not no_go_signal.strip():
            errors.append(f"[38] {ads_path}: thresholds.no_go_signal must be a non-empty string")

    return errors


def check_39_ads_campaign_name(ads_data: dict, idea_data: dict, ads_path: str) -> list[str]:
    """Check 39: ads.yaml campaign_name matches experiment.yaml name."""
    errors: list[str] = []
    idea_name = idea_data.get("name", "")
    campaign_name = ads_data.get("campaign_name", "")
    if idea_name and campaign_name:
        if not str(campaign_name).startswith(str(idea_name)):
            errors.append(
                f"[39] {ads_path}: campaign_name '{campaign_name}' does not start with "
                f"experiment.yaml name '{idea_name}'"
            )
    return errors


def check_45_visit_landing_variant_property(events_data: dict | None) -> list[str]:
    """Check 45: visit_landing event has variant property (when present)."""
    errors: list[str] = []
    events_path = "experiment/EVENTS.yaml"
    if not events_data or not isinstance(events_data, dict):
        return errors

    flat_events = events_data.get("events", {})
    # Only validate when visit_landing exists — events are project-specific,
    # not all projects will have this event name.
    if isinstance(flat_events, dict) and "visit_landing" in flat_events:
        visit_landing_event = flat_events["visit_landing"]
        props = visit_landing_event.get("properties", {}) if isinstance(visit_landing_event, dict) else {}
        if not isinstance(props, dict) or "variant" not in props:
            errors.append(
                f"[45] {events_path}: visit_landing event is missing "
                f"a 'variant' property (needed for experiment matrix)"
            )
    return errors
