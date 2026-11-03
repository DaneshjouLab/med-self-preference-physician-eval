import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/hash";
import { responseIdFor, stratifiedSample, type SourceQuestion } from "@/lib/prep/realPocqi";
import type { StudyBundle } from "@/server/importer";

const fakeQuestions: SourceQuestion[] = Array.from({ length: 90 }, (_, i) => ({
  question_id: `q-${i}`,
  question_text: `[synthetic ${i}]`,
  specialty: ["Alpha", "Beta", "Gamma"][i % 3],
  source_dataset: "fixture",
  source_revision: "x",
  source_file: "x",
  source_row_index: i,
}));

describe("committed Real-POCQi source", () => {
  const manifest = JSON.parse(readFileSync("data/source/real-pocqi-manifest.json", "utf8")) as {
    population_size: number;
    source_files: Record<string, { path: string; sha256: string; rows: number }>;
  };

  it("contains the complete 620-question population and its linked experiment data", () => {
    expect(manifest.population_size).toBe(620);
    expect(manifest.source_files.questions.rows).toBe(620);
    expect(manifest.source_files.answers.rows).toBe(4_960);
    expect(manifest.source_files.judgments.rows).toBe(39_680);
    for (const file of Object.values(manifest.source_files)) {
      const bytes = readFileSync(file.path);
      expect(bytes.toString("utf8").trimEnd().split("\n")).toHaveLength(file.rows);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
  });
});

describe("committed MedSP1000 source", () => {
  const manifest = JSON.parse(readFileSync("data/source/medsp1000-manifest.json", "utf8")) as {
    population_size: number;
    source_files: Record<string, { path: string; sha256: string; rows: number }>;
  };

  it("contains the complete 200-scenario population and its linked experiment data", () => {
    expect(manifest.population_size).toBe(200);
    expect(manifest.source_files.scenarios.rows).toBe(200);
    expect(manifest.source_files.conversations.rows).toBe(1_600);
    expect(manifest.source_files.judgments.rows).toBe(12_800);
    for (const file of Object.values(manifest.source_files)) {
      const bytes = readFileSync(file.path);
      expect(bytes.toString("utf8").trimEnd().split("\n")).toHaveLength(file.rows);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
  });
});

describe("stratified sampling", () => {
  it("is deterministic, proportional and order-independent", () => {
    const a = stratifiedSample(fakeQuestions, 30, "seed");
    const b = stratifiedSample([...fakeQuestions].reverse(), 30, "seed");
    expect(a.map((q) => q.question_id)).toEqual(b.map((q) => q.question_id));
    expect(new Set(a.map((q) => q.question_id)).size).toBe(30);
    for (const s of ["Alpha", "Beta", "Gamma"]) expect(a.filter((q) => q.specialty === s)).toHaveLength(10);
    expect(stratifiedSample(fakeQuestions, 30, "other").map((q) => q.question_id)).not.toEqual(a.map((q) => q.question_id));
  });

  it("derives stable response IDs from generation IDs", () => {
    expect(responseIdFor("gen-1")).toBe(responseIdFor("gen-1"));
    expect(responseIdFor("gen-1")).not.toBe(responseIdFor("gen-2"));
    expect(responseIdFor("gen-1")).toMatch(/^rsp_[0-9a-f]{20}$/);
  });
});

// Runs after `npm run data:prepare`; source data is committed in data/source.
const BUNDLE = "data/study/prepared/real-pocqi-bundle.json";
describe.skipIf(!existsSync(BUNDLE))("prepared Real-POCQi bundle", () => {
  const bundle = existsSync(BUNDLE) ? (JSON.parse(readFileSync(BUNDLE, "utf8")) as StudyBundle) : null;
  const manifest = JSON.parse(readFileSync("data/study/real-pocqi-sample-manifest.json", "utf8"));

  it("has 100 questions × 8 responses × 8 judges, all linked by ID", () => {
    const items = bundle!.items;
    expect(items).toHaveLength(100);
    expect(new Set(items.map((i) => i.specialty)).size).toBe(30);
    const allResponseIds = new Set<string>();
    for (const it of items) {
      expect(it.responses).toHaveLength(8);
      expect(new Set(it.responses.map((r) => r.provenance.generator_model)).size).toBe(8);
      expect(it.llm_judgments).toHaveLength(64);
      expect(new Set(it.llm_judgments.map((j) => j.judge_model)).size).toBe(8);
      const ids = new Set(it.responses.map((r) => r.response_id));
      for (const r of it.responses) {
        allResponseIds.add(r.response_id);
        expect(r.response_id).toBe(responseIdFor(r.provenance.generation_id));
        expect(sha256Hex(r.response_text)).toBe(r.provenance.response_text_sha256);
      }
      for (const j of it.llm_judgments) expect(ids.has(j.response_id)).toBe(true);
    }
    expect(allResponseIds.size).toBe(800);
  });

  it("matches the committed sample manifest", () => {
    expect(bundle!.items.map((i) => i.source_question_id)).toEqual(
      manifest.sampled_questions.map((q: { question_id: string }) => q.question_id),
    );
    expect(bundle!.meta.study_seed).toBe(manifest.study_seed);
  });
});

// Runs only after `npm run data:fetch && npm run data:prepare`.
const MEDSP_BUNDLE = "data/study/prepared/medsp1000-bundle.json";
const MEDSP_SCENARIOS = ".source/Medical-LLM-Self-Preference/data/question_sets/medsp1000_generation_cases.jsonl";
describe.skipIf(!existsSync(MEDSP_BUNDLE))("prepared MedSP1000 bundle", () => {
  const bundle = existsSync(MEDSP_BUNDLE) ? (JSON.parse(readFileSync(MEDSP_BUNDLE, "utf8")) as StudyBundle) : null;

  it("has 100 scenarios × 8 eight-turn conversations × 8 judges, all linked by ID", () => {
    const items = bundle!.items;
    expect(items).toHaveLength(100);
    for (const it of items) {
      expect(it.study).toBe("medsp1000");
      expect(it.turn_count).toBe(8);
      expect(it.responses).toHaveLength(8);
      expect(new Set(it.responses.map((r) => r.provenance.generator_model)).size).toBe(8);
      expect(it.llm_judgments).toHaveLength(64);
      expect(new Set(it.llm_judgments.map((j) => j.experiment_id))).toEqual(new Set(["medsp1000_all_eight_judges_v2"]));
      for (const r of it.responses) {
        expect(r.transcript).toHaveLength(8);
        expect(r.transcript!.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n")).toBe(r.response_text);
        expect(sha256Hex(r.response_text)).toBe(r.provenance.response_text_sha256);
      }
    }
  });

  it.skipIf(!existsSync(MEDSP_SCENARIOS))("never contains patient-only script text", () => {
    const scenarios = readFileSync(MEDSP_SCENARIOS, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { question_text: string; private_patient_context: string });
    const clinicianVisible = scenarios.map((s) => s.question_text);
    // Text the physician sees that is NOT the simulated patient speaking: case info + clinician turns.
    const nonPatientText = bundle!.items.flatMap((it) => [
      it.question_text,
      ...it.responses.flatMap((r) => r.transcript!.filter((t) => t.role === "clinician").map((t) => t.content)),
    ]);
    for (const s of scenarios) {
      const t = s.private_patient_context;
      expect(nonPatientText.some((x) => x.includes(t))).toBe(false);
      // A distinctive slice may appear only where the source's clinician-facing packet also
      // contains it (shared case-template text the judges saw too). Patient turns are
      // excluded: the simulator sometimes repeats its script verbatim, and the judges saw
      // those turns exactly as physicians do.
      for (const start of [0, Math.floor(t.length / 3), Math.floor((2 * t.length) / 3)]) {
        const slice = t.slice(start, start + 80);
        if (slice.length < 60 || !nonPatientText.some((x) => x.includes(slice))) continue;
        expect(clinicianVisible.some((q) => q.includes(slice))).toBe(true);
      }
    }
  });
});
