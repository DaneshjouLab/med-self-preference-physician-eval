// Validate the repository-owned MedSP1000 source and build the sampled bundle.
//
// Inputs: data/source/medsp1000-*.jsonl + medsp1000-manifest.json
// Outputs:
//   data/study/prepared/medsp1000-bundle.json
//   data/study/medsp1000-sample-manifest.json
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "../src/lib/hash";
import {
  RUBRIC_AXES,
  type BundleItem,
  type BundleJudgmentRow,
  type BundleResponse,
} from "../src/lib/prep/bundle";
import {
  MEDSP_TURN_COUNT,
  renderTranscript,
  sampleScenarios,
  type SourceScenario,
} from "../src/lib/prep/medsp1000";

const SOURCE_MANIFEST = path.resolve("data/source/medsp1000-manifest.json");

interface SourceFile {
  path: string;
  sha256: string;
  rows: number;
}

interface SourceManifest {
  bundle_version: string;
  study: "medsp1000";
  study_seed: string;
  population_size: number;
  sample_size: number;
  visible_turns: number;
  sampling: string;
  source_repository: string;
  source_commit: string;
  source_dataset: string;
  source_files: { scenarios: SourceFile; conversations: SourceFile; judgments: SourceFile };
  judging_experiment_id: string;
  judging_condition: string;
  judgment_selection: string;
  shown_to_physicians: string;
}

type SourceConversation = BundleResponse & { question_id: string };
type SourceJudgment = BundleJudgmentRow & { question_id: string };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readJsonl<T>(file: SourceFile): T[] {
  const bytes = readFileSync(path.resolve(file.path));
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
  check(item.study === "medsp1000", `${label}: wrong study`);
  check(item.item_type === "multi_turn" && item.turn_count === MEDSP_TURN_COUNT, `${label}: wrong item shape`);
  check(item.responses.length === 8, `${label}: expected 8 conversations, found ${item.responses.length}`);
  check(new Set(item.responses.map((response) => response.response_id)).size === 8, `${label}: duplicate response IDs`);
  check(
    new Set(item.responses.map((response) => response.provenance.generator_model)).size === 8,
    `${label}: duplicate clinician models`,
  );
  for (const response of item.responses) {
    check(response.transcript?.length === MEDSP_TURN_COUNT, `${label}/${response.response_id}: wrong turn count`);
    check(renderTranscript(response.transcript) === response.response_text, `${label}/${response.response_id}: transcript drift`);
    check(
      sha256Hex(response.response_text) === response.provenance.response_text_sha256,
      `${label}/${response.response_id}: conversation hash mismatch`,
    );
  }

  check(item.llm_judgments.length === 64, `${label}: expected 64 judgment rows, found ${item.llm_judgments.length}`);
  const responseIds = new Set(item.responses.map((response) => response.response_id));
  const byJudge = new Map<string, BundleJudgmentRow[]>();
  for (const judgment of item.llm_judgments) {
    check(responseIds.has(judgment.response_id), `${label}: judgment refers to unknown response ${judgment.response_id}`);
    check(RUBRIC_AXES.every((axis) => typeof judgment.scores[axis] === "number"), `${label}: incomplete scores`);
    byJudge.set(judgment.judge_model, [...(byJudge.get(judgment.judge_model) ?? []), judgment]);
  }
  check(byJudge.size === 8, `${label}: expected 8 judges, found ${byJudge.size}`);
  for (const [judge, rows] of byJudge) {
    check(rows.length === 8 && new Set(rows.map((row) => row.response_id)).size === 8, `${label}/${judge}: incomplete candidates`);
    check(
      rows.map((row) => row.original_rank).sort((a, b) => a - b).join(",") === "1,2,3,4,5,6,7,8",
      `${label}/${judge}: ranks are not a 1-8 permutation`,
    );
  }
}

function main() {
  const meta = JSON.parse(readFileSync(SOURCE_MANIFEST, "utf8")) as SourceManifest;
  const scenarios = readJsonl<SourceScenario>(meta.source_files.scenarios);
  const conversations = readJsonl<SourceConversation>(meta.source_files.conversations);
  const judgments = readJsonl<SourceJudgment>(meta.source_files.judgments);
  check(scenarios.length === meta.population_size, `expected ${meta.population_size} scenarios, found ${scenarios.length}`);
  check(new Set(scenarios.map((scenario) => scenario.question_id)).size === scenarios.length, "duplicate scenario IDs");

  const conversationsByScenario = new Map<string, BundleResponse[]>();
  for (const { question_id, ...conversation } of conversations) {
    conversationsByScenario.set(question_id, [...(conversationsByScenario.get(question_id) ?? []), conversation]);
  }
  const judgmentsByScenario = new Map<string, BundleJudgmentRow[]>();
  for (const { question_id, ...judgment } of judgments) {
    judgmentsByScenario.set(question_id, [...(judgmentsByScenario.get(question_id) ?? []), judgment]);
  }
  const knownScenarios = new Set(scenarios.map((scenario) => scenario.question_id));
  for (const id of [...conversationsByScenario.keys(), ...judgmentsByScenario.keys()]) {
    check(knownScenarios.has(id), `source row refers to unknown scenario ${id}`);
  }

  const population = new Map<string, BundleItem>();
  for (const scenario of scenarios) {
    check(sha256Hex(scenario.question_text) === scenario.question_text_sha256, `${scenario.question_id}: question hash mismatch`);
    const item: BundleItem = {
      item_id: `medsp_${scenario.question_id}__t${MEDSP_TURN_COUNT}`,
      study: "medsp1000",
      source_question_id: scenario.question_id,
      source_dataset: scenario.source_dataset,
      item_type: "multi_turn",
      specialty: null,
      question_text: scenario.question_text,
      turn_count: MEDSP_TURN_COUNT,
      sample_index: -1,
      provenance: {
        source_revision: scenario.source_revision,
        source_scenario_path: scenario.source_scenario_path,
        question_text_sha256: scenario.question_text_sha256,
        visible_turns: MEDSP_TURN_COUNT,
      },
      responses: conversationsByScenario.get(scenario.question_id) ?? [],
      llm_judgments: judgmentsByScenario.get(scenario.question_id) ?? [],
    };
    validateItem(item);
    const serialized = JSON.stringify(item);
    check(!serialized.includes(scenario.private_patient_context), `${scenario.question_id}: private patient context leaked`);
    population.set(scenario.question_id, item);
  }

  const items = sampleScenarios([...population.keys()], meta.sample_size, meta.study_seed).map((id, sampleIndex) => ({
    ...population.get(id)!,
    sample_index: sampleIndex,
  }));
  mkdirSync("data/study/prepared", { recursive: true });
  writeFileSync("data/study/prepared/medsp1000-bundle.json", JSON.stringify({ meta, items }, null, 1) + "\n");
  writeFileSync(
    "data/study/medsp1000-sample-manifest.json",
    JSON.stringify(
      {
        ...meta,
        sampled_scenarios: items.map((item) => ({
          sample_index: item.sample_index,
          question_id: item.source_question_id,
          source_scenario_path: item.provenance.source_scenario_path,
          question_text_sha256: item.provenance.question_text_sha256,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Validated ${scenarios.length} scenarios, ${conversations.length} conversations, and ${judgments.length} judgment rows; prepared ${items.length} sampled scenarios`,
  );
}

main();
