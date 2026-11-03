# Methods, data provenance and limitations

## 1. Source data audit

**Original source:** `DaneshjouLab/Medical-LLM-Self-Preference`. The Real-POCQi cohort is
frozen in this repository under `data/source/`, so its preparation requires no clone,
network access or Git LFS. MedSP1000 is fetched at commit
`2e0462248e33ab391b7afa457f1e06a2d4408e97` ("Restore eight-model MedSP1000 results",
2026-10-21).

The app was first built against `a40d3617`, which only had 6-model MedSP1000 data. The
Real-POCQi files are byte-identical in both commits, and re-preparing on the new commit
produced exactly the same Real-POCQi questions and answers.

### Real-POCQi

| Need | Committed file | Finding |
|---|---|---|
| Questions | `data/source/real-pocqi-questions.jsonl` | 100 frozen questions across 30 specialties, including original IDs, sample order and provenance. |
| Answers | `data/source/real-pocqi-answers.jsonl` | 800 exact model answers (8 per question), with stable IDs, text hashes and generator provenance. |
| LLM judgments | `data/source/real-pocqi-llm-judgments.jsonl` | 6,400 rows (8 judges × 8 answers × 100 questions), preserving ranks, rubric scores and presentation labels. |
| Integrity and provenance | `data/source/manifest.json` | Original repository/commit, frozen sampling method, row counts and SHA-256 for every file. |

**Validation.** `scripts/prepare-data.ts` verifies every committed file against its manifest
hash and validates all 100 study questions. For every question it checks:
- exactly 8 judges;
- all judges saw the same 8 `generation_id`s;
- 8 distinct generators;
- every answer and judgment belongs to a known question and response;
- every answer text matches its recorded SHA-256;
- every ranking is a permutation;
- all five scores are present.

**All 100 frozen questions pass.** The earlier audit against all 620 upstream questions
established the sample and exact judged generation IDs before these files were frozen.

**Which answer version is used.** Answers are taken by the `generation_id` the judges
actually saw, never by "latest attempt". This handles the 86 duplicate Qwen generations.

### MedSP1000

| Need | File in source repo | Finding |
|---|---|---|
| Scenarios | `data/question_sets/medsp1000_generation_cases.jsonl` | 200 scenarios. `question_text` is the clinician-visible case packet; `private_patient_context` is the patient-only script. |
| Conversations | `data/outputs/medsp1000/generations.jsonl` | 1,600 successful 8-turn conversations (200 × 8 clinician models), each with an ordered `turns` array and the `transcript_text` the judges saw. The patient simulator is Mistral-Small-3.1-24B. |
| LLM judgments (8 turns) | `data/outputs/medsp1000/judgements/rubric_and_model_ranking.jsonl` (Git LFS) | Experiment `medsp1000_all_eight_judges_v2`: 1,600 successful judgments (200 × 8 judges), each ranking all 8 conversations. The same file also holds the older 6-model experiment (`medsp1000_all_judges_v1`), which is not used. |
| Rubric and prompts | `src/judging/judge_medsp1000.py`, `src/judging/run_medsp1000_judging.py` | Judges saw `CLINICIAN INITIALIZATION` (= `question_text`) and each full `transcript_text`, with the multi-turn rubric wording and "evaluate only the clinician's behavior". They never saw `private_patient_context`. |

**Validation.** `prepare-medsp1000` validates all 200 scenarios. For every scenario it
checks:
- exactly 8 judges from the v2 experiment, all of which saw the same 8 `generation_id`s;
- 8 distinct clinician models;
- every conversation exists, succeeded, belongs to the scenario, and has exactly 8 turns
  alternating clinician / patient;
- **the turns rebuild, character for character, the `transcript_text` the judges were
  given**;
- the case text is identical across the scenario set, conversations and judgments;
- every ranking is a permutation, with all five scores present.

**All 200 scenarios pass.** Recomputing pooled ARB from these judgments gives +0.576,
+0.521, +0.615 and +0.615 at 2, 4, 6 and 8 turns (without position adjustment), matching
the paper's +0.57, +0.53, +0.62 and +0.61.

