# `.claude/scripts/lib/` — Reusable helpers

Python helpers + bash utilities reusable across template scripts. Keep this directory **small and load-bearing** — only add a helper here when 2+ callers will use it (per CLAUDE.md Rule 4: 3+ similar lines is better than premature abstraction; new lib entries should beat that bar with concrete reuse, not hypothetical).

## Discovery convention

When a helper is intentionally **template-level reusable** (i.e. designed to be the canonical mechanism for solving a class of problem in any future fix), document it with a `## Stack Knowledge` section below. The convention mirrors `.claude/stacks/**/*.md` `## Stack Knowledge` sections so that:

- `/solve` Phase 1 Agent 2 (Prior Art) can grep `composite_identity` and surface the entry as `fix_template` candidate
- `/resolve` diagnosis can locate prior solutions for similar issues
- Future PRs that re-invent an existing solution get caught at review

This is the runtime-discoverable side of the auto-discovery mechanism (#1285) — solving the "reusables built by one /solve are invisible to the next" problem incrementally for the helpers that are most likely to be reused.

Helpers NOT intended for reuse (one-off utilities, single-caller adapters) should NOT have a `## Stack Knowledge` section. The conservative bar: add when first concrete second caller demonstrates reuse value, not on first introduction.

---

## Stack Knowledge

### perceptual-hash + provenance binding for image evidence
```yaml
id: image-evidence-provenance-phash
maturity: stable
anti_pattern: false
composite_identity:
  root_cause_class: agent-fabricates-image-evidence
  divergence_pattern: physical-artifact-required-but-pixel-only-check-bypassable
  stack_scope: scripts/lib/phash
composite_identity_hash: 39ae7c5e3170
symptom_keywords: [image, screenshot, evidence, candidate, provenance, phash, fabrication, design-critic, candidates_tried]
confidence_score: 0.85
occurrence_count: 1
linked_issues: [1276, 1272, 1261, 1252, 1255]
first_seen: 2026-05-04
last_seen: 2026-05-04
graduated_to: null
prevention_mechanism: |
  phash.check_image_magic + read_provenance + validate_provenance_triple_unique
  enforce that every candidate has an independent (model, prompt_hash, seed)
  triple sourced from the generation provider — LLMs cannot fabricate triples
  the API never produced.
fix_template: |
  When validating that an LLM agent has actually produced distinct image
  candidates (not labeled the same image as N candidates), require BOTH:
    (a) magic-byte + min-dimension check on each file (phash.check_image_magic
        + check_image_min_dimensions)
    (b) sibling <image>.provenance.json with (model, prompt_hash, seed)
        triple, joined and asserted UNIQUE per candidate set
        (phash.read_provenance + validate_provenance_triple_unique)
  Pixel-only perceptual hash is bypassable by trivial transforms (rotate,
  re-compress) — round-2 critic Concern 1. The provenance triple is the
  load-bearing check: LLMs cannot fabricate a fal API generation parameter
  that the API never produced.

  Usage:
    from lib.phash import (
        check_image_magic, read_provenance,
        validate_provenance_triple_unique, validate_phash_diversity,
    )
    errors = []
    provs = []
    for cand in slot_candidates:
        if check_image_magic(cand) is None:
            errors.append(f"{cand}: not PNG/WebP")
            continue
        try:
            provs.append(read_provenance(cand))
        except FileNotFoundError:
            errors.append(f"{cand}: missing provenance JSON sibling")
    errors.extend(validate_provenance_triple_unique(provs))
```

### schema_version bound to run_id timestamp (downward-stamp defense)
```yaml
id: schema-version-run-id-binding
maturity: stable
anti_pattern: false
composite_identity:
  root_cause_class: llm-stamps-old-schema-version-to-bypass-new-validators
  divergence_pattern: agent-controls-its-own-versioning-stamp
  stack_scope: scripts/lib/schema_version_gate
composite_identity_hash: 78138f4fc66c
symptom_keywords: [schema_version, backwards_compat, migration, runid, bypass, downward_stamp, validator_skip]
confidence_score: 0.70
occurrence_count: 1
linked_issues: [1276, 1272, 1261, 1252, 1255]
first_seen: 2026-05-04
last_seen: 2026-05-04
graduated_to: null
prevention_mechanism: |
  lib.schema_version_gate.check_artifact_schema_version binds the effective
  schema version to the run_id timestamp set by init-context.sh before any
  LLM action, so an agent cannot down-stamp schema_version to bypass a newly
  added v2 gate.
fix_template: |
  When adding required fields to .runs/ artifacts, do NOT trust agent-stamped
  schema_version. Bind the EFFECTIVE schema version to the run_id timestamp
  (set by init-context.sh BEFORE any LLM action via `date -u`):

    from lib.schema_version_gate import check_artifact_schema_version
    ok, msg, ver = check_artifact_schema_version(path, run_id)
    if not ok:
        sys.exit(1)  # downward-stamp blocked
    if ver < 2:
        sys.exit(0)  # grandfathered — skip new gates
    # ... enforce v2-required fields

  Replace MIGRATION_CUTOFF_ISO placeholder with the PR-merge commit
  timestamp via post-merge sed, so the gate is INERT until merge and
  active immediately after.
```

### validator meta-test (anti-softening property tests)
```yaml
id: validator-meta-test-pattern
maturity: stable
anti_pattern: false
composite_identity:
  root_cause_class: future-pr-softens-validator-to-no-op
  divergence_pattern: hard-block-validator-survives-by-meta-property-test
  stack_scope: scripts/tests
composite_identity_hash: 4c517663dd57
symptom_keywords: [validator, softening, no-op, meta-test, ci, regression, defense-in-depth, cross-state, coverage-gap, aggregate-trace]
confidence_score: 0.75
occurrence_count: 2
linked_issues: [1276, 1272, 1261, 1252, 1255, 1294]
first_seen: 2026-05-04
last_seen: 2026-05-05
graduated_to: null
prevention_mechanism: |
  .claude/scripts/tests/test_validators_meta.py drives every hard-block
  validator with synthetic invalid input and asserts non-zero exit code,
  blocking future PRs from softening `assert <cond>` to `print("WARN");
  sys.exit(0)`. Cross-state coverage sub-pattern (added per #1294) extends
  the meta-test surface to enforce that every validator wired into
  state-registry.json appears in the VALIDATORS allowlist AND every
  scaffold-* spawn site has a downstream validator-state.
fix_template: |
  When shipping a hard-block validator (any script invoked by
  state-completion-gate.sh or lifecycle-finalize.sh that exit 1 on failure),
  ALSO add a meta-test in .claude/scripts/tests/test_validators_meta.py
  that exercises the validator with synthetic INVALID inputs and asserts
  non-zero exit code. This blocks future PRs from softening
  `assert <condition>` to `print("WARN"); sys.exit(0)`.

  Pattern (model after .claude/scripts/tests/test_validate_recovery.py):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="test_v_"))
        subprocess.run(["git", "init", "-q", str(self.tmp)], check=True)
        # Populate fixtures

    def test_synthetic_invalid_input(self):
        # Write malformed fixture
        result = subprocess.run(
            ["python3", str(VALIDATOR), ...],
            cwd=self.tmp, capture_output=True, text=True
        )
        self.assertNotEqual(result.returncode, 0)

  CI auto-discovers .claude/scripts/tests/test_*.py via .github/workflows/ci.yml
  (do NOT place under top-level tests/ — that is NOT in CI discovery).

  ---

  Cross-state coverage sub-pattern (added per #1294).

  When a validator must run at MULTIPLE state-registry entries (e.g., one
  per spawn-site downstream), declare an explicit allowlist in VALIDATORS:

    "validate-X.py": {
      "ref_files": [".claude/patterns/state-registry.json"],
      "state_registry_states": [("bootstrap", "11b"), ("bootstrap", "11c"), ...],
    }

  Then add four cooperating meta-tests:
    D-2 explicit: each (skill, state_id) in state_registry_states must have
        the validator chained in its verify command.
    D-3 auto-discovery: walk `.claude/skills/**/state-*.md` for the canonical
        spawn marker `^\s*-\s*subagent_type:\s*<agent-prefix>-[a-z-]+\s*$`
        (line-anchored, MULTILINE). For each match, assert a downstream
        allowlisted state exists. Walks ALL skills — future scaffold-*
        spawns in /change /upgrade /resolve auto-fail until wired.
    D-4 superset: allowlist must cover every present spawn site (catches
        accidental allowlist deletions).
    D-5 inverse drift: every state-registry mention of the validator must
        appear in the allowlist (catches: maintainer wires a new state
        without updating VALIDATORS dict).

  Aggregate-trace propagation (sibling pattern).

  When a state-machine merges per-agent traces into an aggregate (e.g.,
  merge-scaffold-pages-traces.py merging scaffold-pages-<slug>.json into
  scaffold-pages.json), the merger MUST propagate validator-required
  schema fields into the aggregate. Validators glob over .runs/agent-traces
  and apply uniformly to per-agent and aggregate files; without
  propagation the aggregate fails the schema check. Mirror the merger's
  stub-skip partition in the validator (`if status=='started' and not
  verdict: return []`) so rate-limited stubs (#1190) don't trigger
  spurious failures.
```

### canonical-writer policy (Issue #1299)
```yaml
id: canonical-writer-policy-pattern
maturity: stable
anti_pattern: false
composite_identity:
  root_cause_class: state-file-direct-write-antipattern
  divergence_pattern: json.dump-or-Write-instead-of-canonical-writer
  stack_scope: scripts/lib/write-gate-artifact
composite_identity_hash: 25b66de2169e
symptom_keywords: [canonical-writer, gate-readable, GRAIM, write-gate-artifact, identity-stamping, skill-run_id-written_at]
confidence_score: 0.95
occurrence_count: 1
linked_issues: [1299, 1198, 1217]
first_seen: 2026-05-01
last_seen: 2026-05-06
graduated_to: null
prevention_mechanism: |
  Two-layer defense:
    (1) Lint: gate_artifact_writer_enforcement rule
        (.claude/patterns/template-coherence-rules.json) scans state files,
        agents, patterns, procedures, and helper scripts for write-syntax
        tokens (with open(...,'w'|'a'), json.dump-with-open, > path,
        tee path, cat <<EOF > path) targeting paths declared in
        .claude/patterns/gate-readable-artifacts-canonical.json. Severity=warn
        during soak; flips to block in chore/canonical-writer-migration-deny.
        Read syntax (open(...,'r'), json.load, os.path.exists, [-f path],
        backtick prose) is allowlisted at line level (R2-C1 — avoids
        ~455-instance false-positive baseline).
    (2) Hook: gate-artifact-write-gate.sh (Write/Edit matcher, MODE=deny
        since #1217) blocks Write/Edit on manifest paths. Sibling
        gate-artifact-bash-write-guard.sh (Bash matcher, ships in
        chore/canonical-writer-migration-hook-warn) catches direct
        bash redirects, python -c with open() writes, and tee/cat <<EOF
        chains targeting manifest paths.
fix_template: |
  When writing to any path in .claude/patterns/gate-readable-artifacts-canonical.json,
  invoke .claude/scripts/lib/write-gate-artifact.sh with --path and --payload.
  Caller payload MUST NOT include skill/run_id/written_at — the writer
  auto-stamps them.

  Reference (in-skill, normal flow):
    PAYLOAD=$(python3 -c "
    import json
    print(json.dumps({'key': 'value'}))
    ")
    bash .claude/scripts/lib/write-gate-artifact.sh \
      --path .runs/foo.json \
      --payload "$PAYLOAD" \
      --skill <skill>

  Reference (post-completion, AOC v1.2):
    bash .claude/scripts/lib/write-gate-artifact.sh \
      --path .runs/foo.json \
      --payload "$PAYLOAD" \
      --source-run-id "$RUN_ID" \
      --source-skill "$SKILL_KEY"

  Canonical example: .claude/skills/deploy/state-3b-provision-host.md:64-97.

  When migrating an existing direct-write site, run
  .claude/scripts/codemod-canonical-writer.py --dry-run first; the codemod
  handles S1 (with open) and S2 (json.dump-with-open) mechanically and
  emits a manual-review queue for bash-interpolated, conditional, and
  multi-write payloads.
```

### canonical page-inventory derivation from experiment.yaml
```yaml
id: derive-pages-canonical-source-of-truth
maturity: stable
anti_pattern: false
composite_identity:
  root_cause_class: count-based-consumer-recomputes-page-set-from-raw-golden_path
  divergence_pattern: re-implementation-of-page-derivation-instead-of-helper-call
  stack_scope: scripts/lib/derive_pages
composite_identity_hash: 6ebebee1607f
symptom_keywords: [page, golden_path, derive, count, inventory, scope_pages, validation_pages, design-critic, page-set-drift]
confidence_score: 0.90
occurrence_count: 1
linked_issues: [1042, 1300]
first_seen: 2026-04-15
last_seen: 2026-05-08
graduated_to: null
prevention_mechanism: |
  derive_pages.derive_scope_pages / derive_validation_pages / derive_public_paths
  are the single source of truth for "what pages must exist on disk" (SET) and
  "what is the user journey" (LIST). field_role_map rule
  (template-coherence-rules.json) forbids raw `golden_path` access for
  count-based purposes — every consumer must call these helpers.
fix_template: |
  When an agent or script needs to enumerate pages (for design-critic
  spawning, page-image manifest generation, scope verification, etc.), do
  NOT recompute from the raw user-journey field in experiment.yaml. Use the
  helpers:

    from lib.derive_pages import derive_scope_pages, derive_validation_pages
    pages = derive_scope_pages(experiment_yaml_dict)  # SET — must exist on disk
    journey = derive_validation_pages(experiment_yaml_dict)  # LIST — user flow

  The helpers handle auth-derived pages, behavior-derived pages, and
  archetype-specific rules uniformly. Raw access to that field is caught by
  field_role_map at lint time.
```

### shared selector for per-page design-critic traces (epoch suffix routing)
```yaml
id: design-critic-trace-epoch-selector
maturity: stable
anti_pattern: false
composite_identity:
  root_cause_class: stale-trace-shadows-current-verdict-after-recovery-respawn
  divergence_pattern: per-page-trace-aggregation-and-gate-time-acceptance-drift
  stack_scope: scripts/lib/design_critic_trace_selector
composite_identity_hash: 896ff8a3b536
symptom_keywords: [design-critic, trace, epoch, per-page, aggregation, hard-gate, sibling-acceptance, drift]
confidence_score: 0.90
occurrence_count: 1
linked_issues: [1274, 1276, 1300]
first_seen: 2026-05-04
last_seen: 2026-05-08
graduated_to: null
prevention_mechanism: |
  Both write-time aggregation (merge-design-critic-traces.py) and gate-time
  sibling acceptance (evaluate-hard-gate-predicates.py:aggregate_ok) call
  design_critic_trace_selector.select_latest_per_page_traces. The two
  consumers cannot drift on which traces represent "current" verdicts.
fix_template: |
  When implementing logic that reads per-page design-critic traces, do NOT
  glob `.runs/agent-traces/design-critic-*.json` directly:

    from lib.design_critic_trace_selector import select_latest_per_page_traces
    traces = select_latest_per_page_traces(traces_dir)
    # traces: dict[page_key -> trace_path] where epoch-suffixed wins

  Direct glob misses the recovery-respawn epoch convention: a post-fix
  re-spawn writes design-critic-<page>.<epoch>.json which shadows the
  original. Both aggregator and gate must agree on which epoch wins.
```

### canonical bash command canonicalizer (heredoc-body false-positive defense)
```yaml
id: canonical-bash-command-canonicalizer
maturity: stable
anti_pattern: false
composite_identity:
  root_cause_class: hook-regex-matches-protected-token-inside-heredoc-body
  divergence_pattern: shell-grammar-aware-stripping-required-not-string-substring
  stack_scope: scripts/lib/canonicalize_bash_command
composite_identity_hash: c47fd910cde5
symptom_keywords: [hook, bash, regex, heredoc, false-positive, protected-token, write-guard, canonicalize]
confidence_score: 0.85
occurrence_count: 1
linked_issues: [1298, 1300]
first_seen: 2026-05-05
last_seen: 2026-05-08
graduated_to: null
prevention_mechanism: |
  canonicalize_bash_command.strip_heredoc_bodies preserves the introducer
  line (cat <<EOF) but removes the body so hook regex matchers operate on
  the executable surface only — not on data that happens to contain
  protected substrings (writer names, manifest paths, etc.).
fix_template: |
  When a hook needs to scan a Bash command string for protected tokens
  (e.g., write-gate-artifact.sh enforcement), do NOT grep raw $COMMAND:

    from lib.canonicalize_bash_command import canonicalize
    canonical = canonicalize(raw_bash_command)
    # canonical: heredoc bodies stripped, comments preserved
    if PROTECTED_TOKEN in canonical:
        deny(...)

  Raw substring match has a documented false-positive class (#1298): a
  heredoc body containing the writer name (e.g., the README itself) trips
  the guard. The canonicalizer fixes three separate correctness bugs vs.
  the inline strip_heredoc_bodies that previously lived in
  check-advance-state-invocation.py.
```

### CSS/className parser for emitted JSX (slot-intent drift detection)
```yaml
id: jsx-render-context-parser
maturity: stable
anti_pattern: false
composite_identity:
  root_cause_class: declared-render-intent-drifts-from-observed-jsx
  divergence_pattern: shared-parser-required-by-migration-and-drift-detector
  stack_scope: scripts/lib/render_context
composite_identity_hash: 2c16d7c7be23
symptom_keywords: [slot-intent, jsx, render, css, classname, drift, migration, image-generation]
confidence_score: 0.85
occurrence_count: 1
linked_issues: [1077, 1300]
first_seen: 2026-04-20
last_seen: 2026-05-08
graduated_to: null
prevention_mechanism: |
  render_context.extract_render_from_text + find_image_usages + compute_effective_weight
  are shared by migrate-slot-intent.py (legacy backfill) and
  check-slot-intent-drift.py (state-2b drift detector). Both consumers
  parse JSX with identical heuristics — no recomputation drift.
fix_template: |
  When inferring slot intent from JSX (image rendering context, classNames,
  effective weights), call the shared parser:

    from lib.render_context import extract_render_from_text, find_image_usages
    intent = extract_render_from_text(jsx_source)
    usages = find_image_usages(jsx_source)

  The heuristics cover className-based size/aspect inference, Image
  component prop extraction, and Tailwind-utility weight computation. New
  rendering patterns belong in this helper, not in a downstream consumer.
```

### recurrence_guard typed schema parser (RMG v2)
```yaml
id: recurrence-guard-typed-schema-parser
maturity: stable
anti_pattern: false
composite_identity:
  root_cause_class: free-text-recurrence-guard-bypasses-artifact-existence-check
  divergence_pattern: typed-schema-with-tolerant-mode-escape-hatch
  stack_scope: scripts/lib/recurrence_guard_parser
composite_identity_hash: 6d3e59b2bb10
symptom_keywords: [recurrence_guard, RMG, typed-schema, prevention_analysis, solve-trace, lifecycle-finalize, artifact-existence]
confidence_score: 0.95
occurrence_count: 1
linked_issues: [1278, 1300]
first_seen: 2026-04-25
last_seen: 2026-05-08
graduated_to: null
prevention_mechanism: |
  recurrence_guard_parser.parse is the single source of truth for the typed
  prevention_analysis.recurrence_guard field in solve-trace.json. The
  artifact-existence gate (verify-rmg-guard-artifact-in-diff.py) consumes
  the canonical dict shape; free-text strings fail at parse time post-cutover.
fix_template: |
  When writing or consuming a recurrence_guard, ALWAYS go through the parser:

    from lib.recurrence_guard_parser import parse, RecurrenceGuardParseError
    try:
        canonical = parse(guard_value)  # accepts dict OR light-mode bullet
    except RecurrenceGuardParseError as exc:
        sys.exit(f"recurrence_guard does not parse: {exc}")
    # canonical: {"kind", "artifact", "rationale", "unguardability_rationale"?}

  Do NOT hand-roll YAML parsing or accept free-text — the parser enforces
  rationale length (<=200 chars), kind enum, artifact-required-when-not-none,
  and unguardability_rationale-required-when-none. Tolerant mode
  (RMG_V2_TOLERANT=1) is the emergency escape hatch only.
```

### AOC v1.2 source-identity validator (canonical writer post-completion)
```yaml
id: source-identity-validator-aoc-v12
maturity: stable
anti_pattern: false
composite_identity:
  root_cause_class: post-completion-canonical-writer-needs-explicit-source-identity
  divergence_pattern: HC13-cross-skill-forgery-defense
  stack_scope: scripts/lib/source_identity_validator
composite_identity_hash: b6c0ee7d50de
symptom_keywords: [aoc, source-identity, source-run-id, source-skill, post-completion, canonical-writer, HC13, forgery]
confidence_score: 0.90
occurrence_count: 1
linked_issues: [1217, 1198, 1300]
first_seen: 2026-05-01
last_seen: 2026-05-08
graduated_to: null
prevention_mechanism: |
  source_identity_validator.validate_source_identity enforces R1-R4 on
  --source-run-id / --source-skill flags supplied to canonical writers when
  resolve_active_identity returns empty (post-completion). R4 (HC13
  cross-skill forgery gate) blocks same-skill self-attribution.
fix_template: |
  When a canonical writer needs to write AFTER its skill's context is marked
  completed=true (e.g., from skill-epilogue.md or an external script),
  invoke source_identity_validator before stamping identity:

    from lib.source_identity_validator import validate_source_identity
    if not validate_source_identity(source_run_id, source_skill, agent=None):
        sys.exit(1)
    # ... safe to stamp run_id/skill on the artifact

  Equivalently from bash: pass --source-run-id and --source-skill to
  write-gate-artifact.sh; the validator is invoked for you. Don't bypass
  via direct json.dump — gate-artifact-write-gate.sh blocks Write/Edit
  on manifest paths anyway.
```

### symptom canonicalizer for recurrence detection (RMG v2)
```yaml
id: symptom-canonicalizer-stable-signature
maturity: stable
anti_pattern: false
composite_identity:
  root_cause_class: surface-noise-fragments-symptom-grouping-across-recurrences
  divergence_pattern: canonical-form-with-line-position-and-sha-stripping
  stack_scope: scripts/lib/symptom_canonicalizer
composite_identity_hash: eb2482f1d407
symptom_keywords: [symptom, canonicalize, signature, recurrence, RMG, dossier, fix-ledger, grouping]
confidence_score: 0.85
occurrence_count: 1
linked_issues: [1278, 1300]
first_seen: 2026-04-25
last_seen: 2026-05-08
graduated_to: null
prevention_mechanism: |
  symptom_canonicalizer.canonicalize_symptom + symptom_signature_hash
  produce a stable signature for recurrence-detector grouping by stripping
  line/col positions, PR/issue numbers, ISO timestamps, absolute paths, and
  short SHAs. Paraphrased reports collide on the canonical form.
fix_template: |
  When grouping fix-ledger rows by symptom (recurrence detection, dossier
  building, prior-art lookup), canonicalize FIRST:

    from lib.symptom_canonicalizer import canonicalize_symptom, symptom_signature_hash
    sig = canonicalize_symptom(reproductions[0]["actual"])
    sig_hash = symptom_signature_hash(reproductions[0]["actual"])  # 12-char sha1

  Direct string equality misses re-paraphrased symptoms (same root cause,
  different message wording). The canonicalizer's lowercase + position-strip
  + path-strip + sha-strip rules fold variants into a single signature.
```

---

## Existing helpers (no Stack Knowledge — single-caller or in-flux)

These helpers are below the `lib_helper_stack_knowledge_required` rule's `caller_threshold: 2` (per narrow consumption_patterns excluding tests/), so they don't yet need a Stack Knowledge entry. Add an entry only when the helper crosses 2+ production callers.

- `auth_routing.py` — auth provider routing (1 caller: scaffold-wire.md)
- `check-advance-state-invocation.py` — standalone script invoked via subprocess (no Python imports)
- `check-archetype-canonical.py` — standalone script invoked via subprocess (no Python imports)
- `concern_id.py` — solve-critic concern ID generation (1 caller: solve-critic.md)
- `decompose-bash-chain.py` — standalone script invoked via subprocess (no Python imports)
- `derive_slot_intent.py` — slot intent derivation for image generation (1 caller: scaffold-init.md)
- `dossier_builder.py` — RMG v2 prior-failure dossier builder (1 caller: solve-reasoning.md)
- `iterate_cross_verdicts.py` — /iterate cross-skill verdict aggregation (subprocess-only)
- `observer_evidence_families.py` — observer evidence family manifest (1 caller: write-observation-evidence.py)
- `slot_intent_schema.py` — manual JSON schema validator (1 caller: scaffold-init.md)
- `stack_knowledge_audit.py` — nightly stack-knowledge issue filing (subprocess-only)
- `validate_evidence.py` — evidence-set validation (subprocess-only)
