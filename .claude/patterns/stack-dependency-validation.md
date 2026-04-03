# Stack Dependency Validation

Canonical dependency matrix for experiment.yaml stack validation.
Referenced by bootstrap (state-3) and change (state-5) precondition checks.

## Dependency Matrix

| Stack | Requires | Error guidance |
|-------|----------|---------------|
| payment | auth + database | "Payment requires authentication to identify the paying user / a database to record transaction state." |
| email | auth + database | "Email requires authentication to know who to send to / a database to track activation status." |
| auth_providers | auth | "OAuth providers require an auth system." |

## Compatibility Constraints

| Constraint | Rule |
|-----------|------|
| testing: playwright | Incompatible with service/cli archetypes — use vitest instead |
| framework: nextjs | Required for web-app archetype |
| framework: commander | Required for cli archetype |
| framework: (any) | Allowed for service archetype |
| quality (not mvp) | Requires stack.testing present |

## Assumes-List Validation

Stack files may declare an `assumes` list in frontmatter (e.g., `assumes: [framework/nextjs]`).
Each `category/value` pair must match experiment.yaml stack exactly — category presence alone is insufficient.
Example: `database/supabase` requires `stack.database: supabase`, not just any database provider.

When an assumption is unmet, stop with a message listing the specific unmet dependencies and current stack values.
