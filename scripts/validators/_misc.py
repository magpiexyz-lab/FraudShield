"""Miscellaneous validation checks (distribution docs, procedures, agents, settings, traces)."""
import glob
import json
import os
import re

from ._utils import (
    extract_code_blocks,
    parse_frontmatter_from_content,
    parse_frontmatter,
    BASE_REQUIRED_EXPERIMENT_FIELDS,
    OPTIONAL_CATEGORIES,
)

__all__ = [
    "check_41_distribution_docs_references",
    "check_53_supabase_delete_flag",
    "check_54_procedure_production_branch",
    "check_55_production_references_tdd",
    "check_56_production_references_implementer",
    "check_58_agent_tool_consistency",
    "check_60_settings_hook_paths",
    "check_61_footer_directive_sync",
    "check_62_trace_framework_completeness",
]

def check_41_distribution_docs_references() -> list[str]:
    """Check 41: docs/*.md files referenced in distribute.md or distribution stack files exist."""
    errors: list[str] = []
    docs_ref_sources = [".claude/commands/distribute.md"] + glob.glob(
        ".claude/stacks/distribution/*.md"
    )
    for src_path in docs_ref_sources:
        if os.path.isfile(src_path):
            with open(src_path) as f:
                content = f.read()

            for ref_match in re.finditer(r"`(docs/[^`]+\.md)`", content):
                referenced_path = ref_match.group(1)
                if not os.path.isfile(referenced_path):
                    errors.append(
                        f"[41] {src_path}: references `{referenced_path}` "
                        f"but that file does not exist on disk"
                    )
    return errors


def check_53_supabase_delete_flag(file_contents: dict[str, str]) -> list[str]:
    """Check 53: supabase projects delete uses --project-ref flag."""
    errors: list[str] = []
    for sf, content in file_contents.items():
        code_blocks = extract_code_blocks(content, {"bash", "sh"})
        for block in code_blocks:
            if "supabase projects delete" in block["code"]:
                if "--project-ref" not in block["code"]:
                    errors.append(
                        f"[53] {sf}: `supabase projects delete` without --project-ref flag "
                        f"near line {block['start_line']}"
                    )
    return errors


def check_54_procedure_production_branch(procedure_files: dict[str, str]) -> list[str]:
    """Check 54: Procedure files for Feature/Upgrade/Fix have quality gate branches."""
    errors: list[str] = []
    target_procedures = {"change-feature.md", "change-upgrade.md", "change-fix.md"}
    for path, content in procedure_files.items():
        basename = os.path.basename(path)
        if basename not in target_procedures:
            continue
        # TDD/implementer references must be present unconditionally (no MVP mode)
        if not re.search(r"tdd\.md|patterns/tdd|ON-TOUCH", content):
            errors.append(
                f"[54] {path}: procedure file missing TDD or ON-TOUCH reference"
            )
    return errors


def check_55_production_references_tdd(procedure_files: dict[str, str]) -> list[str]:
    """Check 55: Procedure files reference TDD (unconditional — no MVP mode)."""
    errors: list[str] = []
    target_procedures = {"change-feature.md", "change-upgrade.md", "change-fix.md"}
    for path, content in procedure_files.items():
        basename = os.path.basename(path)
        if basename not in target_procedures:
            continue
        # TDD reference should exist somewhere in the file
        if not re.search(r"tdd\.md|patterns/tdd|TDD|regression test", content):
            errors.append(
                f"[55] {path}: procedure file does not reference tdd.md"
            )
    return errors


def check_56_production_references_implementer(procedure_files: dict[str, str]) -> list[str]:
    """Check 56: Feature and upgrade procedures reference implementer agent.

    Only checks feature and upgrade procedures — fix uses a simpler single-task
    TDD path (regression test + minimal fix) without implementer agents.
    """
    errors: list[str] = []
    target_procedures = {"change-feature.md", "change-upgrade.md"}
    for path, content in procedure_files.items():
        basename = os.path.basename(path)
        if basename not in target_procedures:
            continue
        # Implementer reference should exist somewhere in the file
        if not re.search(r"implementer\.md|agents/implementer|implementer agent", content):
            errors.append(
                f"[56] {path}: procedure file does not reference implementer agent"
            )
    return errors


def check_58_agent_tool_consistency(agent_files: dict[str, str]) -> list[str]:
    """Check 58: Agent tool declarations are consistent with their roles."""
    errors: list[str] = []
    for path, content in agent_files.items():
        basename = os.path.basename(path)
        fm = parse_frontmatter_from_content(content)
        if not fm:
            continue
        tools = fm.get("tools", []) or []
        disallowed = fm.get("disallowedTools", []) or []

        if basename == "implementer.md":
            for required in ["Edit", "Write", "Bash"]:
                if required not in tools:
                    errors.append(
                        f"[58] {path}: implementer agent missing required tool '{required}'"
                    )

        if basename == "spec-reviewer.md":
            for forbidden in ["Edit", "Write"]:
                if forbidden in tools:
                    errors.append(
                        f"[58] {path}: spec-reviewer agent has write tool '{forbidden}' "
                        f"but should be read-only"
                    )
                if forbidden not in disallowed:
                    errors.append(
                        f"[58] {path}: spec-reviewer agent should disallow '{forbidden}'"
                    )
    return errors


