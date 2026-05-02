# Bound-Target Write-Guard Pattern

A pattern catalog for **Bash-matcher PreToolUse hooks that protect a path via
shell-redirect detection**. The pattern class is a peer to
`silent-failure-prevention.md`, but addresses a different defect axis:
silent-failure hooks suffer from intent-not-applied; bound-target write-guards
suffer from over-block / false-positive caused by **unbound co-occurrence
regex**.

The canonical fix shape is **bound-target adjacency in the deny predicate**:
the write operator (`>`, `>>`, `&>`, `tee`, `cp`, `mv`, `dd`) must be matched
**immediately adjacent** to the protected path target — not merely co-present
in the same shell segment. Without bound-target adjacency, a command like
`cat <protected> | tee /tmp/elsewhere` (read protected, write elsewhere)
matches both regexes and is wrongly denied.

This file is the canonical convention doc for the
`bash_hook_write_operator_binding` rule (issue #1236) declared in
`.claude/patterns/template-coherence-rules.json` and registered against the
manifest at `.claude/patterns/write-guard-hooks.json`.

## The Anti-Pattern

Three concrete buggy shapes have recurred across 7 historical issues. Each
shape was introduced by a maintainer who reused an earlier hook's structural
shape without internalizing the bound-target invariant.

### Shape A — `grep -qE` with `.*` between operator and path

This is the #1230 / pre-#1185 shape. The `.*` separator allows ANY tokens
between the operator and the protected path, so the regex matches commands
that mention the path in unrelated positions (heredoc bodies, stderr
redirection chains, `cat $path | <something>` reads).

```bash
# BUG: false-positive on `cat agent-spawn-log.jsonl | grep ...`
if echo "$NORM" | grep -qE '(>|>>|&>|tee|cp|mv|dd).*agent-spawn-log\.jsonl'; then
  deny "..."
fi
```

### Shape B — `awk` co-occurrence joined by `&&`

This is the original co-occurrence shape. Two regex literals joined by `&&`
match a single record when both regexes match anywhere in the record — there
is no positional binding between the operator and the path target.

```bash
# BUG: false-positive on `cat agent-traces/foo.json | tee /tmp/copy`
if echo "$NORM" | awk '/agent-traces\// && /(>|>>|tee|cp|mv|dd)/ { print 1; exit }' | grep -q 1; then
  deny "..."
fi
```

### Shape C — bare `match($0, /<op>.*<path>/)` without adjacency

A subtler variant: `match()` takes a single regex pattern, but `.*` between
the operator and the path defeats the bound-target invariant inside the
match. Functionally equivalent to Shape A.

```bash
# BUG: same defect as Shape A, expressed via awk match()
if echo "$NORM" | awk 'match($0, /(>|>>|tee|cp|mv|dd).*agent-traces\//) { print 1 }' | grep -q 1; then
  deny "..."
fi
```

## The Canonical Bound-Target Shape

The post-#1230 `trace-write-guard.sh` is the canonical reference. It uses a
two-pass `sed` normalization to strip read-only fd redirects (`2>/dev/null`,
`2>&1`), then `awk` with `RS="[&|;]"` to split the command into segments and
match the write operator **immediately adjacent** to the protected path
target within a single segment.

```bash
NORM=$(printf '%s' "$COMMAND" \
  | sed -E 's/[0-9]*>+&[0-9]+//g' \
  | sed -E 's/>&[[:space:]]+([^[:space:]]+)/> \1/g')

if printf '%s\n' "$NORM" \
  | awk 'BEGIN { RS="[&|;]" }
         match($0, /([0-9]*&?>+|[0-9]*>>?)[[:space:]]*["'"'"']?[^|;&"'"'"']*agent-spawn-log\.jsonl/) ||
         match($0, /(tee|cp|mv|dd)[[:space:]]+["'"'"']?[^|;&"'"'"']*agent-spawn-log\.jsonl/) { print 1; exit }' \
  | grep -q 1; then
  deny "..."
fi
```

The key invariants:

1. **Pass 1 (sed)**: strip fd-to-fd redirects (`2>&1`, `1>&2`) so they cannot
   match the write-operator regex.
2. **Pass 2 (sed)**: collapse `>& filename` to `> filename` for GNU-bash
   compatibility.
3. **`RS="[&|;]"`**: split on shell segment separators so each `awk` record
   is a single command segment. Adjacent matches in the SAME segment are
   bound; cross-segment matches are not.
4. **`match($0, /<op>[[:space:]]*["']?[^|;&"']*<path>/)`**: explicit adjacency
   — the write operator and the protected-path target must be in the same
   segment with only whitespace, optional quotes, and non-separator chars
   between them.

## Catalogued Issues

Each entry below names the historical defect, its buggy shape (verbatim from
the pre-fix git history where possible), and the fixed shape. The canonical
test fixtures in `.claude/scripts/tests/test_bash_hook_write_operator_binding.py`
must replay each buggy shape and assert the rule flags it.

### #1023 — `agent-trace-write-guard.sh` first instance
- **Symptom:** Bash command writing to `.runs/agent-traces/foo.json` was
  blocked unless it used the canonical `> file` shape; chained reads were
  also denied.
- **Buggy shape:** Shape A (`grep -qE`).
- **Fix:** Migrate to bound `match()` with adjacency.

### #1045 — `agent-trace-write-guard.sh` regression
- **Symptom:** Sibling defect — co-occurrence regex re-introduced when
  adding `cp`/`mv` operators.
- **Buggy shape:** Shape B (awk co-occurrence with `&&`).
- **Fix:** Move `cp`/`mv` into the bound match.

### #1064 — chain-blocked `echo > file` pattern
- **Symptom:** Heredoc bodies containing the protected path triggered
  false-positive deny on commands that wrote elsewhere.
- **Buggy shape:** Shape A in a chained context.
- **Fix:** Strip heredoc bodies before regex match.

### #1123 — co-occurrence false-positives
- **Symptom:** `cat agent-traces/x.json | tee /tmp/copy` denied even though
  the write target was `/tmp/copy`, not the protected path.
- **Buggy shape:** Shape B.
- **Fix:** Bound the write operator to the protected target via positional
  match.

### #1185 — unbounded `.*` redux
- **Symptom:** Same defect as #1123 in a different code path.
- **Buggy shape:** Shape A re-introduced during a refactor.
- **Fix:** Replace with bound `match()` per the canonical shape.

### #1223 — `state-completion-gate.sh` substring grep
- **Symptom:** Different defect class — substring grep over-fired on heredoc
  bodies mentioning `advance-state.sh`.
- **Note:** This is **not** a bound-target write-guard defect. It is a
  separate command-invocation parsing class fixed via heredoc-strip + shlex
  tokenization in `.claude/scripts/lib/check-advance-state-invocation.py`.
  Listed here for traceability — the `bash_hook_write_operator_binding` rule
  does **not** scope-creep to cover this class.

### #1230 — `trace-write-guard.sh` over-block
- **Symptom:** Sibling defect to #1185 in `trace-write-guard.sh`. Pre-fix
  `grep -qE '(>|>>|tee|cp|mv|dd).*agent-spawn-log'` matched legitimate read
  pipelines.
- **Buggy shape:** Shape A.
- **Fix:** Migrate to bound `match()` per the canonical shape (this is the
  pattern shown above as the canonical reference).

## Pattern Maintenance

When adding a new entry to the manifest at
`.claude/patterns/write-guard-hooks.json`:

- Verify the hook source contains the literal `protected_path_regex` string
  (this is the textual proof that a bound `match()` references it).
- Verify every declared `write_operator` appears in the hook source.
- Add a fixture to `test_bash_hook_write_operator_binding.py` lifting the
  pre-fix buggy regex from git history; assert the rule flags it.
- Update the catalogued issues section above with the new defect entry.

When adding a new write-guard hook (sibling to the existing four):

- Add a manifest entry first; the linter rule will then fire on any
  unregistered match in the hook source until the manifest is correct.
- Use the canonical bound-target shape from the canonical reference above.
  Do not invent a new structural shape without first updating this doc and
  the linter rule.

When the linter fires on a legitimate fast-path filter (e.g., a glob-prefix
detection step that uses unbound co-occurrence as a cheap pre-filter before
a downstream bound check), suppress with the pragma:

```bash
# coherence-allow: unbound-fastpath
```

The pragma must appear within ±200 chars of the matched anti-pattern.
Document the legitimate intent in a code comment immediately above the
pragma.
