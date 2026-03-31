# STATE 1: PARALLEL_ANALYSIS

**PRECONDITIONS:**
- Scope and baseline collected (STATE 0 POSTCONDITIONS met)

**ACTIONS:**

## Step 1: Parallel analysis

Launch 3 Explore subagents in parallel. Construct each agent's prompt from:
- The **shared context instruction** below
- The agent's **dimension section**
- The **Finding Format** and **Rules**

> **Shared context instruction** — include verbatim in every subagent prompt:
>
> Before scanning, read these context files:
> `CLAUDE.md`, `.claude/settings.json`, `scripts/check-inventory.md`.
>
> Then read ALL files in these directories (adjust to scope if not full):
> - Glob `.claude/commands/*.md` — every skill file
> - Glob `.claude/stacks/**/*.md` — every stack file
> - Glob `.claude/patterns/**/*.md` — every pattern file (including verify sub-states)
> - Glob `.claude/procedures/*.md` — every procedure file
> - Glob `.claude/agents/*.md` — every agent definition
> - Glob `.claude/hooks/*.sh` — every hook script
> - Glob `scripts/*.py` — every validator script
>
> Do not report issues already covered by `scripts/check-inventory.md`
> (including its Pending and Rejected sections).
>
> **JIT awareness**: This template uses JIT State Dispatch — state files and
> agent prompts are intentionally self-contained. Some repetition is by design
> to avoid cross-file dependencies during context-limited execution. Do NOT
> flag self-containment repetition as duplication.

---

### Dimension A: Duplication

Focus: Find **textually identical or near-identical** code/prose blocks
duplicated across 3+ files that serve no architectural purpose and could be
extracted into a shared definition.

**Primary scan targets** (highest-yield duplication sources):
- Inline `python3 -c` one-liners in hook scripts (payload extraction, JSON reading, verdict checking)
- Boilerplate skeleton shared between structurally similar hooks (e.g., merge gates)
- Validator invocation lists repeated across skill files
- Artifact cleanup/deletion lists repeated within or across files
- Error handling patterns (`2>/dev/null || echo ""`, `ERRORS+=()`, deny JSON output)

**Classification** — for each candidate, determine:
- **Extractable**: No architectural reason for duplication. Could be a shared
  shell function, a referenced pattern section, or a named constant.
- **JIT-intentional**: Repeated for self-containment. Skip silently.

Only report extractable findings.

Files to read: all directories from shared context instruction, with special
attention to `.claude/hooks/*.sh` (the densest duplication source).

---

### Dimension B: Complexity

Focus: Find files whose **internal structure** has grown beyond maintainable
levels — not merely long files, but files with mixed responsibilities,
deep nesting, or interacting subsystems.

**Thresholds** (flag for analysis, not automatic finding):
- Shell scripts (.sh): >400 lines
- Markdown skill/pattern (.md): >600 lines
- Python scripts (.py): >1500 lines

**For each file exceeding a threshold, classify:**

- **Long but simple** — Linear structure: parallel case branches, sequential
  checklists, independent validation checks. Long because it covers many cases.
  **Do NOT report.** Instead, note in the "Scanned but clean" summary.

- **Long and complex** — One or more of:
  - Mixed responsibilities (validation + transformation + reporting in one file)
  - Deep nesting (4+ levels of if/elif/case)
  - Functions longer than 50 lines (.sh) or sections longer than 100 lines (.md)
  - Multiple helper functions that interact with shared mutable state
  - A file that is both a gate (deny/allow) and a validator (check N conditions)
  **Report with a split strategy.**

**Also flag regardless of file size:**
- Functions/sections with cyclomatic complexity concerns (many conditional paths)
- Files where a single change requires understanding 3+ helper functions

Files to read: all directories from shared context instruction.

---

### Dimension C: Abstractability

Focus: Find **semantically equivalent patterns** implemented inline in 3+ files
instead of referencing a shared definition. This goes beyond textual duplication
(Dimension A) — look for implementations that achieve the same goal with
different words, structure, or ordering.

