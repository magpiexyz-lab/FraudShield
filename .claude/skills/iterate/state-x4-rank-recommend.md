# STATE x4: RANK_AND_RECOMMEND

PostHog-only report. No Google Ads spend / CTR / QS columns.

**PRECONDITIONS:**
- STATE x3 POSTCONDITIONS met
- `.runs/iterate-cross-scores.json` exists with `headline_verdict` per MVP
- `.runs/iterate-cross-data.json` exists (raw metrics)

**ACTIONS:**

### Read inputs

```bash
SCORES=.runs/iterate-cross-scores.json
DATA=.runs/iterate-cross-data.json
DEBUG_PROMPTS=.claude/patterns/iterate-cross-debug-prompts.md
```

Read all three. Build a per-MVP record by joining scores + data on `name`.

### Sort MVPs by verdict precedence

Sort MVPs into this order:

0. `MISSING_PROJECT_NAME` — sort by `gclid_visitors` desc (biggest leaks first; these block all downstream analysis until tracking is fixed, so they go at the top)
1. `GO` — sort by `signups` desc, then `gclid_visitors` asc (most efficient first)
2. `WEAK` — sort by `signups` desc, then `gclid_visitors` desc
3. `INSUFFICIENT_DATA` — sort by `gclid_visitors` desc (closest to floor first)
4. `NO_GO` — sort by `gclid_visitors` desc
5. `NO_DATA` — alphabetical

This keeps the most-actionable verdicts at the top. MISSING_PROJECT_NAME outranks everything else because the data underneath is suspect — the operator must fix tracking before any product decision is trustworthy.

---

### Section A — Per-MVP table

Print to stdout. Window comes from `.runs/iterate-cross-scores.json window_days`:

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║  Cross-MVP Evaluation — {date}  |  {N} MVPs  |  {window_days}d window        ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║ Verdict      │ MVP                │ Visitors │ Signups │ Conv% │ Signup events ║
║──────────────┼────────────────────┼──────────┼─────────┼───────┼───────────────║
║ 🚨 MISSING   │ {host_or_name}     │   {v}    │   --    │  --   │ —             ║
║ ✅ GO         │ {name}             │   {v}    │   {s}   │ {r}%  │ {events}      ║
║ ⚠️ WEAK       │ {name}             │   {v}    │   {s}   │ {r}%  │ {events}      ║
║ ⏳ INSUF      │ {name}             │   {v}    │   {s}   │  --   │ {events}      ║
║ ❌ NO_GO      │ {name}             │   {v}    │   {s}   │ {r}%  │ {events}      ║
║ ❓ NO_DATA    │ {name}             │   --     │   --    │  --   │ —             ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

For any row whose `partial_tracking_pct` is non-null and > 0, append a warning suffix to the MVP cell (e.g., `x-predict ⚠ 14% pages w/o project_name`). This flags canonical rows that absorbed an orphan during state-x0's merge step — same-deploy partial-tracking, NOT a separate broken deploy. The operator action is to find pages on this MVP that don't import analytics.ts or fail to register `project_name`, and fix them so future runs converge on the canonical row.

Show the operator at the bottom: total visitors, total signups, blended conv%, count by verdict.

---

### Section B — Owner grouping (only when owner present)

If any MVP in scores has `owner != null`, group MVPs by owner. For each owner, print a block:

```
─── {owner} ───

{MVP 1 verdict + action item}
{MVP 2 verdict + action item}
...
```

Action templates per verdict (keep brief; debug prompts come from `iterate-cross-debug-prompts.md` for `NO_DATA`):

- **GO** → "Promote {name} to Phase 2 with `/iterate` (default mode)."
- **WEAK** → "Investigate {name}: above visitors floor but only {signups} signups. Check landing-page friction or extend campaign window."
- **NO_GO** → "Stop {name}. Confirm rejection in retro."
- **INSUFFICIENT_DATA** → "Keep {name} running until {visitors_needed} more visitors arrive (target: 50+)."
- **NO_DATA** → "Debug PostHog tracking. Run Claude Code in the MVP repo with this prompt: {inline NO_DATA debug prompt}"
- **MISSING_PROJECT_NAME** → "Fix {name} tracking: PostHog events arrived without `project_name`. Check `src/lib/analytics.ts` PROJECT_NAME constant — it must equal experiment.yaml.name (kebab-case enforced by /bootstrap state-3). Re-run /verify after fixing."

If NO MVP has an owner set, skip Section B and emit a notice:
> No `mvp_mappings.<name>.owner` set in `experiment/iterate-cross-config.yaml`. Add owner to enable per-owner action grouping.

---

### Section C — Telegram-ready artifact

Write `.runs/iterate-cross-telegram.txt`. Format: one block per owner (or single "unassigned" block), separated by `---`. Each block ≤4000 chars.

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
> Cross-MVP evaluation complete. Output: per-MVP table (above), owner action items (above), Telegram blocks (`.runs/iterate-cross-telegram.txt`).

**POSTCONDITIONS:**
- Per-MVP ranking table presented (Section A)
- Per-owner action items presented (Section B) OR notice emitted if no owner mapping
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
