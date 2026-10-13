import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const BIN = join(import.meta.dirname, "..", "bin", "context-river.mjs");
const INDEX = pathToFileURL(join(import.meta.dirname, "..", "src", "index.mjs")).href;

function workspace({ qualifies = "() => true", publish = "async (b, ctx) => { (await import('node:fs')).appendFileSync(ctx.workspace + '/sent.log', b.key + '\\n'); }" } = {}) {
  const w = mkdtempSync(join(tmpdir(), "river-cli-"));
  mkdirSync(join(w, ".agents/river/outlets"), { recursive: true });
  writeFileSync(join(w, ".agents/river/outlets/book.mjs"),
    `import { defineOutlet } from ${JSON.stringify(INDEX)};\nexport default defineOutlet({ name: "book", sources: ["conversations"], qualifies: ${qualifies}, publish: ${publish} });\n`);
  return w;
}
const run = (args, input) => spawnSync(process.execPath, [BIN, ...args], { input, encoding: "utf8" });
const PAYLOAD = JSON.stringify({ filed: [{ path: "/t/a.md", title: "Sync", date: "2026-10-12", meetingKey: "k1" }] });

test("--help and --version", () => {
  assert.match(run(["--help"]).stdout, /context-river run/);
  assert.match(run(["--version"]).stdout, /^0\.1\.0/);
});

test("run publishes from a piped payload and is idempotent", () => {
  const w = workspace();
  const first = run(["run", "--workspace", w, "--stdin"], PAYLOAD);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /book: 1 published/);
  assert.equal(readFileSync(join(w, "sent.log"), "utf8"), "conversations:k1\n");
  const second = run(["run", "--workspace", w, "--stdin"], PAYLOAD);
  assert.match(second.stdout, /book: 0 published/);
  assert.equal(readFileSync(join(w, "sent.log"), "utf8"), "conversations:k1\n");
});

test("--dry-run publishes nothing", () => {
  const w = workspace();
  const r = run(["run", "--workspace", w, "--dry-run", "--stdin"], PAYLOAD);
  assert.match(r.stdout, /would publish/);
  assert.equal(existsSync(join(w, "sent.log")), false);
});

test("a refusal prints its reason", () => {
  const w = workspace({ qualifies: "() => 'only one founder present'" });
  assert.match(run(["run", "--workspace", w, "--stdin"], PAYLOAD).stdout, /refused conversations:k1: only one founder present/);
});

test("a failing publish exits 0, and 1 with --strict", () => {
  const w = workspace({ publish: "async () => { throw new Error('network down'); }" });
  const soft = run(["run", "--workspace", w, "--stdin"], PAYLOAD);
  assert.equal(soft.status, 0);
  assert.match(soft.stdout, /failed .*network down/);
  assert.equal(run(["run", "--workspace", w, "--strict", "--stdin"], PAYLOAD).status, 1);
});

test("--json prints reports", () => {
  const w = workspace();
  const { reports } = JSON.parse(run(["run", "--workspace", w, "--json", "--stdin"], PAYLOAD).stdout);
  assert.equal(reports[0].outlet, "book");
  assert.deepEqual(reports[0].published, ["conversations:k1"]);
});

test("remove tombstones a key so run skips it", () => {
  const w = workspace();
  assert.equal(run(["remove", "book", "conversations:k1", "--workspace", w]).status, 0);
  assert.match(run(["run", "--workspace", w, "--stdin"], PAYLOAD).stdout, /book: 0 published/);
  assert.equal(existsSync(join(w, "sent.log")), false);
});

test("status lists outlets and counts", () => {
  const w = workspace();
  run(["run", "--workspace", w, "--stdin"], PAYLOAD);
  const s = JSON.parse(run(["status", "--workspace", w, "--json"]).stdout);
  assert.deepEqual(s.outlets, [{ name: "book", receipts: { published: 1 } }]);
});

test("no outlets is a clean, quiet exit", () => {
  const w = mkdtempSync(join(tmpdir(), "river-empty-"));
  const r = run(["run", "--workspace", w, "--stdin"], PAYLOAD);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no outlets/);
});

test("a garbage payload does not crash the run", () => {
  const w = workspace();
  const r = run(["run", "--workspace", w, "--stdin"], "not json");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /payload was not readable/);
});

const runEnv = (args, env, input) => spawnSync(process.execPath, [BIN, ...args], { input, encoding: "utf8", env: { ...process.env, ...env } });

test("run without --stdin returns promptly while stdin is an open pipe", async () => {
  const w = workspace();
  const child = spawn(process.execPath, [BIN, "run", "--workspace", w], { stdio: ["pipe", "pipe", "pipe"] });
  const outcome = await new Promise((done) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); done("hung"); }, 5000);
    child.on("exit", (code) => { clearTimeout(timer); done(code); });
  });
  assert.equal(outcome, 0);
});

