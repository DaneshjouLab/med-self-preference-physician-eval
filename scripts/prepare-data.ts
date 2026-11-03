// Validate the repository-owned study source and build the importable bundle.
//
// Inputs (committed; no network or external repository required)
//   data/source/real-pocqi-questions.jsonl
//   data/source/real-pocqi-answers.jsonl
//   data/source/real-pocqi-llm-judgments.jsonl
//   data/source/real-pocqi-manifest.json
//
// Outputs
//   data/study/prepared/real-pocqi-bundle.json  (gitignored build artifact)
//   data/study/real-pocqi-sample-manifest.json  (committed sample inventory)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "../src/lib/hash";
import {
  RUBRIC_AXES as AXES,
  type BundleItem,
  type BundleJudgmentRow,
  type BundleResponse,
} from "../src/lib/prep/bundle";
import { stratifiedSample, type SourceQuestion } from "../src/lib/prep/realPocqi";

const SOURCE_MANIFEST = path.resolve("data/source/real-pocqi-manifest.json");

interface SourceFile {
  path: string;
  sha256: string;
  rows: number;
}

interface SourceManifest {
  bundle_version: string;
  study: "real_pocqi";
  study_seed: string;
  population_size: number;
  sample_size: number;
  sampling: string;
  source_repository: string;
  source_commit: string;
  source_dataset: string;
  source_files: { questions: SourceFile; answers: SourceFile; judgments: SourceFile };
  judging_experiment_id: string;
  judging_condition: string;
  judgment_selection: string;
}

type SourceAnswer = BundleResponse & { question_id: string };
type SourceJudgment = BundleJudgmentRow & { question_id: string };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readJsonl<T>(file: SourceFile): T[] {
  const absolute = path.resolve(file.path);
  const bytes = readFileSync(absolute);
  const digest = createHash("sha256").update(bytes).digest("hex");
  check(digest === file.sha256, `${file.path}: sha256 mismatch (got ${digest}, expected ${file.sha256})`);
  const rows = bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`${file.path}:${index + 1}: invalid JSON`, { cause: error });
      }
    });
  check(rows.length === file.rows, `${file.path}: expected ${file.rows} rows, found ${rows.length}`);
  return rows;
}

function validateItem(item: BundleItem) {
  const label = item.item_id;
  check(item.study === "real_pocqi", `${label}: wrong study`);
  check(item.item_type === "single_turn", `${label}: unsupported item type`);
  check(item.turn_count === null, `${label}: single-turn item has a turn count`);
  check(item.specialty?.trim(), `${label}: missing specialty`);
  check(item.question_text.trim().length > 0, `${label}: empty question`);
  check(item.responses.length === 8, `${label}: expected 8 answers, found ${item.responses.length}`);
  check(new Set(item.responses.map((response) => response.response_id)).size === 8, `${label}: duplicate response IDs`);
  check(
    new Set(item.responses.map((response) => response.provenance.generator_model)).size === 8,
    `${label}: duplicate generator models`,
  );
  for (const response of item.responses) {
    check(response.response_text.trim().length > 0, `${label}/${response.response_id}: empty answer`);
    check(
      sha256Hex(response.response_text) === response.provenance.response_text_sha256,
      `${label}/${response.response_id}: answer hash mismatch`,
    );
  }

  check(item.llm_judgments.length === 64, `${label}: expected 64 judgment rows, found ${item.llm_judgments.length}`);
  const responseIds = new Set(item.responses.map((response) => response.response_id));
  const byJudge = new Map<string, BundleJudgmentRow[]>();
  for (const judgment of item.llm_judgments) {
    check(responseIds.has(judgment.response_id), `${label}: judgment refers to unknown response ${judgment.response_id}`);
    check(AXES.every((axis) => typeof judgment.scores[axis] === "number"), `${label}: incomplete judgment scores`);
    const rows = byJudge.get(judgment.judge_model) ?? [];
    rows.push(judgment);
    byJudge.set(judgment.judge_model, rows);
  }
  check(byJudge.size === 8, `${label}: expected 8 judges, found ${byJudge.size}`);
  for (const [judge, rows] of byJudge) {
    check(rows.length === 8, `${label}/${judge}: expected 8 ranked answers, found ${rows.length}`);
    check(new Set(rows.map((row) => row.response_id)).size === 8, `${label}/${judge}: duplicate ranked answer`);
    check(
      rows.map((row) => row.original_rank).sort((a, b) => a - b).join(",") === "1,2,3,4,5,6,7,8",
      `${label}/${judge}: ranks are not a 1-8 permutation`,
    );
  }
}

