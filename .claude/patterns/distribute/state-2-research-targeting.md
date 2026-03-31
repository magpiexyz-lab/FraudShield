# STATE 2: RESEARCH_TARGETING

**PRECONDITIONS:**
- Preconditions validated (STATE 1 POSTCONDITIONS met)
- Hypothesis context loaded or skipped (STATE 1_5 POSTCONDITIONS met)

**ACTIONS:**

Read `experiment/experiment.yaml`: `description`, `target_user`, `name`, `behaviors`.

Read the selected channel's stack file "Targeting Model" section, then generate targeting research appropriate for the channel:

**For keyword-based channels (e.g., google-ads):**

```
## Keyword Research

**Target user intent:** [what the target_user would search for when experiencing the problem]
**Competitor landscape:** [known alternatives mentioned in problem statement]
**Search volume estimate:** [high/medium/low for this niche]

**Recommended keywords:**
- Exact match: [5-8 keywords] — highest intent, most specific
- Phrase match: [3-5 keywords] — moderate intent
- Broad match: [2-3 keywords] — discovery, wider net
- Negative: [5+ keywords] — exclude irrelevant traffic (enterprise, existing tools, etc.)
```

Keyword rules (google-ads):
- Minimum 3 exact, 2 phrase, 1 broad, 2 negative
- Exact match keywords target users actively looking for this type of solution
- Phrase match captures related searches with moderate intent
- Broad match casts a wider net for discovery
- Negative keywords exclude enterprise, existing well-known tools, and irrelevant traffic

**For interest/audience-based channels (e.g., twitter):**

```
## Audience Research

**Target user profile:** [who the target_user is on this platform]
**Competitor/influencer accounts:** [relevant handles to target]

**Recommended targeting:**
- Interests: [3-5 interest categories]
- Follower lookalikes: [3-5 competitor/influencer handles]
- Timeline keywords: [3-5 keywords users tweet about]
```

**For community-based channels (e.g., reddit):**

```
## Community Research

**Target communities:** [where the target_user congregates]
**Community tone:** [how this community expects to be addressed]

**Recommended targeting:**
- Subreddits: [3-5 relevant subreddits]
- Interest categories: [2-3 Reddit interest categories]
```

**POSTCONDITIONS:**
- Targeting research generated appropriate to the selected channel type
- Research includes all required sections per channel type (keywords, audiences, or communities)

- **Write targeting artifact** (`.claude/runs/distribute-targeting.json`):
  ```bash
  python3 -c "
  import json
  targeting = {
      'channel': '<selected channel>',
      'research_sections': [],  # list of section names completed
      'targeting_ready': True
  }
  json.dump(targeting, open('.claude/runs/distribute-targeting.json', 'w'), indent=2)
  "
  ```

**VERIFY:**
```bash
test -f .claude/runs/distribute-targeting.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 2
```

**NEXT:** Read [state-3-generate-creative.md](state-3-generate-creative.md) to continue.
