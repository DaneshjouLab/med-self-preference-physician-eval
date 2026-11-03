// Local prototype setup: import all prepared items of each study, create one
// admin and two reviewers per study, and assign the first 5 items of a study to
// both of its reviewers.
//
//   npm run demo:seed                 # as above
//   npm run demo:seed -- --plans      # also create 8 + 8 test physicians and apply
//                                     # both study plans (4 calibration, 3 graders)
//
// For local development only. Demo accounts use DEMO_PASSWORD (default
// "physicantest"); never use them for real reviewers.
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { openFromEnv } from "../src/db";
import { users } from "../src/db/schema";
import type { StudyId } from "../src/lib/studies";
import { assignItems, validateStudyData } from "../src/server/admin";
import { createUser } from "../src/server/auth";
import { importBundle, type StudyBundle } from "../src/server/importer";
import { applyPlan, defaultPlanSeed, planStatus } from "../src/server/plans";

const DEMO_ITEMS = 5;
const WITH_PLANS = process.argv.includes("--plans");
const BUNDLES: Record<StudyId, string> = {
  real_pocqi: "data/study/prepared/real-pocqi-bundle.json",
  medsp1000: "data/study/prepared/medsp1000-bundle.json",
};

if (process.env.DATABASE_URL) {
  console.error("Refusing to seed demo accounts into DATABASE_URL; demo:seed is for local PGlite only.");
  process.exit(1);
}
const password = process.env.DEMO_PASSWORD || "physicantest";
const handle = openFromEnv();
await handle.migrate();
const db = handle.db;

for (const [study, file] of Object.entries(BUNDLES) as [StudyId, string][]) {
  const bundle = JSON.parse(readFileSync(file, "utf8")) as StudyBundle;
  const imported = await importBundle(db, bundle);
  console.log(`${study}: ${imported.inserted} imported, ${imported.unchanged} already present`);
}

const accounts: { username: string; role: "admin" | "reviewer"; study?: StudyId }[] = [
  { username: "admin", role: "admin" },
  { username: "reviewer1", role: "reviewer", study: "real_pocqi" },
  { username: "reviewer2", role: "reviewer", study: "real_pocqi" },
  { username: "sp-reviewer1", role: "reviewer", study: "medsp1000" },
  { username: "sp-reviewer2", role: "reviewer", study: "medsp1000" },
];
for (const acct of accounts) {
  let [user] = await db.select().from(users).where(eq(users.username, acct.username));
  if (user) {
    console.log(`${acct.username}: already exists (${user.reviewerCode})`);
  } else {
    await createUser(db, { username: acct.username, role: acct.role, password });
    [user] = await db.select().from(users).where(eq(users.username, acct.username));
    console.log(`${acct.username} (${acct.role}, ${user.reviewerCode}) password: ${password}`);
  }
  // Idempotent: items the reviewer already has are skipped.
  if (acct.study) await assignItems(db, user.userId, { study: acct.study, start: 0, count: DEMO_ITEMS });
}
if (WITH_PLANS) {
  for (const study of ["real_pocqi", "medsp1000"] as const) {
    if (await planStatus(db, study)) {
      console.log(`${study}: plan already applied`);
      continue;
    }
    const prefix = study === "real_pocqi" ? "plan-rp" : "plan-sp";
    const ids: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const username = `${prefix}${i}`;
      let [u] = await db.select().from(users).where(eq(users.username, username));
      if (!u) {
        await createUser(db, { username, role: "reviewer", password });
        [u] = await db.select().from(users).where(eq(users.username, username));
      }
      ids.push(u.userId);
    }
    const r = await applyPlan(db, { study, reviewerIds: ids, calibrationCount: 4, gradersPerCase: 3, seed: defaultPlanSeed(study) });
    console.log(`${study}: plan applied to ${prefix}1–${prefix}8 (${r.assignments} assignments, password: ${password})`);
  }
}

const report = await validateStudyData(db);
console.log(`Validation: ${report.ok ? "OK" : report.problems.join("; ")}`);
await handle.close();
