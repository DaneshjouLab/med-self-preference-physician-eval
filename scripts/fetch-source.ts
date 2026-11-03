// Clone the original research repository at a pinned commit into ./.source and
// materialise the Git LFS files the app needs, verifying each against the
// sha256 recorded in its LFS pointer. Does not require git-lfs.
//
//   npm run data:fetch            # files needed for MedSP1000 (8 turns)
//   npm run data:fetch -- --all   # every LFS judgment file
//
// Downloaded LFS objects are kept in .source/lfs-cache/<sha256> so switching the
// pinned commit never re-downloads a file whose content did not change.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { SOURCE_COMMIT, SOURCE_REPO } from "../src/lib/prep/source";

const DEST = path.resolve(".source/Medical-LLM-Self-Preference");
const CACHE = path.resolve(".source/lfs-cache");

const REQUIRED_LFS = [
  "data/outputs/medsp1000/judgements/rubric_and_model_ranking.jsonl",
];
const OPTIONAL_LFS = [
  "data/real_pcoqi/judgements/direct_ranking.jsonl",
  "data/real_pcoqi/judgements/identity_revealed_rubric_and_model_ranking.jsonl",
  "data/real_pcoqi/judgements/score_only.jsonl",
  "data/outputs/medsp1000/judgements/rubric_and_model_ranking_2_turns.jsonl",
  "data/outputs/medsp1000/judgements/rubric_and_model_ranking_4_turns.jsonl",
  "data/outputs/medsp1000/judgements/rubric_and_model_ranking_6_turns.jsonl",
];

function git(args: string[], cwd?: string) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
}

async function fileSha256(file: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function parsePointer(text: string) {
  if (!text.startsWith("version https://git-lfs.github.com/spec/v1")) return null;
  const oid = /oid sha256:([0-9a-f]{64})/.exec(text)?.[1];
  const size = /size (\d+)/.exec(text)?.[1];
  return oid && size ? { oid, size: Number(size) } : null;
}

async function main() {
  const all = process.argv.includes("--all");
  if (!existsSync(DEST)) {
    console.log(`Cloning ${SOURCE_REPO} into ${DEST}`);
    git(["clone", "--quiet", "--no-checkout", `https://github.com/${SOURCE_REPO}.git`, DEST], undefined);
  }
  try {
    git(["cat-file", "-e", `${SOURCE_COMMIT}^{commit}`], DEST);
  } catch {
    console.log(`Fetching ${SOURCE_COMMIT}`);
    git(["fetch", "--quiet", "origin"], DEST);
  }
  // Never let a local git-lfs smudge filter interfere; we fetch LFS objects ourselves.
  // --force discards materialised LFS files in the work tree; they are restored from the cache below.
  execFileSync("git", ["-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false", "checkout", "--quiet", "--force", SOURCE_COMMIT], {
    cwd: DEST,
    stdio: "inherit",
  });
  const head = git(["rev-parse", "HEAD"], DEST);
  if (head !== SOURCE_COMMIT) throw new Error(`checked out ${head}, expected ${SOURCE_COMMIT}`);
  console.log(`Source repository at ${head}`);

  for (const rel of [...REQUIRED_LFS, ...(all ? OPTIONAL_LFS : [])]) {
    const pointerText = git(["show", `${SOURCE_COMMIT}:${rel}`], DEST);
    const pointer = parsePointer(pointerText);
    if (!pointer) throw new Error(`${rel} is not an LFS pointer at ${SOURCE_COMMIT}`);
    const target = path.join(DEST, rel);
    const cached = path.join(CACHE, pointer.oid);
    if (existsSync(cached) && (await fileSha256(cached)) === pointer.oid) {
      copyFileSync(cached, target);
      console.log(`  ok (cached) ${rel}`);
      continue;
    }
    const url = `https://media.githubusercontent.com/media/${SOURCE_REPO}/${SOURCE_COMMIT}/${rel}`;
    console.log(`  downloading ${rel} (${(pointer.size / 1e6).toFixed(1)} MB)`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed for ${rel}: HTTP ${res.status}`);
    mkdirSync(CACHE, { recursive: true });
    const tmp = `${cached}.download`;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
    const got = await fileSha256(tmp);
    if (got !== pointer.oid) throw new Error(`sha256 mismatch for ${rel}: got ${got}, expected ${pointer.oid}`);
    renameSync(tmp, cached);
    copyFileSync(cached, target);
    console.log(`  ok ${rel} sha256=${got}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
