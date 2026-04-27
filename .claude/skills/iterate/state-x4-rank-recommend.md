# STATE x4: RANK_AND_RECOMMEND

**PRECONDITIONS:**
- Headline verdicts computed (STATE x3 POSTCONDITIONS met)
- `.runs/iterate-cross-scores.json` exists with `headline_verdict` per MVP
- `.runs/iterate-cross-data.json` exists (raw metrics)
- `.runs/iterate-cross-data-issues.json` exists (issue flags for soft warnings)

**ACTIONS:**

### Read inputs

```bash
SCORES=.runs/iterate-cross-scores.json
DATA=.runs/iterate-cross-data.json
ISSUES=.runs/iterate-cross-data-issues.json
DEBUG_PROMPTS=.claude/patterns/iterate-cross-debug-prompts.md
```

Read all four. Build a per-MVP record by joining scores + data + issues on `name`. Read debug prompt templates from `iterate-cross-debug-prompts.md` for inline use in Section B.

### Sort MVPs by verdict precedence

Sort MVPs into this order (group, then sort within group):

1. `GO` — sort by `signups` desc, then `clicks` asc (most efficient first)
2. `INSUFFICIENT_DATA` — sort by `clicks` desc (closest to floor first)
3. `NO_GO` — sort by `clicks` desc
4. `TRACKING_BROKEN` — sort by `clicks` desc
5. `NOT_DEPLOYED` — sort by `clicks` desc
6. `STANDARD_VIOLATION` — sort by `clicks` desc

This keeps the most-actionable verdicts at the top.

---

### Section A — Per-MVP table

Print to stdout:

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║  Phase 1 Cross-MVP Evaluation — {date}  |  {N} MVPs  |  {window} days       ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║ Verdict      │ Owner   │ MVP / Campaign            │ Clicks │ Signups │ Conv% ║
║──────────────┼─────────┼───────────────────────────┼────────┼─────────┼───────║
║ ✅ GO         │ {owner} │ {campaign} → {project}    │  {c}   │   {s}   │ {r}% ║
║ ⏳ INSUF…     │ {owner} │ {campaign}                │  {c}   │   {s}   │  --  ║
║ ❌ NO_GO      │ {owner} │ {campaign}                │  {c}   │   {s}   │ {r}% ║
║ ❓ TRACK…     │ {owner} │ {campaign}                │  {c}   │   {s}   │  --  ║
║ ❓ NOT_DEP…   │ {owner} │ {campaign}                │  {c}   │   {s}   │  --  ║
║ 🚫 STD_VIOL   │ {owner} │ {campaign}                │  {c}   │   --    │  --  ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

Soft warnings (e.g., `subaccount_conversion_misconfigured`) appear as a footnote line below the table.

---

### Section B — Per-owner action items

Group MVPs by `owner`. For each owner, print a block:

```
─── {owner} ───

{MVP 1 verdict + action item}
{MVP 2 verdict + action item}
...
```

Action templates per verdict (read from `.claude/patterns/iterate-cross-debug-prompts.md`):

- **GO** → "Promote {campaign} to Phase 2 with `/iterate` (default mode)."
- **NO_GO** → "Stop {campaign}. Confirm rejection in retro."
- **INSUFFICIENT_DATA** → "Keep running {campaign} until 50+ clicks (need {clicks_needed} more). No need to spend full $140."
- **STANDARD_VIOLATION** → "Switch {campaign} bid strategy to Manual CPC and reset budget. Re-launch under Phase 1 standard before re-evaluating."
- **TRACKING_BROKEN** → "Debug PostHog gclid capture. Run Claude Code in the MVP repo with this prompt: {inline TRACKING_BROKEN debug prompt}"
- **NOT_DEPLOYED** → "Confirm deploy URL is live + PostHog snippet loads. Run Claude Code with this prompt: {inline NOT_DEPLOYED debug prompt}"
- **CONVERSION_MISCONFIGURED** (soft warn) → "Sub-account default conversion is `{action}`, not in the sign-up whitelist. Update Account Goals → Default conversion to a sign-up event."

Inline the appropriate debug prompt verbatim in the action item so the owner can copy-paste it directly.

---

### Section C — Telegram-ready artifact

Write `.runs/iterate-cross-telegram.txt`. Format: one block per owner, separated by `---`. Each block ≤4000 chars (Telegram cap is 4096 but leave headroom).

Block template:

```
*Phase 1 Manual CPC update — {owner}*

For your campaigns:
{compact list of campaigns + verdicts + 1-line action}

Universal rule (all owners):
• <50 clicks → keep the campaign running
• ≥50 clicks → can stop (no need to spend full $140)
```

If a single owner's block exceeds 4000 chars (e.g., Radlin with many TRACKING_BROKEN debug prompts), split it into multiple sub-blocks at clean boundaries.

Generation:

```bash
python3 .claude/scripts/lib/iterate_cross_verdicts.py \
  --data .runs/iterate-cross-data.json \
  --issues .runs/iterate-cross-data-issues.json \
  --scores .runs/iterate-cross-scores.json \
  --debug-prompts .claude/patterns/iterate-cross-debug-prompts.md \
  --emit-telegram .runs/iterate-cross-telegram.txt
```

### Summary line

Print to stdout:

> Cross-MVP evaluation complete. Output: per-MVP table (above), per-owner action items (above), Telegram blocks (`.runs/iterate-cross-telegram.txt`).

**POSTCONDITIONS:**
- Per-MVP ranking table presented (Section A)
- Per-owner action items with inline debug prompts presented (Section B)
- `.runs/iterate-cross-telegram.txt` exists with one block per owner

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x4`.

```bash
test -f .runs/iterate-cross-telegram.txt && python3 -c "import os; assert os.path.getsize('.runs/iterate-cross-telegram.txt')>0, 'telegram artifact empty'"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x4
```

**NEXT:** Skill states complete.
