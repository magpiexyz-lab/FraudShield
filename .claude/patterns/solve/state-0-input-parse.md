# STATE 0: INPUT_PARSE

**PRECONDITIONS:**
- User has invoked `/solve` with arguments

**ACTIONS:**

Read the problem statement from the user's arguments: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask the user to describe the problem.

### Depth Selection

- Default: `full` (4 Opus agents, ~3 min)
- If user includes `--light` or `--quick` in arguments: use `light` mode (~30s, 0 agents)
- If user includes `--full` in arguments: use `full` mode

### Worktree Isolation

Enter an isolated worktree so concurrent `/solve` runs don't collide on `.runs/`:

1. Call the `EnterWorktree` tool with name `"solve-<current-timestamp>"` (e.g., `solve-2026-04-08T03-15-00Z`)
2. If EnterWorktree succeeds: run `mkdir -p .runs` (fresh worktree has no `.runs/`)
3. If EnterWorktree fails (e.g., already in a worktree): continue normally in the current directory

Remember whether you entered a worktree — STATE 3 needs this to know whether to call ExitWorktree.

Clean stale epilogue artifacts and create context file to initialize state tracking:
```bash
rm -f .runs/observe-result.json
bash .claude/scripts/init-context.sh solve
```

**POSTCONDITIONS:**
- Problem statement captured (from arguments or user input)
- Depth mode selected (`full` or `light`)
- `.runs/solve-context.json` exists

**VERIFY:**
```bash
test -f .runs/solve-context.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh solve 0
```

**NEXT:** Read [state-1-execute.md](state-1-execute.md) to continue.
