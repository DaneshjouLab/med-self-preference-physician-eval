// Set up a clean study database the way the real study starts: every prepared
// case imported, one admin account, no physicians and no assignments. The study
// team then creates physician accounts and applies each study's plan from the
// admin dashboard.
//
//   npm run study:setup                      # local study database in ./.data/study
//   DATABASE_URL=... npm run study:setup     # a hosted Postgres database
//
// Admin username: STUDY_ADMIN_USERNAME (default "admin"). Password: PE_PASSWORD,
// or generated and printed once.
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { openFromEnv } from "../src/db";
import { users } from "../src/db/schema";
import { STUDY_IDS } from "../src/lib/studies";
import { validateStudyData } from "../src/server/admin";
import { createUser, generatePassword } from "../src/server/auth";
import { importBundle, type StudyBundle } from "../src/server/importer";

const BUNDLES = {
  real_pocqi: "data/study/prepared/real-pocqi-bundle.json",
  medsp1000: "data/study/prepared/medsp1000-bundle.json",
} as const;

const handle = openFromEnv();
await handle.migrate();
const db = handle.db;

for (const study of STUDY_IDS) {
  if (!existsSync(BUNDLES[study])) throw new Error(`${BUNDLES[study]} not found; run npm run data:prepare`);
  const bundle = JSON.parse(readFileSync(BUNDLES[study], "utf8")) as StudyBundle;
  const r = await importBundle(db, bundle);
  console.log(`${study}: ${r.inserted} cases imported, ${r.unchanged} already present`);
}

const username = process.env.STUDY_ADMIN_USERNAME || "admin";
const [existing] = await db.select().from(users).where(eq(users.username, username));
if (existing) {
  console.log(`Admin account "${username}" already exists`);
} else {
  const password = process.env.PE_PASSWORD || generatePassword();
  await createUser(db, { username, password, role: "admin" });
  console.log(`Created admin account "${username}"${process.env.PE_PASSWORD ? "" : `, password: ${password}`}`);
}

const others = await db.select().from(users).where(eq(users.role, "reviewer"));
console.log(`Physician accounts: ${others.length}`);
const report = await validateStudyData(db);
console.log(`Validation: ${report.ok ? "OK" : report.problems.join("; ")}`);
await handle.close();
if (!report.ok) process.exit(1);
