# Makefile — Shortcuts for running experiment workflows
#
# Run `make` or `make help` to see available commands.

.DEFAULT_GOAL := help

.PHONY: help validate distribute verify-local test-e2e deploy setup-prod migrate clean clean-all supabase-start supabase-stop sync-verify

help: ## Show this help message
	@echo "Usage: make <command>"
	@echo ""
	@echo "Commands:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'
	@echo ""
	@echo "AI skills (run in Claude Code):"
	@echo "  /bootstrap       Scaffold the full MVP from experiment.yaml"
	@echo "  /change ...      Make a change (e.g., /change fix the signup button)"
	@echo "  /iterate         Review metrics and get recommendations"
	@echo "  /retro           Run a retrospective and file feedback"
	@echo "  /distribute      Generate distribution campaign config from experiment.yaml"
	@echo "  /verify          Run E2E tests and fix failures"
	@echo "  /deploy          Deploy to Vercel + Supabase (first-time setup)"
	@echo "  /review          Automated review-fix loop (maintainers only)"

sync-verify: ## Sync VERIFY commands from state-registry.json to state files
	@bash .claude/scripts/sync-verify-to-state-files.sh

validate: ## Check experiment.yaml for valid YAML, TODOs, name format, and structure
	@echo "Validating experiment/experiment.yaml..."
	@if [ ! -f experiment/experiment.yaml ]; then \
		echo "Error: experiment/experiment.yaml not found. Copy the example: cp experiment/experiment.example.yaml experiment/experiment.yaml"; \
		exit 1; \
	fi
	@command -v python3 >/dev/null 2>&1 || { \
		echo "Error: Python3 is required for validation but was not found."; \
		echo "Fix: install Python3 from https://python.org (or: brew install python3)"; \
		exit 1; \
	}
	@python3 -c "import yaml" 2>/dev/null || { \
		echo "Error: PyYAML is not installed (needed for YAML validation)."; \
		echo "Fix: run 'pip3 install pyyaml' (if that fails: 'pip3 install --user pyyaml' or 'brew install python-pyyaml')"; \
		exit 1; \
	}
	@python3 -c "import yaml; yaml.safe_load(open('experiment/experiment.yaml'))" 2>/dev/null || { \
		echo "Error: experiment/experiment.yaml has invalid YAML syntax."; \
		echo "Check for indentation errors or missing colons."; \
		exit 1; \
	}
	@if grep -q 'TODO' experiment/experiment.yaml; then \
		echo ""; \
		echo "Found TODO placeholders that need to be filled in:"; \
		grep -n 'TODO' experiment/experiment.yaml; \
		echo ""; \
		echo "Replace every TODO before running make bootstrap."; \
		exit 1; \
	fi
	@# validate-experiment.py checks: name format, archetype structure, required fields, stack files, testing warning, assumes
	@STACK_WARN=0; \
	python3 scripts/validate-experiment.py || STACK_WARN=$$?; \
	if [ "$$STACK_WARN" -ne 0 ] && [ "$$STACK_WARN" -ne 2 ]; then echo "Experiment validation failed — fix the errors above in experiment/experiment.yaml, then re-run 'make validate'."; exit 1; fi; \
	if [ -f experiment/EVENTS.yaml ]; then \
		python3 scripts/validate-events.py || exit 1; \
		echo "experiment/EVENTS.yaml looks good — valid structure."; \
	else \
		echo "Warning: experiment/EVENTS.yaml not found — /bootstrap will fail. Ensure experiment/EVENTS.yaml exists in the experiment/ folder."; \
	fi; \
	python3 scripts/validate-semantics.py || { echo "Semantic validation failed — fix the errors above, then re-run 'make validate'."; exit 1; }; \
	if [ "$$STACK_WARN" -eq 2 ]; then \
		echo "Validation passed with warnings — review the issues above. These are non-blocking but should be addressed before /bootstrap."; \
	else \
		echo "Validation passed — experiment.yaml and experiment/EVENTS.yaml look good."; \
	fi; \
	if [ -f package.json ]; then \
		echo "Note: project is already bootstrapped. Open Claude Code and run /change to make changes."; \
	fi

