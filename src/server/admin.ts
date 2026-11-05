// Administrator operations. Callers must have verified role === "admin".
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, max, notInArray, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { assignments, items, llmJudgments, responseProvenance, responses, studyPlans, users } from "@/db/schema";
import { sha256Hex } from "@/lib/hash";
import { presentationOrder } from "@/lib/ordering";
import type { StudyPlan } from "@/lib/plan";
import { STUDIES, STUDY_IDS, type StudyId } from "@/lib/studies";
import { getStudySeed } from "./settings";

export interface StudyProgress {
  study: StudyId;
  assigned: number;
  complete: number;
  inProgress: number;
  /** 1-based question numbers (as the physician sees them) that are started but not finished. */
  inProgressNumbers: number[];
  notStarted: number;
  /** Frozen study question numbers and their current status for the admin assignment table. */
  questions: { number: number; status: "not_started" | "in_progress" | "complete" }[];
  /** Set when every assignment in the study has been submitted. */
  submittedAt: Date | null;
  lastSavedAt: Date | null;
}

export interface ReviewerProgress {
  userId: string;
  reviewerCode: string;
  username: string;
  displayName: string | null;
  role: "reviewer" | "admin";
  active: boolean;
  specialty: string | null;
  yearsInPractice: number | null;
  studies: StudyProgress[];
}