**Deduplication rule**: If Dimension A already reported a finding about the
same pattern (textually identical blocks), do NOT re-report it here. Dimension C
is exclusively for **semantic** equivalence — same intent, different text.

**Primary scan targets:**
- Protocol descriptions (e.g., fix-log writing format described differently in 13 files)
- Conditional archetype handling (`if web-app... elif service... elif cli...`)
  reimplemented per-skill instead of referencing a shared decision tree
- Gate-checking patterns (read JSON -> extract field -> compare -> error array)
  reimplemented per-hook instead of calling a shared function
- Artifact existence checks done inline instead of referencing a manifest

**For each finding, record:**
- The pattern being implemented inline (describe the intent, not the text)
- Number of files and their paths
- Where a shared definition should live
- **JIT tradeoff note**: Would extracting this break self-containment? If yes,
  note the tradeoff explicitly — the finding is still valuable but the fix
  approach should preserve JIT readability (e.g., "reference + inline fallback"
  rather than "extract entirely")

Files to read: all directories from shared context instruction.

---

### Finding Format

Every finding from every dimension must use this format:

```
### Finding <D><N>: <title>
- **Dimension**: A (Duplication) | B (Complexity) | C (Abstractability)
- **Impact**: HIGH (10+ files or >100 dup lines) | MEDIUM (4-9 files) | LOW (2-3 files)
- **Effort**: LOW (<30 min) | MEDIUM (1-2 hours) | HIGH (>2 hours)
- **Files**: <file1>, <file2>, ... (or "N files — see list below")
- **Issue**: <specific description — quote representative text>
- **Suggestion**: <concrete, implementable improvement>
```

### Rules

Include in each subagent prompt:

1. **Maximum 7 findings per dimension.** Prioritize by impact.
2. **No overlap with automated checks.** Read `scripts/check-inventory.md` — if
   a check exists or was rejected, do not report it.
3. **No overlap between dimensions.** Dimension A = textual duplication.
   Dimension C = semantic equivalence (different text, same intent). If the same
   pattern qualifies for both, report it under A only.
4. **Zero findings is valid.** Say "No findings — scanned N files, all clean."
5. **Confidence filter.** Only report HIGH confidence (can quote specific lines)
   and MEDIUM confidence (likely issue, evidence points to it). Drop LOW.
6. **Self-review.** Before presenting: verify each finding is not already in
   check-inventory.md, verify no overlap with other dimensions, verify
   JIT-intentional repetition is excluded.

---

After all 3 agents return, collect findings and deduplicate:
- Finding signature = `<dimension>:<primary_file>:<title>`
- If two findings from different dimensions describe the same underlying issue,
  keep the one with higher impact; drop the other with a note.

## Do NOT
- Modify any source files — this skill is analysis only
- Create branches or PRs
- Propose fixes for correctness issues — that is `/review`'s job
- Flag intentional JIT repetition as duplication
- Report "long but simple" files as complexity hotspots
- Report the same finding under both Dimension A and Dimension C

**POSTCONDITIONS:**
- 3 subagents completed (Duplication, Complexity, Abstractability)
- Findings collected and deduplicated
- Each finding follows the Finding Format
- Rules enforced (max 7 per dimension, no overlap, confidence filter)

- **Write analysis artifact** (`.claude/runs/audit-analysis.json`):
  ```bash
  python3 -c "
  import json
  analysis = {
      'duplication': {'findings': [], 'count': 0},
      'complexity': {'findings': [], 'count': 0},
      'abstractability': {'findings': [], 'count': 0},
      'total_findings': 0
  }
  json.dump(analysis, open('.claude/runs/audit-analysis.json', 'w'), indent=2)
  "
  ```

**VERIFY:**
```bash
test -f .claude/runs/audit-analysis.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh audit 1
```

**NEXT:** Read [state-2-prioritize-and-output.md](state-2-prioritize-and-output.md) to continue.
