# Experiment Template

![CI](https://github.com/magpiexyz-lab/mvp-template/actions/workflows/ci.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Describe an idea in YAML. Claude Code builds, deploys, and instruments it — under an hour from zero to live MVP with analytics.**

## See it in action

```
> /spec "invoicing tool for freelancers"
✓ Generated experiment/experiment.yaml (L2 interactive MVP, 4 behaviors, 2 variants)

> /bootstrap
✓ Built app — PR #42 opened: https://github.com/you/quick-bill/pull/42
  → Review and merge the PR

> /verify
✓ 10 agents passed (design, security, UX, accessibility, performance, spec)

> /deploy
✓ Live at https://quick-bill.vercel.app
  Supabase project: quick-bill-prod
  PostHog dashboard ready — share the link and watch the funnel
```

## How it works

Every command that writes code shows a plan and waits for your approval before changing anything.

```
    /spec "your idea"  ─or─  edit experiment.yaml manually
                │
       make validate → /bootstrap → merge PR → /verify
                                                    │
                    ┌───────────────────────────────┘
                    │
        ┌───────────┼──────────────┐
        ▼           ▼              ▼
     web-app      service         cli
        │           │              │
   /deploy       /deploy      npm publish
        │           │              │
   /distribute      │              │
   (optional)       │              │
        │           │              │
        └───────────┼──────────────┘
                    │
              Share with users
              Check analytics
                    │
               /iterate
           (recommendations)
                    │
        ┌───────────┼──────────────┐
        ▼           ▼              ▼
   /change                     /retro
   /verify                 (experiment ends)
   merge PR        │              │
        │          │     ┌────────┴────────┐
        └──────────┘     ▼                 ▼
                    /teardown             done
                (web-app / service)      (cli)
```

## What you get

- **3 archetypes** — web-app, service, cli — each with tailored build, deploy, and test pipelines
- **3 experiment levels** — L1 landing test, L2 interactive MVP, L3 full MVP — match effort to conviction
- **16 slash commands** — from `/spec` through `/teardown`, the full experiment lifecycle
- **26 pluggable stack files** — swap frameworks, databases, hosting, and more without changing skills
- **24 specialized agents** — design critic, security attacker/defender, UX journeyer, accessibility scanner, and more run across the lifecycle
- **Production mode** — set `quality: production` for TDD, per-task implementer agents, and spec review
- **Full deploy + teardown** — one command to go live, one command to clean up

## Quick start

1. **Install prerequisites** — Python, Node.js, GitHub CLI. See [docs/prerequisites.md](docs/prerequisites.md).
2. **Spec your idea** — open Claude Code in this repo and run `/spec "your idea"`.
   `/spec` picks the right experiment level automatically, or specify one: L1 (landing), L2 (interactive), L3 (full).
3. **Build, verify, deploy:**
   ```
   /bootstrap      # generates app, opens PR — review and merge
   /verify         # runs 10 agents, auto-fixes failures
   /deploy         # pushes to production
   ```

## Experiment levels

| Level | What it builds | When to use |
|-------|---------------|-------------|
| **L1** Landing test | Landing page measuring interest. No backend. | Unvalidated idea — test demand first |
| **L2** Interactive MVP | Working app with core features and database | Some signal — test usability |
| **L3** Full MVP | Auth, payments, full feature set | High conviction — test willingness to pay |

`/spec` picks the level based on your idea, or you can override it.

## Skills reference

**Build**

| Skill | What it does | Waits for approval? |
|-------|-------------|---------------------|
| `/spec "idea"` | Generate experiment.yaml from a problem statement | Yes |
| `/bootstrap` | Generate the full app from experiment.yaml | Yes |
| `/change [desc]` | Add a feature, fix a bug, polish UI, fix analytics | Yes |
| `/verify` | Run agents and auto-fix failures | No |
| `/resolve` | Resolve GitHub issues filed against the template | Yes |

**Ship**

| Skill | What it does | Waits for approval? |
|-------|-------------|---------------------|
| `/deploy` | Deploy to hosting + database | Yes |
| `/distribute` | Generate ad campaign config | Yes |
| `/rollback` | Roll back to previous deployment (emergency) | Yes |
| `/teardown` | Remove all cloud resources | Yes |

**Analyze**

| Skill | What it does | Waits for approval? |
|-------|-------------|---------------------|
| `/iterate` | Analyze metrics, recommend next steps | No |
| `/retro` | Run retrospective, file feedback as GitHub issue | No |
| `/review` | Automated review-fix loop *(maintainers only)* | Yes |
| `/audit` | Analyze template structural quality | No |
| `/solve` | First-principles analysis for complex decisions | No |

**Utility**

| Skill | What it does | Waits for approval? |
|-------|-------------|---------------------|
| `/optimize-prompt` | Optimize a prompt using Claude best practices | No |

## Supported stacks

| Category | Options | Default |
|----------|---------|---------|
| Framework | nextjs, hono, commander, virtuals-acp | nextjs |
| Hosting | vercel, railway | vercel |
| Database | supabase, sqlite | supabase |
| Auth | supabase | supabase |
| UI | shadcn | shadcn |
| Analytics | posthog | posthog |
| Testing | playwright, vitest | — |
| Payment | stripe | — |
| Distribution | google-ads, meta-ads, reddit, reddit-organic, twitter, twitter-organic, email-campaign | — |
| Email | resend | — |
| AI | anthropic | — |
| Surface | co-located, detached, none | — |

Override any default in `experiment.yaml` under `stack`. To add a new technology, create a stack file at `.claude/stacks/<category>/<name>.md`.

## Automated review

Every `/verify` triggers up to 10 specialized agents in parallel:

**Quality** — design-critic, ux-journeyer, performance-reporter, accessibility-scanner
**Security** — security-defender, security-attacker, security-fixer
**Production** — spec-reviewer *(when `quality: production`)*
**Build** — build-info-collector, observer

`/bootstrap` adds 7 scaffold agents (setup, init, libs, pages, externals, landing, wire) that build the app in parallel. Additional agents handle gate-keeping, pattern classification, behavior verification, design consistency, provisioning scans, and visual/task implementation. 24 agents total across the system.

## Project structure

```
.claude/
  commands/          # 16 slash command definitions
  agents/            # 24 agent specifications
  stacks/            # 26 pluggable stack files (13 categories)
  archetypes/        # 3 product archetypes (web-app, service, cli)
  patterns/          # Reusable patterns (verify, security, TDD, design)
  runs/              # Skill execution artifacts and context files
experiment/
  experiment.yaml    # Single source of truth for what to build
  experiment.example.yaml  # QuickBill reference example
scripts/             # Validators and CI checks
docs/                # Prerequisites, troubleshooting, technical reference
```

## Common issues

1. **`make validate` fails with TODOs** — open experiment.yaml and replace every `TODO`
2. **`/bootstrap` fails** — run `gh auth login` to authenticate GitHub CLI
3. **`/verify` fails** — make sure Docker Desktop is running (for supabase projects)
4. **Build fails** — check that `.env.local` has all variables from `.env.example`
5. **`/deploy` fails** — run `vercel login` and `npx supabase login` first
6. **Deployment broken?** — run `/rollback` for instant recovery to the previous deployment

For more issues, see [docs/troubleshooting.md](docs/troubleshooting.md) (28 items total).

## Documentation

- [docs/prerequisites.md](docs/prerequisites.md) — Full setup instructions
- [docs/troubleshooting.md](docs/troubleshooting.md) — All known issues
- [docs/technical-reference.md](docs/technical-reference.md) — Project structure, migrations, stack and archetype reference
- [docs/google-ads-setup.md](docs/google-ads-setup.md) — Google Ads setup for `/distribute`

## Contributing

All changes go through pull requests — never commit directly to `main`. CI runs validation on every PR. See [CLAUDE.md](CLAUDE.md) for the full rule set.

## License

MIT
