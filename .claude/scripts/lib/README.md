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
  stack_scope: scripts/lib
composite_identity_hash: 4716610c2cb5
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
  stack_scope: scripts/lib
composite_identity_hash: f3304d1e77cc
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

---

## Existing helpers (no Stack Knowledge — single-caller or in-flux)

- `auth_routing.py` — auth provider routing (used by setup scripts)
- `concern_id.py` — solve-critic concern ID generation
- `derive_pages.py` — page set derivation from experiment.yaml
- `derive_slot_intent.py` — slot intent derivation for image generation
- `dossier_builder.py` — RMG v2 prior-failure dossier builder
- `iterate_cross_verdicts.py` — /iterate cross-skill verdict aggregation
- `recurrence_guard_parser.py` — recurrence guard YAML parser
- `render_context.py` — context rendering helper
- `slot_intent_schema.py` — manual JSON schema validator (no jsonschema dep)
- `stack_knowledge_audit.py` — nightly stack-knowledge issue filing
- `symptom_canonicalizer.py` — symptom string canonicalization
- `validate_evidence.py` — evidence-set validation
