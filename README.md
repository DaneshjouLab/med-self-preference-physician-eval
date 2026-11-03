# Medical LLM Physician Evaluation

A web platform for collecting **blinded physician evaluations** of the clinical answers
studied in *"The Judge Is Not Impartial: Self-Preference in Medical LLM Evaluation."*

It covers both datasets from the paper, as **separate studies** with their own
instructions, rubric wording, progress and submission:

| Study | What the AI did | What physicians see per item |
|---|---|---|
| **Real-POCQi** (single-turn) | Answered a physician's clinical question as a specialist | The question, its specialty, and the 8 original answers (Responses A–H) |
| **MedSP1000** (multi-turn) | Played the clinician in an 8-turn conversation with a simulated patient | The clinician-facing case information and the 8 original conversations (Conversations A–H); patient turns are context only |

For every item, a physician:

- scores each candidate on the study's five-axis rubric (0–5), using that study's wording;
- ranks all eight from best to worst, with no ties and an explicit confirmation;
- may optionally flag clinically significant errors (a separate instrument).

Which model produced each candidate is hidden.

The data are stored so that every physician judgment can be joined, by ID, to the
original LLM judges' rankings and scores.

The study data was derived from
[DaneshjouLab/Medical-LLM-Self-Preference](https://github.com/DaneshjouLab/Medical-LLM-Self-Preference),
pinned at commit `2e0462248e33ab391b7afa457f1e06a2d4408e97` ("Restore eight-model MedSP1000
results"). The complete available source data for both studies is committed under
`data/source/`; normal preparation does not use the pinned checkout.

| Document | Contents |
|---|---|
| [docs/METHODS.md](docs/METHODS.md) | Data audit, sampling, randomization, blinding, limitations, pre-deployment checklist |
| [docs/DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) | Every exported column |
| [data/source/real-pocqi-manifest.json](data/source/real-pocqi-manifest.json) | Checksums and provenance for all committed Real-POCQi data |
| [data/source/medsp1000-manifest.json](data/source/medsp1000-manifest.json) | Checksums and provenance for all committed MedSP1000 data |
| [data/study/real-pocqi-sample-manifest.json](data/study/real-pocqi-sample-manifest.json) | The derived 100-question Real-POCQi sample: question IDs, seed, source file hashes |
| [data/study/medsp1000-sample-manifest.json](data/study/medsp1000-sample-manifest.json) | The derived 100-scenario MedSP1000 sample: scenario IDs, seed, source file hashes |

## Status

| Done and tested locally | Not done |
|---|---|
| Self-contained Real-POCQi source: 620 questions, 4,960 answers and 39,680 judgment rows; 100 sampled | Deployment to a hosted server |
| MedSP1000 preparation: all 200 scenarios validated (8 models, 8 turns), 100 sampled | The timed pilot and the real study plans (waiting for physicians and approvals) |
| Grading for both studies: login, instructions, blinded grading, autosave, resume, submit, lock | MedSP1000 at 2, 4 or 6 visible turns (only the full 8-turn view is prepared) |
| **Study plans:** calibration + rotating blocks, preview, apply, block progress | IRB, data-use and de-identification sign-off (see METHODS §9) |
| Admin dashboard: progress, accounts (with specialty and years), reopen, exports | |
| 64 unit/integration tests and browser end-to-end checks of both studies and the plan flow | |

## Stack

- Next.js 16 (App Router) with TypeScript and Tailwind CSS 4
- Postgres through Drizzle ORM. Local development and tests use **PGlite**, an embedded
  Postgres, so no database server is needed. Staging and production use a normal Postgres
  database through `DATABASE_URL`, with the same schema and migrations.
- Sign-in uses username and password accounts created by an admin. Passwords are hashed
  with bcrypt, and sessions are server-side in HttpOnly cookies. There are two roles,
  `reviewer` and `admin`.
- `@dnd-kit` handles drag-and-drop ranking with keyboard support. `react-markdown` renders
  answers safely: raw HTML is never rendered.

## Local setup

Requirements: Node.js 20.9 or newer, and git. You do not need git-lfs, Docker or Postgres.

### Quick start (try the prototype)

```bash
npm install
npm run demo
```

Then open http://localhost:3123 and sign in with the password `physicantest`:

| Username | What you see |
|---|---|
| `reviewer1`, `reviewer2` | Real-POCQi: 5 questions |
| `sp-reviewer1`, `sp-reviewer2` | MedSP1000: 5 scenarios (8-turn conversations) |
| `admin` | Dashboard and exports for both studies |

`npm run demo` validates the committed source data, prepares and imports 100 cases from each
study, creates the demo accounts (each with 5 cases) and starts the app.

To see study plans in action, run `npm run demo:seed -- --plans` once before starting. It adds
16 test physicians (`plan-rp1`–`plan-rp8` and `plan-sp1`–`plan-sp8`, same password) and applies
both plans: 4 calibration cases, 8 blocks of 12, 3 graders per case, so 40 cases each. Running it again keeps
the accounts and any saved grading. These demo accounts are for local testing only; never
use them for real reviewers.

### Step by step

```bash
npm install

# 1. Build both study bundles deterministically. This validates all 620 committed
#    Real-POCQi questions and all 200 MedSP1000 scenarios, then writes the frozen samples:
#      data/study/prepared/real-pocqi-bundle.json   gitignored import bundle
#      data/study/prepared/medsp1000-bundle.json    gitignored import bundle
#      data/study/*-sample-manifest.json             committed sample inventories
npm run data:prepare

# 2. Demo: import all prepared items, create admin, reviewer1/2 (Real-POCQi) and
#    sp-reviewer1/2 (MedSP1000), and give each study's first 5 items to its two reviewers.
#    Add `-- --plans` to also create 16 test physicians and apply both study plans.
#    The password is DEMO_PASSWORD if set, otherwise "physicantest".
npm run demo:seed

npm run dev    # http://localhost:3000
```

Sign in as `reviewer1` to grade, or as `admin` for the dashboard. `demo:seed` refuses to run
when `DATABASE_URL` is set, so it can never touch a shared database.

### Tests

```bash
npm test                 # unit + integration tests (in-memory Postgres)
npm run typecheck

# Browser end-to-end checks against a running server with freshly seeded demo data.
# Uses the locally installed Google Chrome through playwright-core.
E2E_BASE_URL=http://localhost:3000 E2E_R1_PASSWORD=... E2E_R2_PASSWORD=... \
  E2E_ADMIN_PASSWORD=... npm run test:e2e -- --screenshots ./shots
```

Coverage of the QA list in the study brief:

| Requirement | Where it is tested |
|---|---|
| All 8 responses load; IDs match the original questions | `tests/prepared-data.test.ts`, `persistence.test.ts`, admin validation, e2e |
| No model identity visible, including in API payloads | `persistence.test.ts › blinding`; e2e checks page text and every HTTP response body |
| Reproducible, counterbalanced randomization | `ordering.test.ts`, `persistence.test.ts` |
| Strict unique ranks; explicit confirmation required | `evaluation-state.test.ts`, `persistence.test.ts`, e2e |
| Rubric saved separately; ranking independent of scores | `evaluation-state.test.ts`, `persistence.test.ts` |
| Autosave, refresh persistence, resume | `persistence.test.ts`, e2e |
| Failed save is visible and can be retried | e2e (simulated network failure) |
| Reviewers isolated; no cross-reviewer overwrite; stale-write detection | `persistence.test.ts`, e2e |
| Submit only when complete; locked after submit (HTTP 423) | `persistence.test.ts`, e2e |
| Exports match the database; identities recoverable for analysis | `persistence.test.ts › exports`, e2e |
| Long responses shown in full | e2e (character counts of rendered responses) |
| Keyboard access | e2e ranks with Move up/down buttons and the keyboard drag handle |
| MedSP1000: 8 conversations × 8 turns, patient turns as context, multi-turn rubric wording | `studies.test.ts`, e2e |
| MedSP1000: patient-only script never included | `prepared-data.test.ts` (scans the real bundle against every scenario's patient script), `studies.test.ts` |
| Studies kept separate: queues, submission, instructions, cross-study access (404) | `studies.test.ts`, e2e |
| Study plan: calibration from distinct specialties, even specialty mix per block, 3 graders per case, 40 per physician, reproducible | `plan.test.ts`, `plans.test.ts`, e2e (preview → apply → physician sees 40) |
| Hand a position to a replacement (built but switched off in the dashboard): nobody inherits half-finished work, every case keeps 3 graders | `plans.test.ts` |

## Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. If unset, the app uses PGlite in `./.data/pglite` (local only). |
| `PGLITE_DIR` | Optional location for the local PGlite database. |
| `COOKIE_SECURE` | Set to `true` whenever the app is served over HTTPS. |

Copy `.env.example` to `.env`. Never commit `.env`, `data/study/prepared/`, `.source/` or `.data/`;
all four are gitignored. `data/source/` is intentionally committed and is the canonical
Real-POCQi input.

The **grading instrument** is fixed to the study design: all five rubric scores are required
for every answer, and the optional clinical-error question is shown. There is no setting for
it on the admin dashboard. (The code still supports other configurations, and the one in force
is recorded with each assignment, in case a pilot ever needs to compare them.)

## Deployment

The app is a standard Node.js server and needs a Postgres database (version 14 or newer).
It has been tested only locally. **No deployment has been done.**

1. Provision Postgres at a host your institution has approved for this data, and set
   `DATABASE_URL`.
2. On the server, set `COOKIE_SECURE=true` and serve the app over HTTPS only.
3. Apply migrations:

   ```bash
   DATABASE_URL=... npm run db:migrate
   ```

   The server also applies pending migrations on startup.
4. From a trusted machine, prepare and import the data into the production database:

   ```bash
   npm run data:fetch && npm run data:prepare
   DATABASE_URL=... npm run db:import -- --limit 5                    # 5-item prototype of each study
   DATABASE_URL=... npm run db:import -- --study real_pocqi           # all 100 Real-POCQi, after approval
   DATABASE_URL=... npm run db:import -- --study medsp1000            # all 50 MedSP1000, after approval
   ```

   The importer is insert-only. It verifies that items already present are byte-identical,
   and it refuses to change any original response.
5. Create the first admin:

   ```bash
   DATABASE_URL=... PE_PASSWORD='<strong password>' \
     npm run user:create -- --username <name> --role admin
   ```

   Then, on the dashboard, create the physician accounts (with specialty and years in
   practice) and use **Study plans** to preview and apply each study's plan. Applying creates
   every physician's cases at once and locks the plan.
6. Build and start the app:

   ```bash
   npm run build && npm start
   ```

   Any Node host works: an institutional VM, Render, Fly.io or Railway. The deployment bundle
   excludes `.source/`, `data/` and `.data/`.

Physicians need only a browser and the credentials you give them.

## Project layout

```
scripts/            fetch-source, prepare-data, prepare-medsp1000, import-bundle, create-user, seed-demo, migrate, e2e-prototype
data/source/        committed Real-POCQi questions, answers, LLM judgments and checksum manifest
data/study/         derived sample manifests; generated import bundles live under its ignored prepared/ directory
src/lib/            shared logic: studies, rubric, evaluation state + validation, ordering, study plan generator, sampling/prep
src/db/             Drizzle schema + connection (PGlite or Postgres)
drizzle/            SQL migrations
src/server/         auth, evaluations (physician-facing), admin, plans, exports, importer
src/app/            pages + API routes (physician pages live under /study/<real_pocqi|medsp1000>/…)
src/components/     Workspace, ResponseCard, RankingPanel, QuestionNav, AdminPanel, …
tests/              Vitest suites
```

The physician-facing code path, `src/server/evaluations.ts`, never reads the
`response_provenance` or `llm_judgments` tables. Its payloads identify responses only by
display label (A–H), never by internal ID.
