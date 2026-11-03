// Maintenance-only extractor for refreshing the committed MedSP1000 source.
// Normal preparation reads data/source directly and never needs this checkout.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildMedspItem,
  MEDSP_DATASET,
  MEDSP_JUDGING_EXPERIMENT,
  MEDSP_TURN_COUNT,
  selectMedspJudgments,
  type SourceConversation,
  type SourceScenario,
} from "../src/lib/prep/medsp1000";
import type { SourceJudgment } from "../src/lib/prep/realPocqi";
import { SOURCE_COMMIT, SOURCE_REPO } from "../src/lib/prep/source";

const SOURCE = path.resolve(".source/Medical-LLM-Self-Preference");
const INPUTS = {
  scenarios: "data/question_sets/medsp1000_generation_cases.jsonl",
  conversations: "data/outputs/medsp1000/generations.jsonl",
  judgments: "data/outputs/medsp1000/judgements/rubric_and_model_ranking.jsonl",
};
const OUTPUTS = {
  scenarios: "data/source/medsp1000-scenarios.jsonl",
  conversations: "data/source/medsp1000-conversations.jsonl",
  judgments: "data/source/medsp1000-llm-judgments.jsonl",
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
if (head !== SOURCE_COMMIT) throw new Error(`MedSP1000 source checkout is ${head}; expected ${SOURCE_COMMIT}`);

const scenarios = readJsonl<SourceScenario>(INPUTS.scenarios);
const conversations = readJsonl<SourceConversation>(INPUTS.conversations);
const judgments = readJsonl<SourceJudgment>(INPUTS.judgments);
const conversationsById = new Map(conversations.map((row) => [row.generation_id, row]));
if (conversationsById.size !== conversations.length) throw new Error("duplicate conversation IDs");
const judgmentsByScenario = selectMedspJudgments(judgments);
const built = scenarios.map((scenario) =>
  buildMedspItem({
    scenario,
    sampleIndex: -1,
    judgments: judgmentsByScenario.get(scenario.question_id) ?? [],
    conversationsById,
  }),
);

mkdirSync("data/source", { recursive: true });
const sourceFiles = {
  scenarios: writeJsonl(OUTPUTS.scenarios, scenarios),
  conversations: writeJsonl(
    OUTPUTS.conversations,
    built.flatMap((item) => item.responses.map((conversation) => ({ question_id: item.source_question_id, ...conversation }))),
  ),
  judgments: writeJsonl(
    OUTPUTS.judgments,
    built.flatMap((item) => item.llm_judgments.map((judgment) => ({ question_id: item.source_question_id, ...judgment }))),
  ),
};
const manifest = {
  bundle_version: "1",
  study: "medsp1000",
  study_seed: "pe-medsp1000-v1",
  population_size: scenarios.length,
  sample_size: 100,
  visible_turns: MEDSP_TURN_COUNT,
  sampling: "Simple random sample: hashSort of validated scenario IDs with `${seed}:order`, first N",
  source_repository: SOURCE_REPO,
  source_commit: SOURCE_COMMIT,
  source_dataset: MEDSP_DATASET,
  source_files: sourceFiles,
  judging_experiment_id: MEDSP_JUDGING_EXPERIMENT,
  judging_condition: "rubric_and_model_ranking (full 8-turn trajectory)",
  judgment_selection:
    "status=succeeded, experiment_id=medsp1000_all_eight_judges_v2, last row per (question_id, judge_model) in file order; conversations are the exact generation IDs those judgments reference",
  shown_to_physicians: "question_text (clinician initialization) and transcript turns; private_patient_context excluded",
};
writeFileSync("data/source/medsp1000-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Wrote ${sourceFiles.scenarios.rows} scenarios, ${sourceFiles.conversations.rows} conversations, and ${sourceFiles.judgments.rows} judgment rows`,
);