### Not available or not used
- The README links to `docs/` and the manuscript PDF; neither exists at this commit.
- These judgment files are fetched (with `--all`) but not imported:
  - the other Real-POCQi conditions: direct ranking, identity-revealed and score-only;
  - the MedSP1000 judgments at 2, 4 and 6 visible turns.

## 2. Sampling

This section covers Real-POCQi; MedSP1000 sampling is described in §7.

The committed cohort was drawn from the 620-question set with seed `pe-real-pocqi-v1`:

1. **Allocation:** proportional allocation across the 30 specialties by the largest-remainder
   method, with at least 1 question per specialty. The resulting allocation is recorded in
   `data/sample-manifest.json`.
2. **Selection within a specialty:** questions are ordered by `sha256("<seed>:stratum:<specialty>:<question_id>")`
   and the first *k* are taken.
3. **Overall order:** the 100 are ordered by `sha256("<seed>:order:<question_id>")`.
   The first 5 are the prototype questions.

The selected IDs and order are frozen in `data/source/real-pocqi-questions.jsonl`.
Re-running the Real-POCQi preparation validates the checksums and produces deterministic output.

## 3. Presentation order and counterbalancing

`presentationOrder` in `src/lib/ordering.ts`:

1. **Base order:** each question's 8 responses are put in a base order by
   `sha256("<seed>:base:<item_id>:<response_id>")`.
2. **Reviewer offset:** each reviewer has a fixed `reviewer_slot`, the order in which the
   account was created. Their *k*-th question uses row `(k + slot) mod 8` of an 8×8
   **Williams Latin square**, applied to the base order.
3. **Balance within a reviewer:** over every 8 consecutive questions, each base slot appears
   in each display position exactly once, and each ordered pair of neighbours appears once.
4. **Balance across reviewers:** two reviewers with consecutive slots see every response in
   a different position on the same question.
5. **Storage:** the computed order is stored on the assignment (`presentation_order`), so it
   never needs to be recomputed. Labels A–H always mean "position 1–8 for this reviewer".

The LLM judges' own presentation labels (`response-1`…`response-8`, seeded by question and
judge in the original pipeline) are exported separately, so position effects can be modelled
for both physicians and LLMs.

## 4. Blinding

**Screens.** Physicians see the specialty, the question text, and the answer text with
labels A–H. They never see:
- model or family names;
- generation, judgment or internal response IDs;
- LLM scores or ranks;
- other reviewers' work.

**Code.** `src/server/evaluations.ts`, the only physician-facing data module, never reads
`response_provenance` or `llm_judgments`. Its payloads identify responses only by label.
The server translates labels to `response_id`s using the stored order.

**Tests.**
- `tests/persistence.test.ts › blinding` checks the payload for model names, families and
  internal IDs.
- The browser end-to-end run checks the visible page text and every HTTP response body
  received while grading.

**Instructions.** The instructions say nothing about study hypotheses or which models
performed well.

**Admin dashboard.** It shows progress counts only, not evaluation content.

**Known limitation: writing style.** Model output keeps each model's own style: headings,
length, citation habits and phrasing. An expert reader might recognise a model family from
its style. Removing this would mean editing the original text, which the study design
forbids. The LLM judges faced the same stylistic cues in the blinded condition.

A scan of all 4,960 answers found no self-identifying model names. The only matches were two
references to the GEMINI clinical trial.

## 5. Methodological parallels and differences vs. the LLM judges

The table below is for Real-POCQi. MedSP1000 follows the same design, with the case
information in place of the question, 8-turn conversations in place of answers, and the
multi-turn rubric wording (§7).

| Aspect | LLM judges | Physicians |
|---|---|---|
| Inputs | Specialty + question + 8 answers | Same |
| Rubric | Five axes, 0–5, identical wording | Same wording; whole numbers only |
| Ranking | Strict 1–8, need not follow scores | Same. Never derived from scores, with explicit confirmation |
| Order | Seeded per (question, judge) | Seeded per (question, reviewer), Williams-balanced |
| Error flag | Not collected | Optional separate instrument, labelled as such |