distribute: ## Validate experiment/ads.yaml (valid YAML, schema, budget limits)
	@if [ ! -f experiment/ads.yaml ]; then echo "No experiment/ads.yaml found. Run /distribute in Claude Code to generate it."; exit 0; fi; \
	python3 -c "import yaml; yaml.safe_load(open('experiment/ads.yaml'))" 2>/dev/null || { echo "Error: experiment/ads.yaml has invalid YAML syntax."; exit 1; }; \
	python3 -c "\
	import yaml, sys; \
	data = yaml.safe_load(open('experiment/ads.yaml')); \
	channel = data.get('channel', 'google-ads'); \
	universal_req = ['campaign_name','project_name','landing_url','budget','targeting','conversions','guardrails','thresholds']; \
	errors = [f'missing required key: {k}' for k in universal_req if k not in data]; \
	if channel == 'google-ads': \
	    errors += ['missing required key: keywords'] if 'keywords' not in data else []; \
	    errors += ['missing required key: ads'] if 'ads' not in data else []; \
	    kw = data.get('keywords', {}); \
	    kw_ok = isinstance(kw, dict); \
	    errors += ['keywords.exact needs >= 3'] if kw_ok and len(kw.get('exact', []) or []) < 3 else []; \
	    errors += ['keywords.phrase needs >= 2'] if kw_ok and len(kw.get('phrase', []) or []) < 2 else []; \
	    errors += ['keywords.broad needs >= 1'] if kw_ok and len(kw.get('broad', []) or []) < 1 else []; \
	    errors += ['keywords.negative needs >= 2'] if kw_ok and len(kw.get('negative', []) or []) < 2 else []; \
	    al = data.get('ads', []); \
	    al_ok = isinstance(al, list); \
	    errors += ['ads needs >= 2 variations'] if al_ok and len(al) < 2 else []; \
	    errors += [f'ads[{i}] needs >= 5 headlines' for i, a in enumerate(al or []) if isinstance(a, dict) and len(a.get('headlines', []) or []) < 5]; \
	    errors += [f'ads[{i}] needs >= 2 descriptions' for i, a in enumerate(al or []) if isinstance(a, dict) and len(a.get('descriptions', []) or []) < 2]; \
	elif channel == 'twitter': \
	    errors += ['missing required key: tweets'] if 'tweets' not in data else []; \
	    tw = data.get('tweets', []); \
	    tw_ok = isinstance(tw, list); \
	    errors += ['tweets needs >= 2 variations'] if tw_ok and len(tw) < 2 else []; \
	    errors += [f'tweets[{i}] text exceeds 280 chars' for i, t in enumerate(tw or []) if isinstance(t, dict) and len(t.get('text', '')) > 280]; \
	elif channel == 'reddit': \
	    errors += ['missing required key: posts'] if 'posts' not in data else []; \
	    po = data.get('posts', []); \
	    po_ok = isinstance(po, list); \
	    errors += ['posts needs >= 2 variations'] if po_ok and len(po) < 2 else []; \
	    errors += [f'posts[{i}] headline exceeds 300 chars' for i, p in enumerate(po or []) if isinstance(p, dict) and len(p.get('headline', '')) > 300]; \
	b = data.get('budget', {}); \
	t = b.get('total_budget_cents', 0) if isinstance(b, dict) else 0; \
	errors += [f'budget.total_budget_cents ({t}) exceeds max 50000'] if t and t > 50000 else []; \
	g = data.get('guardrails', {}); \
	g_ok = isinstance(g, dict); \
	if channel == 'google-ads': \
	    errors += ['guardrails.max_cpc_cents missing'] if g_ok and g.get('max_cpc_cents') is None else []; \
	    errors += [f'guardrails.max_cpc_cents must be int > 0 (got {g.get(\"max_cpc_cents\")!r})'] if g_ok and g.get('max_cpc_cents') is not None and (not isinstance(g.get('max_cpc_cents'), int) or g.get('max_cpc_cents') <= 0) else []; \
	th = data.get('thresholds', {}); \
	th_ok = isinstance(th, dict); \
	errors += ['thresholds.expected_activations missing'] if th_ok and th.get('expected_activations') is None else []; \
	errors += [f'thresholds.expected_activations must be int >= 0 (got {th.get(\"expected_activations\")!r})'] if th_ok and th.get('expected_activations') is not None and (not isinstance(th.get('expected_activations'), int) or th.get('expected_activations') < 0) else []; \
	errors += ['thresholds.go_signal must be a non-empty string'] if th_ok and (not th.get('go_signal') or not isinstance(th.get('go_signal'), str)) else []; \
	errors += ['thresholds.no_go_signal must be a non-empty string'] if th_ok and (not th.get('no_go_signal') or not isinstance(th.get('no_go_signal'), str)) else []; \
	[print(f'  - {e}') for e in errors] if errors else None; \
	sys.exit(1) if errors else print(f'experiment/ads.yaml looks good — valid {channel} schema.'); \
	"

