import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

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
  const first = run(["run", "--workspace", w], PAYLOAD);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /book: 1 published/);
  assert.equal(readFileSync(join(w, "sent.log"), "utf8"), "conversations:k1\n");
  const second = run(["run", "--workspace", w], PAYLOAD);
  assert.match(second.stdout, /book: 0 published/);
  assert.equal(readFileSync(join(w, "sent.log"), "utf8"), "conversations:k1\n");
});

test("--dry-run publishes nothing", () => {
  const w = workspace();
  const r = run(["run", "--workspace", w, "--dry-run"], PAYLOAD);
  assert.match(r.stdout, /would publish/);
  assert.equal(existsSync(join(w, "sent.log")), false);
});

test("a refusal prints its reason", () => {
  const w = workspace({ qualifies: "() => 'only one founder present'" });
  assert.match(run(["run", "--workspace", w], PAYLOAD).stdout, /refused conversations:k1: only one founder present/);
});

test("a failing publish exits 0, and 1 with --strict", () => {
  const w = workspace({ publish: "async () => { throw new Error('network down'); }" });
  const soft = run(["run", "--workspace", w], PAYLOAD);
  assert.equal(soft.status, 0);
  assert.match(soft.stdout, /failed .*network down/);
  assert.equal(run(["run", "--workspace", w, "--strict"], PAYLOAD).status, 1);
});

test("--json prints reports", () => {
  const w = workspace();
  const reports = JSON.parse(run(["run", "--workspace", w, "--json"], PAYLOAD).stdout);
  assert.equal(reports[0].outlet, "book");
  assert.deepEqual(reports[0].published, ["conversations:k1"]);
});

test("remove tombstones a key so run skips it", () => {
  const w = workspace();
  assert.equal(run(["remove", "book", "conversations:k1", "--workspace", w]).status, 0);
  assert.match(run(["run", "--workspace", w], PAYLOAD).stdout, /book: 0 published/);
  assert.equal(existsSync(join(w, "sent.log")), false);
});

test("status lists outlets and counts", () => {
  const w = workspace();
  run(["run", "--workspace", w], PAYLOAD);
  const s = JSON.parse(run(["status", "--workspace", w, "--json"]).stdout);
  assert.deepEqual(s.outlets, [{ name: "book", receipts: { published: 1 } }]);
});

test("no outlets is a clean, quiet exit", () => {
  const w = mkdtempSync(join(tmpdir(), "river-empty-"));
  const r = run(["run", "--workspace", w], PAYLOAD);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no outlets/);
});

test("a garbage payload does not crash the run", () => {
  const w = workspace();
  const r = run(["run", "--workspace", w], "not json");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /payload was not readable/);
});
