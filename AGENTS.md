<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Repository operating guide

## Current deployment

- This application is deployed. The stable staging URL is
  `https://med-physician-eval-staging.vercel.app`.
- The Next.js application is the Vercel project `med-physician-eval-staging`.
- Persistent data is stored in a Railway PostgreSQL 18 service. The Railway project is
  `med-physician-eval-staging` in the AutoGKB workspace.
- Vercel connects to Railway through `DATABASE_URL`. Railway's public Postgres URL must use
  TLS; the known-working query parameters are `uselibpqcompat=true&sslmode=require`.
- `COOKIE_SECURE=true` is required on Vercel. Vercel sets `VERCEL=1` itself.
- Vercel cold starts do not run migrations. Run `npm run db:migrate` explicitly against the
  Railway database before deploying a schema change. See `src/db/index.ts`.
- Do not put passwords, database URLs, session tokens, or provider tokens in this file or in
  git. Use Vercel/Railway environment variables and local ignored env files.

Deployment snapshot as of 2026-11-04: the Railway database has five imported Real-POCQi
questions and no MedSP1000 questions. Treat this as a snapshot, not a permanent invariant;
query the database or admin dashboard before relying on the counts.

The deployment section in `README.md` predates this staging deployment and may still claim
that the app has only been tested locally. Prefer this file and the actual provider state for
deployment facts until the README is reconciled.

## Product workflow

- Administrators create reviewer accounts in `/admin`. The UI returns the generated temporary
  password once; it is not recoverable later. Administrators can reset a reviewer password.
- Accounts can also be created from a trusted terminal with:

  ```bash
  DATABASE_URL='...' PE_PASSWORD='...' \
    npm run user:create -- --username <username> --role <admin|reviewer>
  ```

- Never commit or document a real account password. Do not silently reset a live password while
  diagnosing login unless the user explicitly asks for it.
- The active assignment workflow is the Reviewers table in `/admin`, not Study Plans. For each
  reviewer and each study with imported content, **Edit assignments** accepts frozen imported
  question numbers and ranges such as `1-5, 8, 12`.
- Question numbers shown to administrators are `items.sample_index + 1`; they are global within
  the frozen imported study and are not the reviewer's queue positions.
- The direct assignment API is `POST /api/admin/assignments`, implemented by
  `setManualAssignments` in `src/server/admin.ts`.
- Manual assignment replacement is transactional. It may add imported questions and remove
  only `not_started` manual assignments. It must reject attempts to remove assignments with
  saved/completed work, assignments created by an applied plan, and incompatible transferred
  history. Preserve these protections in future changes.
- The admin table uses assignment status colors: gray = not started, amber = in progress, and
  green = complete.
- Study-plan generation, tables, exports, API code, and tests still exist, but Study Plans are
  intentionally hidden from the admin dashboard. Do not restore that UI or make plan-managed
  rows editable through the manual editor without an explicit product decision and migration
  plan.

## Data and security invariants

- PostgreSQL is accessed through Drizzle. Local development and tests use PGlite when
  `DATABASE_URL` is absent.
- Imported study content is insert-only. Re-imports must be byte-identical; never mutate an
  original question or response in place.
- Physician-facing code in `src/server/evaluations.ts` must remain blinded. It must not expose
  model identity, provenance, LLM judgments, internal response IDs, or generation IDs.
- Stored `presentation_order` is reviewer-specific and must remain stable once an assignment is
  created.
- Every non-GET API write uses same-origin enforcement. Command-line checks must send an
  `Origin` header matching the deployed host, or they will correctly receive HTTP 403.
- One browser profile shares one session across its tabs. Use an incognito window or a separate
  browser when testing admin and reviewer accounts concurrently.

## Development and verification

- Node.js 20.9 or newer is required.
- Before changing Next.js behavior, read the relevant current guide in
  `node_modules/next/dist/docs/` as required by the generated rule above.
- The standard verification gate is:

  ```bash
  npm test
  npm run typecheck
  npm run build
  ```

- Assignment behavior is covered in `tests/persistence.test.ts`; plan compatibility remains
  covered in `tests/plan.test.ts` and `tests/plans.test.ts`.
- Schema changes require a Drizzle migration. Generate and inspect it with
  `npm run db:generate`, test it locally, then apply it to Railway with
  `DATABASE_URL='...' npm run db:migrate` before the Vercel deployment.

## Release procedure

- The Git remote is `git@github.com:DaneshjouLab/med-self-preference-physician-eval.git`; the
  deployed branch is `main`.
- Push the verified commit to `origin/main`.
- Git integration is not currently assumed to deploy automatically. Deploy the exact committed
  revision manually from a clean temporary worktree so unrelated local changes and ignored
  research data cannot enter the Vercel upload:

  ```bash
  DEPLOY_TREE=$(mktemp -d /tmp/med-physician-vercel.XXXXXX)
  git worktree add --detach "$DEPLOY_TREE" HEAD
  cd "$DEPLOY_TREE"
  npx --yes vercel link --yes --project med-physician-eval-staging
  npx --yes vercel deploy --prod --yes
  cd -
  git worktree remove --force "$DEPLOY_TREE"
  ```

- Confirm that Vercel reports the deployment `READY` and aliases it to
  `https://med-physician-eval-staging.vercel.app`.
- Verify `/login` and an authenticated `/admin` request after release. A CLI login POST must
  include `Origin: https://med-physician-eval-staging.vercel.app` because of the same-origin
  protection. Do not print credentials or response cookies in logs.