supabase-start: ## Start local Supabase for testing (requires Docker)
	@if [ ! -f supabase/config.toml ]; then \
		echo "Error: supabase/config.toml not found. Run 'npx supabase init' first (bootstrap does this automatically)."; \
		exit 1; \
	fi
	@echo "Starting local Supabase..."
	npx supabase start -x realtime,storage,imgproxy,inbucket,pgadmin-schema-diff,migra,postgres-meta,studio,edge-runtime,logflare,pgbouncer,vector
	@echo "Applying migrations..."
	npx supabase db reset
	@echo "Local Supabase is ready."

supabase-stop: ## Stop local Supabase
	-npx supabase stop

verify-local: ## Verify the app works locally (install, test, cleanup)
	@bash scripts/verify-local.sh

test-e2e: ## Run E2E / integration tests
	@if [ -f playwright.config.ts ]; then \
		npx playwright test; \
	elif [ -f vitest.config.ts ]; then \
		npx vitest run; \
	else \
		echo "No test configuration found — run '/change add tests' to set up testing"; \
	fi

# Default: Vercel. Update this target if you change stack.hosting.
deploy: ## Deploy to Vercel (first run will prompt to link project)
	@if [ ! -f package.json ]; then \
		echo "Error: No package.json found. Run /bootstrap first."; \
		exit 1; \
	fi
	@if [ -f experiment/experiment.yaml ]; then \
		HOSTING=$$(python3 -c "import yaml; d=yaml.safe_load(open('experiment/experiment.yaml')); print(next((s.get('hosting','') for s in d.get('stack',{}).get('services',[]) if isinstance(s,dict)),d.get('stack',{}).get('hosting','')))" 2>/dev/null); \
		ARCHETYPE=$$(python3 -c "import yaml; d=yaml.safe_load(open('experiment/experiment.yaml')); print(d.get('type','web-app'))" 2>/dev/null); \
		if [ -z "$$HOSTING" ] && [ "$$ARCHETYPE" = "cli" ]; then \
			echo "CLI archetype detected. Use 'npm publish' to publish to npm, or create a GitHub Release."; \
			echo "For the marketing surface (if configured): run '/deploy' in Claude Code."; \
			exit 1; \
		fi; \
		if [ -n "$$HOSTING" ] && [ "$$HOSTING" != "vercel" ]; then \
			echo "Warning: stack.hosting is '$$HOSTING', but this Makefile only supports Vercel."; \
			echo "Use the /deploy skill in Claude Code — it reads your hosting stack file and handles any provider."; \
			echo "Or deploy directly from your terminal using your hosting provider's CLI."; \
			exit 1; \
		fi; \
	fi
	@echo "Deploying to Vercel..."
	npx vercel deploy --prod
	@echo "Checking deployment health..."
	@DEPLOY_URL=$$(npx vercel inspect --json 2>/dev/null | python3 -c "import sys,json; print('https://'+json.load(sys.stdin).get('alias',[''])[0])" 2>/dev/null); \
	if [ -n "$$DEPLOY_URL" ] && curl -sf "$$DEPLOY_URL/api/health" > /dev/null 2>&1; then \
		echo "Health check passed: $$DEPLOY_URL/api/health"; \
	else \
		echo "Warning: Could not verify health endpoint. Check your deployment manually."; \
	fi
	@echo ""
	@echo "Note: 'make deploy' does not create .runs/deploy-manifest.json."
	@echo "The /teardown and /iterate skills require this manifest. For full lifecycle"
	@echo "support (teardown, iterate, distribute), use the /deploy skill in Claude Code instead."