export async function reviewerProgress(db: DB): Promise<ReviewerProgress[]> {
  const people = await db.select().from(users).orderBy(asc(users.role), asc(users.reviewerCode));
  const rows = await db
    .select({
      reviewerId: assignments.reviewerId,
      study: assignments.study,
      assigned: sql<number>`count(*)::int`,
      complete: sql<number>`count(*) filter (where ${assignments.status} = 'complete')::int`,
      inProgress: sql<number>`count(*) filter (where ${assignments.status} = 'in_progress')::int`,
      notStarted: sql<number>`count(*) filter (where ${assignments.status} = 'not_started')::int`,
      unsubmitted: sql<number>`count(*) filter (where ${assignments.submittedAt} is null)::int`,
      submittedAt: max(assignments.submittedAt),
      lastSavedAt: max(assignments.lastSavedAt),
    })
    .from(assignments)
    .where(isNull(assignments.transferredAt))
    .groupBy(assignments.reviewerId, assignments.study);
  // Question numbers match the physician's own numbering: position in their live queue.
  const queues = await db
    .select({
      reviewerId: assignments.reviewerId,
      study: assignments.study,
      status: assignments.status,
      questionNumber: sql<number>`${items.sampleIndex} + 1`,
    })
    .from(assignments)
    .innerJoin(items, eq(items.itemId, assignments.itemId))
    .where(isNull(assignments.transferredAt))
    .orderBy(asc(assignments.reviewerId), asc(assignments.study), asc(assignments.queuePosition));
  const startedNumbers = new Map<string, number[]>();
  const questionStatuses = new Map<string, StudyProgress["questions"]>();
  const seen = new Map<string, number>();
  for (const a of queues) {
    const key = `${a.reviewerId}\u0000${a.study}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (a.status === "in_progress") startedNumbers.set(key, [...(startedNumbers.get(key) ?? []), n]);
    questionStatuses.set(key, [
      ...(questionStatuses.get(key) ?? []),
      { number: a.questionNumber, status: a.status },
    ]);
  }
  return people.map((u) => ({
    userId: u.userId,
    reviewerCode: u.reviewerCode,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    active: u.active,
    specialty: u.specialty,
    yearsInPractice: u.yearsInPractice,
    studies: rows
      .filter((r) => r.reviewerId === u.userId)
      .sort((a, b) => STUDY_IDS.indexOf(a.study) - STUDY_IDS.indexOf(b.study))
      .map(({ study, assigned, complete, inProgress, notStarted, unsubmitted, submittedAt, lastSavedAt }) => ({
        study,
        assigned,
        complete,
        inProgress,
        inProgressNumbers: startedNumbers.get(`${u.userId}\u0000${study}`) ?? [],
        notStarted,
        questions: (questionStatuses.get(`${u.userId}\u0000${study}`) ?? []).sort((a, b) => a.number - b.number),
        submittedAt: unsubmitted === 0 && submittedAt ? new Date(submittedAt) : null,
        lastSavedAt: lastSavedAt ? new Date(lastSavedAt) : null,
      })),
  }));
}

export async function itemCounts(db: DB): Promise<Record<StudyId, number>> {
  const rows = await db.select({ study: items.study, n: sql<number>`count(*)::int` }).from(items).groupBy(items.study);
  return Object.fromEntries(STUDY_IDS.map((s) => [s, rows.find((r) => r.study === s)?.n ?? 0])) as Record<StudyId, number>;
}

/**
 * Append items of one study (by frozen sample order) to a reviewer's queue for
 * that study. `count` items starting at sample index `start` are assigned;
 * items the reviewer already has are skipped. Presentation order is computed
 * once and stored.
 */
export async function assignItems(db: DB, reviewerId: string, opts: { study: StudyId; start?: number; count: number }) {
  const { study } = opts;
  const seed = await getStudySeed(db, study);
  if (!seed) throw new Error(`No ${STUDIES[study].name} bundle has been imported`);
  const [reviewer] = await db.select().from(users).where(eq(users.userId, reviewerId));
  if (!reviewer) throw new Error("Reviewer not found");
  const [submitted] = await db
    .select({ id: assignments.assignmentId })
    .from(assignments)
    .where(and(eq(assignments.reviewerId, reviewerId), eq(assignments.study, study), isNotNull(assignments.submittedAt)))
    .limit(1);
  if (submitted) throw new Error(`Reviewer has already submitted ${STUDIES[study].name}; reopen before adding questions`);

  return db.transaction(async (tx) => {
    const already = await tx.select({ itemId: assignments.itemId }).from(assignments).where(eq(assignments.reviewerId, reviewerId));
    const start = opts.start ?? 0;
    const candidates = await tx
      .select({ itemId: items.itemId })
      .from(items)
      .where(
        and(
          eq(items.study, study),
          sql`${items.sampleIndex} >= ${start} and ${items.sampleIndex} < ${start + opts.count}`,
          already.length ? notInArray(items.itemId, already.map((a) => a.itemId)) : undefined,
        ),
      )
      .orderBy(asc(items.sampleIndex));
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${assignments.queuePosition}) + 1, 0)::int` })
      .from(assignments)
      .where(and(eq(assignments.reviewerId, reviewerId), eq(assignments.study, study)));
    let position = next;
    for (const c of candidates) {
      const respIds = (await tx.select({ id: responses.responseId }).from(responses).where(eq(responses.itemId, c.itemId))).map(
        (r) => r.id,
      );
      await tx.insert(assignments).values({
        assignmentId: randomUUID(),
        reviewerId,
        itemId: c.itemId,
        study,
        queuePosition: position,
        presentationOrder: presentationOrder({
          studySeed: seed,
          itemId: c.itemId,
          responseIds: respIds,
          queuePosition: position,
          reviewerSlot: reviewer.reviewerSlot,
        }),
      });
      position++;
    }
    return { assigned: candidates.length };
  });
}

export class ManualAssignmentError extends Error {}

/**
 * Replace a reviewer's manual assignments with the requested frozen study
 * question numbers. Existing work and plan-managed assignments are protected.
 */