- **Draft rankings.** A draft ranking is saved, but only `ranking_confirmed = true` rows
  count as final.
- **Confirming the shown order.** If a physician confirms without moving any entry,
  `ranking_modified = false` is recorded, so these cases can be analysed separately.

## 6. Data integrity

**Original answers never change.**
- The importer is insert-only.
- On re-import it verifies that existing questions and answers are byte-identical, and stops
  otherwise.
- Every answer's SHA-256 is stored, and the admin "data mapping check" recomputes it.

**Saving.**
- Saves are full-state and idempotent.
- They are guarded by a revision number: a stale write from another tab returns HTTP 409
  instead of overwriting.
- Every accepted save is also kept in the append-only `save_events` table.

**After final submission**, the server rejects all writes (HTTP 423) until an admin reopens
the reviewer.

**Exports were checked against the source.** On the prototype, every exported LLM row
(320/320) was compared with the original JSONL by `generation_id`: rank, scores, generator
and judgment ID. There were zero mismatches. All 40 answer-text hashes also matched the
original generations.

## 7. MedSP1000 (multi-turn) study

MedSP1000 runs as a **separate study** from Real-POCQi: its own reviewer queue,
instructions, rubric wording, progress and submission. A physician can be assigned to
either study or both; with both, they choose a study after signing in.

**What physicians see,** matching the judges' full-trajectory (8-turn) condition:
- **Case information:** the scenario's `question_text`, exactly what the judges saw as
  `CLINICIAN INITIALIZATION`. The judges also saw a `SOURCE SCENARIO` path (for example
  `mededportal_5102/scenario1`); it is omitted because it carries no clinical content.
- **Conversations A–H:** each conversation's 8 turns, labelled "Clinician (evaluated)" and
  "Patient (context)". Only each turn's role and text are kept; the per-turn model field in
  the source is dropped.
- **The multi-turn rubric,** worded exactly as in the MedSP1000 judge prompt (paper Figure 1,
  right column), and the instruction to evaluate only the clinician.
- **The patient-only script (`private_patient_context`) is never included.**
  `prepare-medsp1000` refuses to write a bundle containing it, and
  `tests/prepared-data.test.ts` scans the real bundle against every scenario's script.

**Sampling.** All 200 validated scenarios are ordered by
`sha256("pe-medsp1000-v1:order:<question_id>")`, and the first 100 form the sample
(`data/medsp1000-sample-manifest.json`). The first 5 are the prototype. Specialty
stratification does not apply, since scenarios have no specialty label.

**Presentation order** uses the same Williams-square counterbalancing as Real-POCQi (§3),
with the MedSP1000 seed.

**Linking for analysis.** Each conversation keeps its original `generation_id`. The
exports join physician rankings to the 8 judges' 8-turn rankings from
`medsp1000_all_eight_judges_v2`, and carry `study = medsp1000` and `turn_count = 8`.

**Not built:** grading at 2, 4 or 6 visible turns. The judging pipeline cut conversations
to their first *k* turns and replaced "over the full interaction" with "over the visible
interaction" in the rubric; supporting this would add those views as separate items.