test("--payload reads a file, CONTEXT_RIVER_PAYLOAD is the fallback", () => {
  const w = workspace();
  const file = join(w, "payload.json");
  writeFileSync(file, PAYLOAD);
  assert.match(run(["run", "--workspace", w, "--payload", file]).stdout, /book: 1 published/);
  const w2 = workspace();
  assert.match(runEnv(["run", "--workspace", w2], { CONTEXT_RIVER_PAYLOAD: PAYLOAD }).stdout, /book: 1 published/);
});

test("an unreadable payload file adds a note naming the file", () => {
  const w = workspace();
  const r = run(["run", "--workspace", w, "--payload", join(w, "missing.json")]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /missing\.json/);
  assert.match(r.stdout, /book: 0 published/);
});

test("a payload that is not a plain object adds a note", () => {
  for (const bad of ["5", "null", "[1]"]) {
    const w = workspace();
    const r = run(["run", "--workspace", w, "--stdin"], bad);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /payload/, bad);
    assert.match(r.stdout, /book: 0 published/);
  }
});

test("--json carries load problems and notes", () => {
  const w = workspace();
  writeFileSync(join(w, ".agents/river/outlets/broken.mjs"), "throw new Error('boom');\n");
  const r = run(["run", "--workspace", w, "--json", "--stdin"], "not json");
  const out = JSON.parse(r.stdout);
  assert.ok(out.problems.some((p) => /broken\.mjs/.test(p.file) && /boom/.test(p.reason)));
  assert.ok(out.notes.some((n) => /payload/.test(n)));
});

test("a flag with no value is a usage error", () => {
  const w = workspace();
  for (const args of [["--workspace"], ["--outlet", "--json"], ["--payload"]]) {
    const r = run(["run", ...args]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, new RegExp(`${args[0]} needs a value`));
    assert.equal(run(["run", ...args, "--strict"]).status, 1);
  }
  const j = JSON.parse(run(["run", "--workspace", "--json"]).stdout);
  assert.deepEqual({ ...j, error: undefined }, { reports: [], problems: [], notes: [], error: undefined });
  assert.match(j.error, /--workspace needs a value/);
  assert.equal(existsSync(join(w, "sent.log")), false);
});

function badConfig() {
  const w = workspace();
  writeFileSync(join(w, ".agents/river/config.json"), "{ nope");
  return w;
}

test("a malformed config under run exits 0 with a message, 1 with --strict, JSON with error", () => {
  const w = badConfig();
  const soft = run(["run", "--workspace", w]);
  assert.equal(soft.status, 0);
  assert.match(soft.stdout, /context-river stopped: .*config/);
  assert.equal(run(["run", "--workspace", w, "--strict"]).status, 1);
  const j = JSON.parse(run(["run", "--workspace", w, "--json"]).stdout);
  assert.match(j.error, /config/);
  assert.deepEqual(j.reports, []);
});

test("a malformed config makes status and remove exit 1", () => {
  const w = badConfig();
  const s = run(["status", "--workspace", w]);
  assert.equal(s.status, 1);
  assert.match(s.stdout, /config/);
  assert.equal(run(["remove", "book", "k", "--workspace", w]).status, 1);
});

test("an unknown command prints help and exits 1", () => {
  const r = run(["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /context-river run/);
});

test("--outlet runs only the named outlet", () => {
  const w = workspace();
  writeFileSync(join(w, ".agents/river/outlets/other.mjs"),
    `import { defineOutlet } from ${JSON.stringify(INDEX)};\nexport default defineOutlet({ name: "other", sources: ["conversations"], qualifies: () => true, publish: async () => {} });\n`);
  const r = run(["run", "--workspace", w, "--outlet", "other", "--stdin"], PAYLOAD);
  assert.match(r.stdout, /other: 1 published/);
  assert.doesNotMatch(r.stdout, /book:/);
});

test("a workspace source named conversations wins over the built-in", () => {
  const w = workspace();
  mkdirSync(join(w, ".agents/river/sources"), { recursive: true });
  writeFileSync(join(w, ".agents/river/sources/conversations.mjs"),
    `export default { name: "conversations", gather: async () => [{ source: "conversations", id: "custom-1", at: "2026-10-12T10:00:00Z" }] };\n`);
  run(["run", "--workspace", w, "--stdin"], PAYLOAD);
  assert.equal(readFileSync(join(w, "sent.log"), "utf8"), "conversations:custom-1\n");
});

test("status --json stays valid and lists an outlet that failed to load", () => {
  const w = workspace();
  writeFileSync(join(w, ".agents/river/outlets/broken.mjs"), "throw new Error('boom');\n");
  const s = JSON.parse(run(["status", "--workspace", w, "--json"]).stdout);
  assert.ok(s.problems.some((p) => /broken\.mjs/.test(p.file)));
  assert.deepEqual(s.outlets.map((o) => o.name), ["book"]);
});