export async function setManualAssignments(
  db: DB,
  reviewerId: string,
  study: StudyId,
  questionNumbers: number[],
): Promise<{ assigned: number; added: number; removed: number }> {
  const wanted = [...new Set(questionNumbers)].sort((a, b) => a - b);
  if (wanted.some((n) => !Number.isInteger(n) || n < 1)) throw new ManualAssignmentError("Question numbers must be positive integers");

  const seed = await getStudySeed(db, study);
  if (!seed) throw new ManualAssignmentError(`No ${STUDIES[study].name} questions have been imported`);

  return db.transaction(async (tx) => {
    const [reviewer] = await tx.select().from(users).where(eq(users.userId, reviewerId));
    if (!reviewer || reviewer.role !== "reviewer") throw new ManualAssignmentError("Reviewer not found");

    const requestedItems = wanted.length
      ? await tx
          .select({ itemId: items.itemId, questionNumber: sql<number>`${items.sampleIndex} + 1` })
          .from(items)
          .where(and(eq(items.study, study), inArray(items.sampleIndex, wanted.map((n) => n - 1))))
      : [];
    const found = new Set(requestedItems.map((i) => i.questionNumber));
    const missing = wanted.filter((n) => !found.has(n));
    if (missing.length) {
      throw new ManualAssignmentError(
        `${STUDIES[study].name} question${missing.length === 1 ? "" : "s"} ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not imported`,
      );
    }

    const live = await tx
      .select({
        assignmentId: assignments.assignmentId,
        itemId: assignments.itemId,
        status: assignments.status,
        planId: assignments.planId,
        questionNumber: sql<number>`${items.sampleIndex} + 1`,
      })
      .from(assignments)
      .innerJoin(items, eq(items.itemId, assignments.itemId))
      .where(and(eq(assignments.reviewerId, reviewerId), eq(assignments.study, study), isNull(assignments.transferredAt)));
    const wantedSet = new Set(wanted);
    const removing = live.filter((a) => !wantedSet.has(a.questionNumber));
    const planManaged = removing.filter((a) => a.planId !== null).map((a) => a.questionNumber);
    if (planManaged.length) {
      throw new ManualAssignmentError(`Question${planManaged.length === 1 ? "" : "s"} ${planManaged.join(", ")} belong to an applied study plan and cannot be removed here`);
    }
    const started = removing.filter((a) => a.status !== "not_started").map((a) => a.questionNumber);
    if (started.length) {
      throw new ManualAssignmentError(`Question${started.length === 1 ? "" : "s"} ${started.join(", ")} already contain saved work and cannot be removed`);
    }

    if (removing.length) {
      await tx.delete(assignments).where(inArray(assignments.assignmentId, removing.map((a) => a.assignmentId)));
    }

    const liveItemIds = new Set(live.map((a) => a.itemId));
    const adding = requestedItems.filter((i) => !liveItemIds.has(i.itemId));
    if (adding.length) {
      const historical = await tx
        .select({ itemId: assignments.itemId })
        .from(assignments)
        .where(and(eq(assignments.reviewerId, reviewerId), inArray(assignments.itemId, adding.map((a) => a.itemId))));
      if (historical.length) throw new ManualAssignmentError("A transferred historical assignment cannot be assigned back to the same reviewer");
    }

    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${assignments.queuePosition}) + 1, 0)::int` })
      .from(assignments)
      .where(and(eq(assignments.reviewerId, reviewerId), eq(assignments.study, study), isNull(assignments.transferredAt)));
    let position = next;
    for (const item of adding.sort((a, b) => a.questionNumber - b.questionNumber)) {
      const responseIds = (await tx.select({ id: responses.responseId }).from(responses).where(eq(responses.itemId, item.itemId))).map((r) => r.id);
      await tx.insert(assignments).values({
        assignmentId: randomUUID(),
        reviewerId,
        itemId: item.itemId,
        study,
        queuePosition: position++,
        presentationOrder: presentationOrder({
          studySeed: seed,
          itemId: item.itemId,
          responseIds,
          queuePosition: position - 1,
          reviewerSlot: reviewer.reviewerSlot,
        }),
      });
    }

    return { assigned: wanted.length, added: adding.length, removed: removing.length };
  });
}

export async function setReviewerProfile(db: DB, userId: string, profile: { specialty: string | null; yearsInPractice: number | null }) {
  await db
    .update(users)
    .set({ specialty: profile.specialty?.trim() || null, yearsInPractice: profile.yearsInPractice })
    .where(eq(users.userId, userId));
}

export async function setReviewerActive(db: DB, userId: string, active: boolean) {
  await db.update(users).set({ active }).where(eq(users.userId, userId));
}

export interface ValidationReport {
  ok: boolean;
  items: number;
  responses: number;
  judgmentRows: number;
  assignments: number;
  problems: string[];
}

/** Integrity checks over imported content, protected mappings and assignments. */
export async function validateStudyData(db: DB): Promise<ValidationReport> {
  const problems: string[] = [];
  const allItems = await db.select({ itemId: items.itemId }).from(items);
  const allResponses = await db.select().from(responses);
  const prov = new Map((await db.select().from(responseProvenance)).map((p) => [p.responseId, p]));
  const judg = await db
    .select({
      itemId: llmJudgments.itemId,
      responseId: llmJudgments.responseId,
      generatorModel: llmJudgments.generatorModel,
      judgeModel: llmJudgments.judgeModel,
      originalRank: llmJudgments.originalRank,
    })
    .from(llmJudgments);
  const asg = await db.select().from(assignments);

  const respByItem = new Map<string, typeof allResponses>();
  for (const r of allResponses) respByItem.set(r.itemId, [...(respByItem.get(r.itemId) ?? []), r]);
  for (const { itemId } of allItems) {
    const rs = respByItem.get(itemId) ?? [];
    if (rs.length !== 8) problems.push(`${itemId}: ${rs.length} responses (expected 8)`);
    const models = new Set<string>();
    for (const r of rs) {
      const p = prov.get(r.responseId);
      if (!p) problems.push(`${r.responseId}: no provenance`);
      else {
        models.add(p.generatorModel);
        if (sha256Hex(r.responseText) !== p.responseTextSha256) problems.push(`${r.responseId}: text hash mismatch`);
      }
    }
    if (models.size !== rs.length) problems.push(`${itemId}: generator models not unique`);
    const js = judg.filter((j) => j.itemId === itemId);
    if (js.length !== rs.length * rs.length) {
      problems.push(`${itemId}: ${js.length} judgment rows (expected ${rs.length * rs.length})`);
    }
    for (const j of js) {
      if (prov.get(j.responseId)?.generatorModel !== j.generatorModel) problems.push(`${itemId}: judgment generator mismatch`);
    }
    const judges = new Set(js.map((j) => j.judgeModel));
    for (const judge of judges) {
      const ranks = js.filter((j) => j.judgeModel === judge).map((j) => j.originalRank).sort((a, b) => a! - b!);
      if (ranks.join() !== rs.map((_, i) => i + 1).join()) problems.push(`${itemId}: judge ${judge} ranks are not 1..${rs.length}`);
    }
  }
  for (const a of asg) {
    const ids = new Set((respByItem.get(a.itemId) ?? []).map((r) => r.responseId));
    const order = a.presentationOrder;
    if (order.length !== ids.size || new Set(order).size !== order.length || order.some((id) => !ids.has(id))) {
      problems.push(`assignment ${a.assignmentId}: presentation order is not a permutation of the item's responses`);
    }
  }
  // Every applied plan still gives each case its required number of (live) graders.
  for (const plan of await db.select().from(studyPlans)) {
    const design = plan.design as StudyPlan;
    const live = new Map<string, number>();
    for (const a of asg) {
      if (a.planId === plan.planId && a.transferredAt === null) live.set(a.itemId, (live.get(a.itemId) ?? 0) + 1);
    }
    for (const id of design.calibration) {
      if (live.get(id) !== plan.physicianCount) problems.push(`${plan.study} plan: calibration case ${id} has ${live.get(id) ?? 0} graders`);
    }
    for (const id of design.blocks.flat()) {
      if (live.get(id) !== plan.gradersPerCase) problems.push(`${plan.study} plan: case ${id} has ${live.get(id) ?? 0} graders`);
    }
  }
  return {
    ok: problems.length === 0,
    items: allItems.length,
    responses: allResponses.length,
    judgmentRows: judg.length,
    assignments: asg.length,
    problems: problems.slice(0, 200),
  };
}
