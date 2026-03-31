# STATE 6: RECONCILE

**PRECONDITIONS:**
- STATE 5 POSTCONDITIONS met (all modules hardened, tests passing, build passing)

**ACTIONS:**

**Consistency reconciliation**: After all implementer worktrees are merged, scan the combined result for:
- **Naming**: grep for similar functions across hardened modules (e.g., multiple `validate*Email` variants). Pick the most descriptive name and rename others.
- **Error patterns**: check API route handlers for response shape consistency. Normalize to the most common pattern.
- **Duplicate utilities**: if 3+ near-identical logic blocks exist, extract to shared utility (per Rule 4).
- **Import style**: normalize to the convention in the framework stack file.
Budget: 5 minutes. Only fix what is listed above.

Update checkpoint to `step3-reconcile`.

**POSTCONDITIONS:**
- Naming consistency verified across hardened modules
- Error response patterns consistent
- No duplicate utilities (3+ copies)
- Import style normalized
- Checkpoint updated to `step3-reconcile`

**VERIFY:**
```bash
npm run build 2>/dev/null
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh harden 6
```

**NEXT:** Read [state-7-persist-on-touch.md](state-7-persist-on-touch.md) to continue.
