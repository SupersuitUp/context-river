#!/usr/bin/env node
// Break each guard on purpose and confirm the tests notice. A guard that can be removed
// without a red test is a guard nobody is checking.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const MUTATIONS = [
  { file: "src/run.mjs", find: 'if (receipts.removed(key)) { report.skipped.push({ key, reason: "removed" }); continue; }', replace: "", why: "a removed item is never republished" },
  { file: "src/run.mjs", find: 'if (receipts.has(key)) { report.skipped.push({ key, reason: "already published" }); continue; }', replace: "", why: "an item is published once" },
  { file: "src/run.mjs", find: 'if (seen.has(key)) { report.skipped.push({ key, reason: "duplicate in this run" }); continue; }', replace: "", why: "the same key twice in one run is published once" },
  { file: "src/run.mjs", find: "if (!Array.isArray(list) || list.some((f) => typeof f?.key !== \"string\")) {", replace: "if (false) {", why: "a malformed publish result receipts nothing" },
  { file: "src/run.mjs", find: "if (dryRun) continue;", replace: "", why: "a dry run publishes nothing" },
  { file: "src/run.mjs", find: "if (key >= today) continue; // the day is not over", replace: "", why: "the writer waits for the day to end" },
  { file: "src/decide.mjs", find: 'if (g) return { ok: false, reason: g };', replace: "", why: "a refusing gate refuses" },
  { file: "src/decide.mjs", find: "if (answer === true) return null;", replace: "if (answer !== false) return null;", why: "only true passes" },
  { file: "src/bundle.mjs", find: "timeZone, year:", replace: 'timeZone: "UTC", year:', why: "a day is a local day" },
  { file: "src/receipts.mjs", find: '(endsClean ? "" : "\\n")', replace: '""', why: "a record written after a torn line starts on its own line" },
  { file: "src/sources/conversations.mjs", find: "id: entry.meetingKey || entry.path,", replace: "id: entry.meetingKey,", why: "a null meeting key falls back to the path" },
  { file: "src/sources/conversations.mjs", find: "meetingKey: cleanKey(entry.meetingKey)", replace: "meetingKey: entry.meetingKey", why: "a null or ~ meeting key is cleaned to null" },
  { file: "src/discover.mjs", find: "if (SECRETISH.test(k) && !/Env$/.test(k) && typeof v === \"string\" && v) {", replace: "if (false) {", why: "config never holds a secret" },
  { file: "src/discover.mjs", find: "password)$/i", replace: "password)/i", why: "the secret pattern is anchored to the end of the key name" },
];

let survived = 0;
for (const m of MUTATIONS) {
  const path = join(root, m.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(m.find)) { console.log(`STALE  ${m.why}: the guard text was not found in ${m.file}`); survived++; continue; }
  writeFileSync(path, original.replace(m.find, () => m.replace));
  const r = spawnSync("npm", ["test", "--silent"], { cwd: root, encoding: "utf8" });
  writeFileSync(path, original);
  if (r.status === 0) { console.log(`SURVIVED  ${m.why}`); survived++; } else console.log(`caught    ${m.why}`);
}
if (survived) { console.log(`${survived} guard(s) are not protected by a test`); process.exit(1); }
console.log(`all ${MUTATIONS.length} guards are protected`);
