#!/usr/bin/env node
// Break each guard on purpose and confirm the tests notice. A guard that can be removed
// without a red test is a guard nobody is checking.
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const MUTATIONS = [
  { file: "src/run.mjs", find: 'if (receipts.removed(key)) { report.skipped.push({ key, reason: "removed" }); continue; }', replace: "", why: "a removed item is never republished" },
  { file: "src/run.mjs", find: 'if (receipts.has(key)) { report.skipped.push({ key, reason: "already published" }); continue; }', replace: "", why: "an item is published once" },
  { file: "src/run.mjs", find: 'if (seen.has(key)) { report.skipped.push({ key, reason: "duplicate in this run" }); continue; }', replace: "", why: "the same key twice in one run is published once" },
  { file: "src/run.mjs", find: "if (!Array.isArray(list) || list.some((f) => typeof f?.key !== \"string\") || !Array.isArray(gone) || gone.some((k) => typeof k !== \"string\")) {", replace: "if (false) {", why: "a malformed publish result receipts nothing" },
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
  { file: "src/discover.mjs", find: "if (taken.has(name)) throw new Error(", replace: "if (false) throw new Error(", why: "one name is declared by one file" },
  { file: "src/run.mjs", find: "if (!have.has(itemKey(item))) items.push(item);", replace: "", why: "a pending item is fed back into the next run" },
  { file: "src/run.mjs", find: "for (const item of bundle.items) keepPending(receipts, report, item, msg(e));", replace: "", why: "a publish that throws keeps its items pending" },
  { file: "src/item.mjs", find: "if (name === \"bundle\") return 'source name \"bundle\" is reserved';", replace: "", why: "the source name bundle is reserved" },
  { file: "src/item.mjs", find: "if (typeof raw.at === \"string\" && HAS_TIME.test(raw.at) && !HAS_OFFSET.test(raw.at.trim())) throw", replace: "if (false) throw", why: "an at with a time and no offset is refused" },
  { file: "src/cli-args.mjs", find: "} else usage ??= `unknown flag ${flag}`;", replace: "} else flags[name ?? flag] = true;", why: "an unknown flag is a usage error" },
  { file: "bin/context-river.mjs", find: "if (!loaded.outlets.some((o) => o.name === outlet)) {", replace: "if (false) {", why: "remove needs a loaded outlet of that name" },
];

// A mutant can hang the tests it breaks (a guard against waiting is one of the guards), so each
// run has a deadline, and running out of time counts as the tests noticing.
const TIMEOUT_MS = 60_000;
let mutated = null; // the file currently broken on purpose, and what it said before
let child = null;

function restore() {
  if (mutated) writeFileSync(mutated.path, mutated.original);
  mutated = null;
}
const stopTests = () => { try { if (child) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };

// An interrupted check must not leave a broken guard in the working tree.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopTests(); restore(); process.exit(130); });

// Its own process group, so the deadline takes the test runner's children with it.
function runTests() {
  return new Promise((done) => {
    let late = false;
    child = spawn("npm", ["test", "--silent"], { cwd: root, stdio: "ignore", detached: true });
    const timer = setTimeout(() => { late = true; stopTests(); }, TIMEOUT_MS);
    child.on("error", () => { clearTimeout(timer); child = null; done("error"); });
    child.on("close", (code) => { clearTimeout(timer); child = null; done(late ? "timeout" : code); });
  });
}

let survived = 0;
for (const m of MUTATIONS) {
  const path = join(root, m.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(m.find)) { console.log(`STALE  ${m.why}: the guard text was not found in ${m.file}`); survived++; continue; }
  let outcome;
  try {
    mutated = { path, original };
    writeFileSync(path, original.replace(m.find, () => m.replace));
    outcome = await runTests();
  } finally { restore(); }
  if (outcome === 0 || outcome === "error") { console.log(`SURVIVED  ${m.why}`); survived++; }
  else console.log(`caught    ${m.why}${outcome === "timeout" ? " (the tests ran out of time)" : ""}`);
}
if (survived) { console.log(`${survived} guard(s) are not protected by a test`); process.exit(1); }
console.log(`all ${MUTATIONS.length} guards are protected`);