setup-prod: ## Link Vercel + Supabase for production debugging
	@if [ ! -f package.json ]; then \
		echo "Error: No package.json found. Run /bootstrap first."; \
		exit 1; \
	fi
	@echo "Linking Vercel project..."
	@npx vercel link || { echo "Error: run 'npx vercel login' first, then retry."; exit 1; }
	@echo ""
	@echo "Linking Supabase project..."
	@if [ ! -f experiment/experiment.yaml ]; then \
		echo "Error: experiment/experiment.yaml not found."; exit 1; \
	fi
	@REF=$$(python3 -c "import yaml; d=yaml.safe_load(open('experiment/experiment.yaml')); print(d.get('supabase_project_ref',''))" 2>/dev/null); \
	if [ -n "$$REF" ]; then \
		npx supabase link --project-ref "$$REF"; \
	else \
		echo "Enter your Supabase project ref (Dashboard → Settings → General → Reference ID):"; \
		read -r REF; \
		npx supabase link --project-ref "$$REF"; \
	fi
	@echo ""
	@echo "Done. Claude Code can now debug production issues directly."

migrate: ## Push pending migrations to remote Supabase database
	@if [ ! -f package.json ]; then \
		echo "Error: No package.json found. Run /bootstrap first."; \
		exit 1; \
	fi
	@if [ ! -d supabase/migrations ]; then \
		echo "Error: supabase/migrations/ not found. No migrations to push."; \
		exit 1; \
	fi
	@if [ -z "$$(ls -A supabase/migrations/ 2>/dev/null)" ]; then \
		echo "No migration files in supabase/migrations/. Nothing to push."; \
		exit 0; \
	fi
	@echo "Pushing migrations to remote Supabase..."
	npx supabase db push
	@echo "Migrations applied successfully."

# Default artifacts for all archetypes. Update if you change stack.framework or stack.ui.
# DO NOT delete .claude/commands/, .claude/patterns/, .claude/stacks/,
# .claude/archetypes/, .claude/hooks/, .claude/scripts/, .claude/agents/,
# .claude/procedures/, .claude/orchestration/ — these are template-owned.
clean: ## Remove generated files (lets you re-run bootstrap)
	rm -rf node_modules .next out                          # framework/nextjs
	rm -rf dist                                            # framework/hono, framework/commander
	rm -f .nvmrc package.json package-lock.json tsconfig.json next.config.ts next-env.d.ts eslint.config.mjs  # framework/nextjs
	rm -f components.json tailwind.config.ts .eslintrc.json eslint.config.mjs postcss.config.mjs  # ui/shadcn
	rm -rf src                                             # all generated app code
	rm -f .env.example                                     # all stacks
	rm -rf e2e playwright.config.ts test-results playwright-report blob-report  # testing/playwright
	rm -rf tests vitest.config.ts                          # testing/vitest
	rm -rf public docs                                     # bootstrap-generated assets and docs
	rm -rf public/images                                   # images/fal
	rm -rf .runs .verify-baseline                          # skill execution state
	rm -rf .vercel                                         # Vercel CLI config
	rm -f vercel.json tsconfig.tsbuildinfo                 # deploy and build config
	rm -f externals-decisions.json run-skill.sh            # bootstrap artifacts
	rm -f .gitleaks.toml                                   # bootstrap-generated config
	rm -f .env.local .env                                  # runtime credentials
	@echo "Cleaned. You can now open Claude Code and run /bootstrap again."
	@echo "Note: experiment/experiment.yaml, experiment/EVENTS.yaml, and supabase/ were NOT removed. Use 'make clean-all' for a full reset."

clean-all: ## Remove everything including migrations (full reset)
	@echo "This will delete ALL generated files including database migrations."
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ] || { echo "Cancelled."; exit 1; }
	$(MAKE) clean
	rm -rf supabase
	@echo "Full reset complete. You can now open Claude Code and run /bootstrap again."
