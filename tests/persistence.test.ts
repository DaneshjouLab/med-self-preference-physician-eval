import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { assignments, responseEvaluations, responseProvenance, saveEvents } from "@/db/schema";
import { assignItems, reviewerProgress, validateStudyData } from "@/server/admin";
import { login, userForToken } from "@/server/auth";
import {
  listQueue,
  loadEvaluation,
  reopenSubmission,
  resumePosition,
  saveEvaluation,
  submitAll,
} from "@/server/evaluations";
import { buildExport, toCsv } from "@/server/exports";
import { importBundle } from "@/server/importer";
import { setInstrumentConfig } from "@/server/settings";
import { completeState, fixtureBundle, freshDb, makeReviewer, MODELS } from "./helpers";

const S = "real_pocqi" as const;
let db: DB;
let close: () => Promise<void>;
let r1: { userId: string; reviewerCode: string };
let r2: { userId: string; reviewerCode: string };

beforeEach(async () => {
  ({ db, close } = await freshDb());
  await importBundle(db, fixtureBundle(3));
  r1 = await makeReviewer(db, "reviewer1");
  r2 = await makeReviewer(db, "reviewer2");
  await assignItems(db, r1.userId, { study: S, count: 3 });
  await assignItems(db, r2.userId, { study: S, count: 3 });
});
afterEach(async () => close());

describe("import and mapping", () => {
  it("loads all eight responses per question and validates the mapping", async () => {
    const report = await validateStudyData(db);
    expect(report).toMatchObject({ ok: true, items: 3, responses: 24, judgmentRows: 192, assignments: 6 });
  });

  it("refuses to modify original responses on re-import", async () => {
    expect(await importBundle(db, fixtureBundle(3))).toEqual({ inserted: 0, unchanged: 3 });
    const tampered = fixtureBundle(3);
    tampered.items[0].responses[0].response_text += " edited";
    await expect(importBundle(db, tampered)).rejects.toThrow(/hash|different content/);
  });

  it("recovers the generator model for every response for analysis", async () => {
    const key = await buildExport(db, "response_key");
    expect(key).toHaveLength(24);
    expect(new Set(key.map((k) => k.generator_model))).toEqual(new Set(MODELS.map((m) => m[0])));
  });
});

describe("blinding", () => {
  it("never exposes model identity, internal IDs or LLM judgments to physicians", async () => {
    const payload = await loadEvaluation(db, r1.userId, S, 1);
    const json = JSON.stringify(payload);
    for (const [model, fam] of MODELS) {
      expect(json).not.toContain(model);
      expect(json.toLowerCase()).not.toContain(`"${fam}"`);
    }
    for (const forbidden of ["rsp_", "gen-fixture", "judgment-", "generator", "judge", "rank\":1", "fixture-real_pocqi-q-"]) {
      expect(json).not.toContain(forbidden);
    }
    expect(payload.responses.map((r) => r.label)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
  });

  it("shows each reviewer the same responses in a different stored order", async () => {
    const [a1] = await db.select().from(assignments).where(eq(assignments.reviewerId, r1.userId)).limit(1);
    const [a2] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.reviewerId, r2.userId))
      .orderBy(assignments.queuePosition)
      .limit(1);
    expect(a1.itemId).toBe(a2.itemId);
    expect([...a1.presentationOrder].sort()).toEqual([...a2.presentationOrder].sort());
    expect(a1.presentationOrder).not.toEqual(a2.presentationOrder);
  });
});