function main() {
  const meta = JSON.parse(readFileSync(SOURCE_MANIFEST, "utf8")) as SourceManifest;
  const questions = readJsonl<SourceQuestion>(meta.source_files.questions);
  const answers = readJsonl<SourceAnswer>(meta.source_files.answers);
  const judgments = readJsonl<SourceJudgment>(meta.source_files.judgments);

  check(questions.length === meta.population_size, `expected ${meta.population_size} questions, found ${questions.length}`);
  check(new Set(questions.map((question) => question.question_id)).size === questions.length, "duplicate question IDs");

  const answersByQuestion = new Map<string, BundleResponse[]>();
  for (const { question_id, ...answer } of answers) {
    const rows = answersByQuestion.get(question_id) ?? [];
    rows.push(answer);
    answersByQuestion.set(question_id, rows);
  }
  const judgmentsByQuestion = new Map<string, BundleJudgmentRow[]>();
  for (const { question_id, ...judgment } of judgments) {
    const rows = judgmentsByQuestion.get(question_id) ?? [];
    rows.push(judgment);
    judgmentsByQuestion.set(question_id, rows);
  }

  const knownQuestions = new Set(questions.map((question) => question.question_id));
  for (const questionId of [...answersByQuestion.keys(), ...judgmentsByQuestion.keys()]) {
    check(knownQuestions.has(questionId), `source row refers to unknown question ${questionId}`);
  }

  // Validate the complete 620-question population before drawing the study sample.
  const population = new Map<string, BundleItem>();
  for (const question of questions) {
    const item: BundleItem = {
      item_id: `pocqi_${question.question_id}`,
      study: "real_pocqi",
      source_question_id: question.question_id,
      source_dataset: question.source_dataset,
      item_type: "single_turn",
      specialty: question.specialty,
      question_text: question.question_text,
      turn_count: null,
      sample_index: -1,
      provenance: {
        source_revision: question.source_revision,
        source_file: question.source_file,
        source_row_index: question.source_row_index,
        question_text_sha256: sha256Hex(question.question_text),
      },
      responses: answersByQuestion.get(question.question_id) ?? [],
      llm_judgments: judgmentsByQuestion.get(question.question_id) ?? [],
    };
    validateItem(item);
    population.set(question.question_id, item);
  }

  const items = stratifiedSample(questions, meta.sample_size, meta.study_seed).map((question, sampleIndex) => ({
    ...population.get(question.question_id)!,
    sample_index: sampleIndex,
  }));

  mkdirSync("data/study/prepared", { recursive: true });
  writeFileSync("data/study/prepared/real-pocqi-bundle.json", JSON.stringify({ meta, items }, null, 1) + "\n");

  const allocation: Record<string, number> = {};
  for (const item of items) {
    check(item.specialty, `${item.item_id}: missing specialty`);
    allocation[item.specialty] = (allocation[item.specialty] ?? 0) + 1;
  }
  const sampleManifest = {
    ...meta,
    allocation_by_specialty: Object.fromEntries(Object.entries(allocation).sort()),
    sampled_questions: items.map((item) => ({
      sample_index: item.sample_index,
      question_id: item.source_question_id,
      specialty: item.specialty,
      question_text_sha256: item.provenance.question_text_sha256,
    })),
  };
  writeFileSync("data/study/real-pocqi-sample-manifest.json", JSON.stringify(sampleManifest, null, 2) + "\n");
  console.log(
    `Validated ${questions.length} questions, ${answers.length} answers, and ${judgments.length} judgment rows; prepared ${items.length} sampled questions`,
  );
}

main();
