import { AdminPanel } from "@/components/AdminPanel";
import { SimpleHeader } from "@/components/SimpleHeader";
import { STUDY_IDS, type StudyId } from "@/lib/studies";
import { itemCounts, reviewerProgress, validateStudyData } from "@/server/admin";
import { requirePageUser } from "@/server/http";
import { getStudySeed } from "@/server/settings";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { user, db } = await requirePageUser("admin");
  const [reviewers, counts, validation, seeds] = await Promise.all([
    reviewerProgress(db),
    itemCounts(db),
    validateStudyData(db),
    Promise.all(STUDY_IDS.map(async (s) => [s, await getStudySeed(db, s)] as const)),
  ]);
  return (
    <>
      <SimpleHeader who={`${user.displayName ?? user.reviewerCode} (admin)`} />
      <AdminPanel
        reviewers={reviewers.map((r) => ({
          ...r,
          studies: r.studies.map((st) => ({
            ...st,
            submittedAt: st.submittedAt?.toISOString() ?? null,
            lastSavedAt: st.lastSavedAt?.toISOString() ?? null,
          })),
        }))}
        itemCounts={counts}
        validation={validation}
        studySeeds={Object.fromEntries(seeds) as Record<StudyId, string | null>}
      />
    </>
  );
}