**Shared template text.** In the source dataset, some clinician-visible case packets share
template text with patient scripts, such as case-series headers ("Trauma-Informed Care in
Acute Care Settings") and form labels ("Chief Concern: What the patient will say when
greeted by the student"). That text is part of what the judges saw, so it is shown as-is.

## 8. Assignment plan

Each study's physicians get their cases from one seeded plan, created before anyone logs in
(`src/lib/plan.ts`, applied from the admin dashboard). The agreed design is 8 physicians per
study, fully separate between studies.

| Setting | Per study |
|---|---|
| Cases | 100 |
| Physicians | 8, assigned to positions P1–P8 by `hashSort(seed)` |
| Calibration cases | 4, graded by all 8 |
| Blocks | the other 96 dealt into 8 blocks of 12 |
| Rotation | position Pi grades blocks i, i+1, i+2 (wrapping), so each block case gets 3 graders |
| Per physician | 40 cases; 320 gradings per study |

**How the plan is built:**

1. **Calibration.** Walk the cases in frozen sample order and take the first 4. For
   Real-POCQi, skip a case whose specialty is already taken, so the 4 come from 4 different
   specialties. MedSP1000 has no specialty and takes the first 4.
2. **Blocks.** Sort the other 96 by specialty (Real-POCQi only; sample order within a
   specialty), then deal them one at a time into the 8 blocks, like cards. Each block gets 12,
   and each specialty's cases spread across blocks (counts differ by at most 1).
3. **Positions.** Physicians are ordered by `sha256("<seed>:slots:<reviewer id>")`; the first
   is P1.
4. **Queues.** Each physician's 40 cases are ordered by
   `sha256("<seed>:queue:<reviewer id>:<item id>")`, so calibration cases are mixed in and the
   3 graders of a case reach it at different points. Calibration cases are not labelled for
   physicians.
5. **Answer order** within each case uses the per-physician Williams-square order of §3.

**Why this design.** Three graders per case make the physicians' average ranking a reliable
reference for each LLM judge (Spearman–Brown: a single-rater reliability of 0.5 becomes 0.75
for the mean of 3). Rotating blocks give each physician overlap with 4 of the other 7, and the
calibration cases give every pair a direct comparison.

**Safeguards.**

- The admin preview re-counts the plan independently: all cases assigned, exactly 3 graders
  per block case, 8 per calibration case, 40 different cases per physician.
- Applying creates every assignment in one transaction and **locks the plan**: a study can
  have only one applied plan, so it cannot be silently regenerated.
- **Hand-over (switched off for now):** the code can hand a dropped-out physician's position
  to a replacement, but it is not shown in the dashboard. If turned back on: the admin hands their position to a replacement
  with no cases in the study. Finished cases stay credited to the original physician;
  unstarted cases move; a case the original physician had started is closed for them (kept,
  marked `transferred`) and given fresh to the replacement, so nobody inherits half-finished
  work. The data check confirms every case still has its required graders.
- Cases can only be assigned through a study plan; the admin dashboard has no manual
  assignment. (Only the local demo setup assigns cases outside a plan; those rows carry no plan,
  position or block.)

**Pilot.** The demo's first 5 cases include calibration cases under this plan, so the timed
pilot should use cases outside each study's 100 on a separate database.

## 9. Before collecting real physician evaluations

This checklist is for the study team. **None of these items has been confirmed by this
software.**

- [ ] **IRB / institutional review** decision for collecting physician evaluations.
- [ ] **Data use:**
  - Real-POCQi is CC-BY-4.0, so attribution is required.
  - The source repository is MIT.
  - Confirm that hosting the questions and model outputs on the chosen server is allowed.
- [ ] **De-identification review of the questions.** An automated pattern scan found no
  names, record numbers or dates of birth, only ages and years. This is not a formal review.
- [ ] **MedSP1000 case material.** The scenarios come from published teaching cases
  (MedEdPORTAL and similar). Some case packets contain patient names, dates of birth and
  record numbers, for example "DOB: 2/21/75 MR: 5624125". These appear to be fictional
  teaching identifiers, but confirm this, and confirm the cases' licensing allows hosting
  them for the study.
- [ ] **Hosting** approved for the data class, with HTTPS (`COOKIE_SECURE=true`) and backups.
- [ ] **Reviewer accounts:** create them with pseudonymous usernames where possible, and
  share passwords through a secure channel.
- [ ] **Pilot:** confirm time per case with the full rubric (required) and the optional
  error question, as fixed in the app.
- [ ] **Recruit 16 physicians** (8 per study) and record each one's specialty and years in
  practice on their account.
- [ ] **Run the timed pilot** on cases outside the study samples, then confirm the design.
