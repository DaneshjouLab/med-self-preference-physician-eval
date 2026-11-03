// Maintenance-only extractor for refreshing the committed Real-POCQi source.
// Normal preparation reads data/source directly and never needs this checkout.
//
// Prerequisite: the original repository at REAL_POCQI_SOURCE_COMMIT in
// .source/Medical-LLM-Self-Preference with its production judgment LFS file materialized.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildItem,
  JUDGING_CONDITION,
  PRODUCTION_JUDGING_EXPERIMENT,
  REAL_POCQI_DATASET,
  selectJudgments,
  type SourceGeneration,
  type SourceJudgment,
  type SourceQuestion,
} from "../src/lib/prep/realPocqi";

const REAL_POCQI_SOURCE_COMMIT = "a40d3617a2e55cb6fe4255198a4b05ba774c3f4c";
const SOURCE_REPOSITORY = "DaneshjouLab/Medical-LLM-Self-Preference";
const SOURCE = path.resolve(".source/Medical-LLM-Self-Preference");
const INPUTS = {
  questions: "data/question_sets/real_pocqi_questions.jsonl",
  generations: "data/outputs/generations/real_pocqi_generations.jsonl",
  judgments: "data/real_pcoqi/judgements/rubric_and_model_ranking.jsonl",
};
const OUTPUTS = {
  questions: "data/source/real-pocqi-questions.jsonl",
  answers: "data/source/real-pocqi-answers.jsonl",
  judgments: "data/source/real-pocqi-llm-judgments.jsonl",
};

function readJsonl<T>(relativePath: string): T[] {
  const text = readFileSync(path.join(SOURCE, relativePath), "utf8");
  if (text.startsWith("version https://git-lfs")) throw new Error(`${relativePath} is still a Git LFS pointer`);
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

function writeJsonl(file: string, rows: unknown[]) {
  const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(file, text);
  return { path: file, sha256: createHash("sha256").update(text).digest("hex"), rows: rows.length };
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: SOURCE }).toString().trim();
if (head !== REAL_POCQI_SOURCE_COMMIT) {
  throw new Error(`Real-POCQi source checkout is ${head}; expected ${REAL_POCQI_SOURCE_COMMIT}`);
}

const questions = readJsonl<SourceQuestion>(INPUTS.questions);
const generations = readJsonl<SourceGeneration>(INPUTS.generations);
const judgments = readJsonl<SourceJudgment>(INPUTS.judgments);
const generationsById = new Map(generations.map((row) => [row.generation_id, row]));
if (generationsById.size !== generations.length) throw new Error("duplicate generation IDs");
const judgmentsByQuestion = selectJudgments(judgments);

// buildItem performs the original cross-file validation and selects the exact
// generation IDs seen by the production judges, rather than a "latest" answer.
const built = questions.map((question) =>
  buildItem({
    question,
    sampleIndex: -1,
    judgments: judgmentsByQuestion.get(question.question_id) ?? [],
    generationsById,
  }),
);

mkdirSync("data/source", { recursive: true });
const sourceFiles = {
  questions: writeJsonl(OUTPUTS.questions, questions),
  answers: writeJsonl(
    OUTPUTS.answers,
    built.flatMap((item) => item.responses.map((answer) => ({ question_id: item.source_question_id, ...answer }))),
  ),
  judgments: writeJsonl(
    OUTPUTS.judgments,
    built.flatMap((item) => item.llm_judgments.map((judgment) => ({ question_id: item.source_question_id, ...judgment }))),
  ),
};

const manifest = {
  bundle_version: "1",
  study: "real_pocqi",
  study_seed: "pe-real-pocqi-v1",
  population_size: questions.length,
  sample_size: 100,
  sampling:
    "Stratified by specialty with proportional allocation (largest remainder, minimum 1); hashSort within stratum and overall order",
  source_repository: SOURCE_REPOSITORY,
  source_commit: REAL_POCQI_SOURCE_COMMIT,
  source_dataset: REAL_POCQI_DATASET,
  source_files: sourceFiles,
  judging_experiment_id: PRODUCTION_JUDGING_EXPERIMENT,
  judging_condition: JUDGING_CONDITION,
  judgment_selection:
    "status=succeeded, experiment_id=production, last row per (question_id, judge_model) in file order; answers are the exact generation IDs those judgments reference",
};
writeFileSync("data/source/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Wrote ${sourceFiles.questions.rows} questions, ${sourceFiles.answers.rows} answers, and ${sourceFiles.judgments.rows} judgment rows`,
);