describe("saving and resuming", () => {
  it("round-trips scores, ranking and error flags (survives reload)", async () => {
    const state = completeState();
    state.responses.B.errorFlag = "yes";
    state.responses.B.errorCategories = ["medication_or_dose"];
    state.responses.B.errorNote = "Dose too high";
    const res = await saveEvaluation(db, r1.userId, S, 1, { state, baseRevision: 0, activeMsDelta: 5000 });
    expect(res).toMatchObject({ revision: 1, status: "complete", problems: [] });
    const reloaded = await loadEvaluation(db, r1.userId, S, 1);
    expect(reloaded.state).toEqual(state);
    expect(reloaded.revision).toBe(1);
    expect(await db.select().from(saveEvents)).toHaveLength(1);
  });

  it("stores ranks against the correct response IDs", async () => {
    await saveEvaluation(db, r1.userId, S, 1, { state: completeState(), baseRevision: 0 });
    const [a] = await db.select().from(assignments).where(eq(assignments.reviewerId, r1.userId)).limit(1);
    const rows = await db.select().from(responseEvaluations).where(eq(responseEvaluations.assignmentId, a.assignmentId));
    // completeState ranks H first: H is the 8th displayed response.
    const top = rows.find((r) => r.finalRank === 1)!;
    expect(top.responseId).toBe(a.presentationOrder[7]);
    expect(top.displayLabel).toBe("H");
  });

  it("marks partial work in progress and resumes at the first incomplete question", async () => {
    const partial = completeState();
    partial.rankingConfirmed = false;
    const res = await saveEvaluation(db, r1.userId, S, 1, { state: partial, baseRevision: 0 });
    expect(res.status).toBe("in_progress");
    expect(res.problems).toContain("Ranking has not been confirmed.");
    await saveEvaluation(db, r1.userId, S, 2, { state: completeState(), baseRevision: 0 });
    const queue = await listQueue(db, r1.userId, S);
    expect(queue.map((q) => q.status)).toEqual(["in_progress", "complete", "not_started"]);
    expect(resumePosition(queue)).toBe(1);
    const progress = (await reviewerProgress(db)).find((r) => r.userId === r1.userId)!.studies.at(0)!;
    expect(progress).toMatchObject({ complete: 1, inProgress: 1, inProgressNumbers: [1] });
    expect(progress.questions).toEqual([
      { number: 1, status: "in_progress" },
      { number: 2, status: "complete" },
      { number: 3, status: "not_started" },
    ]);
  });

  it("rejects invalid rankings and out-of-range scores", async () => {
    const dup = completeState();
    dup.ranking = ["A", "A", "C", "D", "E", "F", "G", "H"];
    await expect(saveEvaluation(db, r1.userId, S, 1, { state: dup, baseRevision: 0 })).rejects.toThrow(/more than once/);
    const bad = completeState();
    (bad.responses.A.scores as Record<string, number>).accuracy = 7;
    await expect(saveEvaluation(db, r1.userId, S, 1, { state: bad, baseRevision: 0 })).rejects.toThrow(/Invalid/);
  });

  it("detects stale writes instead of silently overwriting", async () => {
    await saveEvaluation(db, r1.userId, S, 1, { state: completeState(), baseRevision: 0 });
    await expect(saveEvaluation(db, r1.userId, S, 1, { state: completeState(), baseRevision: 0 })).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("multiple reviewers", () => {
  it("keeps reviewers' evaluations separate", async () => {
    const s1 = completeState();
    const s2 = completeState();
    s2.ranking = ["A", "B", "C", "D", "E", "F", "G", "H"];
    await saveEvaluation(db, r1.userId, S, 1, { state: s1, baseRevision: 0 });
    await saveEvaluation(db, r2.userId, S, 1, { state: s2, baseRevision: 0 });
    expect((await loadEvaluation(db, r1.userId, S, 1)).state.ranking).toEqual(s1.ranking);
    expect((await loadEvaluation(db, r2.userId, S, 1)).state.ranking).toEqual(s2.ranking);
    expect((await loadEvaluation(db, r2.userId, S, 2)).status).toBe("not_started");
    const rows = await buildExport(db, "rankings");
    expect(rows.filter((r) => r.final_rank !== null)).toHaveLength(16);
  });

  it("can only address the reviewer's own queue", async () => {
    // Positions are per-reviewer; there is no way to name another reviewer's assignment.
    await expect(loadEvaluation(db, r1.userId, S, 4)).rejects.toMatchObject({ status: 404 });
  });
});

describe("submission", () => {
  it("only submits when complete, then freezes until reopened", async () => {
    await expect(submitAll(db, r1.userId, S)).rejects.toThrow(/incomplete/);
    for (const p of [1, 2, 3]) await saveEvaluation(db, r1.userId, S, p, { state: completeState(), baseRevision: 0 });
    const summary = await submitAll(db, r1.userId, S);
    expect(summary.submittedAt).not.toBeNull();
    await expect(saveEvaluation(db, r1.userId, S, 1, { state: completeState(), baseRevision: 1 })).rejects.toMatchObject({
      status: 423,
    });
    expect((await loadEvaluation(db, r1.userId, S, 1)).locked).toBe(true);
    await reopenSubmission(db, r1.userId, S);
    await expect(saveEvaluation(db, r1.userId, S, 1, { state: completeState(), baseRevision: 1 })).resolves.toMatchObject({
      revision: 2,
    });
  });

  it("applies the configured rubric mode", async () => {
    await setInstrumentConfig(db, { rubricMode: "off", errorMode: "off" });
    const s = completeState();
    for (const l of Object.keys(s.responses)) s.responses[l].scores = {};
    expect((await saveEvaluation(db, r1.userId, S, 1, { state: s, baseRevision: 0 })).status).toBe("complete");
  });
});

describe("exports", () => {
  it("match the database and join physician judgments to original LLM judgments by ID", async () => {
    await saveEvaluation(db, r1.userId, S, 1, { state: completeState(), baseRevision: 0 });
    const [a] = await db.select().from(assignments).where(eq(assignments.reviewerId, r1.userId)).limit(1);
    const dbRows = await db.select().from(responseEvaluations).where(eq(responseEvaluations.assignmentId, a.assignmentId));
    const prov = new Map((await db.select().from(responseProvenance)).map((p) => [p.responseId, p.generatorModel]));

    const rubric = (await buildExport(db, "rubric_scores")).filter((r) => r.assignment_id === a.assignmentId);
    for (const row of dbRows) {
      const exp = rubric.find((r) => r.response_id === row.responseId)!;
      expect(exp.accuracy).toBe(row.accuracy);
      expect(exp.sum_score).toBe(
        row.accuracy! + row.clinicalUtility! + row.sourceQuality! + row.verifiability! + row.completeness!,
      );
    }

    const analysis = (await buildExport(db, "analysis")).filter((r) => r.assignment_id === a.assignmentId);
    expect(analysis).toHaveLength(64); // 8 responses × 8 judges
    for (const row of analysis) {
      expect(row.generator_model).toBe(prov.get(row.response_id as string));
      expect(row.llm_self_judge).toBe(row.llm_judge_model === row.generator_model);
    }
    expect(analysis.filter((r) => r.llm_self_judge)).toHaveLength(8);

    const csv = toCsv(rubric);
    expect(csv.split("\n")[0]).toContain("response_id");
    expect(csv.trim().split("\n")).toHaveLength(9);
  });

  it("excludes administrator test evaluations and neutralises formula text in CSV", async () => {
    const s = completeState();
    s.responses.A.errorFlag = "yes";
    s.responses.A.errorNote = "=HYPERLINK(\"x\")";
    await saveEvaluation(db, r1.userId, S, 1, { state: s, baseRevision: 0 });
    const csv = toCsv(await buildExport(db, "error_annotations"));
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe("auth", () => {
  it("issues sessions only for valid credentials", async () => {
    expect(await login(db, "reviewer1", "wrong-password!!")).toBeNull();
    const ok = await login(db, "Reviewer1", "correct-horse-battery");
    expect(ok?.user.reviewerCode).toBe(r1.reviewerCode);
    expect((await userForToken(db, ok!.token))?.userId).toBe(r1.userId);
    expect(await userForToken(db, "not-a-token")).toBeNull();
  });
});
