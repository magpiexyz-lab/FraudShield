# STATE 4b: ROOT_CAUSE_CLUSTERING

**PRECONDITIONS:**
- Blast radius complete (STATE 4 POSTCONDITIONS met)
- 2+ actionable issues remain

**ACTIONS:**

Skip if only 1 actionable issue remains.

Compare divergence points and causal patterns across all actionable issues:

1. Group issues sharing the same root pattern (e.g., 3 issues all
   caused by "missing archetype guard" = 1 cluster)
2. For each cluster of 2+ issues:
   - Designate the highest-severity issue as **primary**
   - Mark others as **correlated**: "shares root cause with #N"
   - Design ONE unified fix in Step 5 (not N separate fixes)
3. Uncorrelated issues get individual fix designs as before

Present in diagnosis report:
```
### Root-Cause Clusters
- Cluster 1 (#A, #B): <shared pattern>. Primary: #A.
- Uncorrelated: #C
```

- **Write clustering artifact** (`.claude/resolve-clusters.json`):
  ```bash
  python3 -c "
  import json
  clusters = {
      'clusters': [
          {'primary_issue': 0, 'related_issues': [], 'root_cause': '<shared root cause>'}
      ],
      'uncorrelated': []
  }
  json.dump(clusters, open('.claude/resolve-clusters.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Issues grouped into clusters (or marked uncorrelated)
- Each cluster has a designated primary issue
- `.claude/resolve-clusters.json` exists

**VERIFY:**
```bash
test -f .claude/resolve-clusters.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 4b
```

**NEXT:** Read [state-5-fix-design.md](state-5-fix-design.md) to continue.
