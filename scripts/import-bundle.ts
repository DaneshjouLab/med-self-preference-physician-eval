// Import prepared study items into the database (insert-only).
//   npm run db:import                                  # every prepared bundle, all items
//   npm run db:import -- --study real_pocqi --limit 5  # first 5 items of one study's frozen sample
import { existsSync, readFileSync } from "node:fs";
import { openFromEnv } from "../src/db";
import { isStudyId, STUDY_IDS } from "../src/lib/studies";
import { validateStudyData } from "../src/server/admin";
import { importBundle, type StudyBundle } from "../src/server/importer";

export const BUNDLE_FILES = {
  real_pocqi: "data/study/prepared/real-pocqi-bundle.json",
  medsp1000: "data/study/prepared/medsp1000-bundle.json",
} as const;

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const limit = arg("limit") ? Number(arg("limit")) : undefined;
const only = arg("study");
if (only && !isStudyId(only)) throw new Error(`unknown study ${only}; expected one of ${STUDY_IDS.join(", ")}`);

const handle = openFromEnv();
await handle.migrate();
for (const study of STUDY_IDS) {
  if (only && study !== only) continue;
  const file = BUNDLE_FILES[study];
  if (!existsSync(file)) {
    console.log(`${study}: ${file} not found (run npm run data:prepare); skipped`);
    continue;
  }
  const bundle = JSON.parse(readFileSync(file, "utf8")) as StudyBundle;
  const result = await importBundle(handle.db, bundle, { limit });
  console.log(`${study}: imported ${result.inserted} new items (${result.unchanged} already present, verified identical)`);
}
const report = await validateStudyData(handle.db);
console.log(`Validation: ${report.ok ? "OK" : "PROBLEMS"} — ${report.items} items, ${report.responses} responses, ${report.judgmentRows} LLM judgment rows`);
for (const p of report.problems) console.log(`  - ${p}`);
await handle.close();
if (!report.ok) process.exit(1);