def check_60_settings_hook_paths() -> list[str]:
    """Check 60: Every hook command path in settings.json must resolve to an existing file."""
    errors: list[str] = []
    settings_path = ".claude/settings.json"
    if not os.path.isfile(settings_path):
        return errors
    try:
        with open(settings_path) as f:
            settings = json.loads(f.read())
    except (json.JSONDecodeError, OSError):
        return errors
    hooks = settings.get("hooks", {})
    for _matcher, hook_list in hooks.items():
        if not isinstance(hook_list, list):
            continue
        for entry in hook_list:
            if not isinstance(entry, dict):
                continue
            hook_entries = entry.get("hooks", [entry])
            if not isinstance(hook_entries, list):
                hook_entries = [hook_entries]
            for hook in hook_entries:
                if not isinstance(hook, dict):
                    continue
                cmd = hook.get("command", "")
                # Normalize: strip quotes and replace $CLAUDE_PROJECT_DIR with .
                normalized = cmd.replace('"', "").replace("'", "")
                normalized = normalized.replace("$CLAUDE_PROJECT_DIR/", "")
                # Extract just the script path (first token)
                script_path = normalized.split()[0] if normalized.split() else ""
                if script_path and script_path.endswith(".sh"):
                    if not os.path.isfile(script_path):
                        errors.append(
                            f"[60] {settings_path}: hook path '{script_path}' "
                            f"does not resolve to an existing file"
                        )
    return errors


def check_61_footer_directive_sync() -> list[str]:
    """Check 61: Directive marker in agent-prompt-footer.md must match skill-agent-gate.sh grep."""
    errors: list[str] = []
    footer_path = ".claude/agent-prompt-footer.md"
    hook_paths = [".claude/hooks/skill-agent-gate.sh", ".claude/hooks/lib.sh", ".claude/hooks/lib-artifacts.sh"]
    if not os.path.isfile(footer_path) or not any(os.path.isfile(p) for p in hook_paths):
        return errors
    with open(footer_path) as f:
        first_line = f.readline().strip()
    # Extract directive marker from HTML comment: <!-- DIRECTIVES:... -->
    marker = first_line
    if marker.startswith("<!--"):
        marker = marker[4:]
    if marker.endswith("-->"):
        marker = marker[:-3]
    marker = marker.strip()
    if not marker.startswith("DIRECTIVES:"):
        return errors
    found = False
    for hook_path in hook_paths:
        if os.path.isfile(hook_path):
            with open(hook_path) as f:
                if marker in f.read():
                    found = True
                    break
    if not found:
        errors.append(
            f"[61] hook files: directive grep pattern does not match "
            f"agent-prompt-footer.md marker '{marker}'"
        )
    return errors


def check_62_trace_framework_completeness() -> list[str]:
    """Check 62: Every stateful skill has Q-score and epilogue categorization."""
    errors: list[str] = []

    # Find all stateful skills (dirs with state-*.md files)
    stateful_skills: list[str] = []
    patterns_dir = ".claude/patterns"
    if os.path.isdir(patterns_dir):
        for d in sorted(os.listdir(patterns_dir)):
            skill_dir = os.path.join(patterns_dir, d)
            if os.path.isdir(skill_dir) and glob.glob(os.path.join(skill_dir, "state-*.md")):
                stateful_skills.append(d)

    # Skills excluded from Q-score check:
    # - verify: uses own STATE 7 --raw mechanism
    excluded_qscore = {"verify"}
    # Skills excluded from epilogue categorization:
    # - verify: own mechanism
    # - optimize-prompt: stateless (no state files, won't appear)
    excluded_epilogue = {"verify"}

    # Check 1: Q-score presence
    for skill in stateful_skills:
        if skill in excluded_qscore:
            continue
        skill_dir = os.path.join(patterns_dir, skill)
        state_files = glob.glob(os.path.join(skill_dir, "state-*.md"))
        has_qscore = False
        for sf in state_files:
            with open(sf) as f:
                if "write-q-score" in f.read():
                    has_qscore = True
                    break
        if not has_qscore:
            errors.append(
                f"[62] Skill '{skill}' has {len(state_files)} state files but no "
                f"write-q-score call in any state"
            )

    # Check 2: Epilogue categorization
    epilogue_path = ".claude/patterns/skill-epilogue.md"
    if os.path.isfile(epilogue_path):
        with open(epilogue_path) as f:
            epilogue_content = f.read()
        for skill in stateful_skills:
            if skill in excluded_epilogue:
                continue
            # Check if skill appears in epilogue (Strategy A, B, or verify-embedded)
            if f"/{skill}" not in epilogue_content and skill not in epilogue_content:
                errors.append(
                    f"[62] Skill '{skill}' not categorized in skill-epilogue.md"
                )

    return errors


# ---------------------------------------------------------------------------
# Check registry and runner
# ---------------------------------------------------------------------------
