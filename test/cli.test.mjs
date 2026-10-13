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
const payloadFile = (w) => { const f = join(w, "payload.json"); writeFileSync(f, PAYLOAD); return f; };
const run = (args, input) => spawnSync(process.execPath, [BIN, ...args], { input, encoding: "utf8" });
const PKG = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
const PAYLOAD = JSON.stringify({ filed: [{ path: "/t/a.md", title: "Sync", date: "2026-10-12", meetingKey: "k1" }] });

test("--help and --version", () => {
  assert.match(run(["--help"]).stdout, /context-river run/);
  assert.equal(run(["--version"]).stdout.trim(), PKG.version);
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

// A child whose stdin stays under the test's control. Resolves with how it ended and how long it took.
function runAsync(args, { feed = () => {}, limit = 12000 } = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stdin.on("error", () => {});
  feed(child);
  return new Promise((done) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, limit);
    child.on("close", (code, signal) => { clearTimeout(timer); done({ code, signal, stdout, ms: Date.now() - started }); });
  });
}

test("a payload piped to run without --stdin is never read", () => {
  const w = workspace();
  const r = run(["run", "--workspace", w], PAYLOAD);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /book: 0 published/);
  assert.equal(existsSync(join(w, "sent.log")), false);
});

test("--stdin gives up on a stdin that never closes, says so, and still exits 0", async () => {
  const w = workspace();
  const r = await runAsync(["run", "--workspace", w, "--stdin"], { feed: (child) => { child.stdin.write(PAYLOAD.slice(0, 10)); } });
  assert.equal(r.code, 0);
  assert.ok(r.ms >= 4500 && r.ms < 8000, `took ${r.ms} ms`);
  assert.match(r.stdout, /stdin did not close within 5 seconds, running without a payload/);
  assert.match(r.stdout, /book: 0 published/);
  assert.equal(existsSync(join(w, "sent.log")), false);
});

test("--stdin waits for a payload that arrives late", async () => {
  const w = workspace();
  const r = await runAsync(["run", "--workspace", w, "--stdin"], { feed: (child) => { setTimeout(() => { child.stdin.end(PAYLOAD); }, 200); } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /book: 1 published/);
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
});

test("an unknown flag is a usage error, so a misspelled --dry-run publishes nothing", () => {
  const w = workspace();
  const r = run(["run", "--workspace", w, "--dryrun", "--stdin"], PAYLOAD);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /unknown flag --dryrun/);
  assert.equal(existsSync(join(w, "sent.log")), false);
  assert.equal(run(["run", "--workspace", w, "--dryrun", "--strict", "--stdin"], PAYLOAD).status, 1);
  assert.equal(run(["run", "--workspace", w, "-n", "--stdin"], PAYLOAD).stdout.trim(), "unknown flag -n");
  assert.equal(existsSync(join(w, "sent.log")), false);
  const s = run(["status", "--workspace", w, "--verbose"]);
  assert.equal(s.status, 1);
  assert.match(s.stdout, /unknown flag --verbose/);
  assert.equal(run(["remove", "book", "conversations:k1", "--workspace", w, "--force"]).status, 1);
  assert.match(run(["run", "--workspace", w, "--stdin"], PAYLOAD).stdout, /book: 1 published/); // the remove above wrote nothing
});

test("--flag=value works for the three flags that take one", () => {
  const w = workspace();
  const file = join(w, "payload.json");
  writeFileSync(file, PAYLOAD);
  const r = run(["run", `--workspace=${w}`, `--payload=${file}`, "--outlet=book"]);
  assert.match(r.stdout, /book: 1 published/);
  assert.match(run(["run", "--workspace="]).stdout, /--workspace needs a value/);
  const j = run(["run", `--workspace=${w}`, "--json=yes"]);
  assert.match(j.stdout, /--json takes no value/);
  assert.match(run(["run", `--workspace=${w}`, "--outlet=nobody"]).stdout, /no outlets/);
});

test("the context an outlet sees is { workspace, timeZone, payload, config }, settings under config", () => {
  const w = workspace({ publish: "async (b, ctx) => { (await import('node:fs')).writeFileSync(ctx.workspace + '/ctx.json', JSON.stringify({ keys: Object.keys(ctx).sort(), pair: ctx.config.pair, flat: ctx.pair ?? null, tz: ctx.timeZone, filed: ctx.payload.filed.length, stateDir: ctx.config.stateDir })); }" });
  writeFileSync(join(w, ".agents/river/config.json"), JSON.stringify({ timeZone: "America/Chicago", pair: ["ada", "grace"] }));
  run(["run", "--workspace", w, "--stdin"], PAYLOAD);
  assert.deepEqual(JSON.parse(readFileSync(join(w, "ctx.json"), "utf8")), {
    keys: ["config", "payload", "timeZone", "workspace"], pair: ["ada", "grace"], flat: null, tz: "America/Chicago", filed: 1,
    stateDir: join(w, ".agents/state/context-river"),
  });
});

test("an outlet that leaves a timer running cannot keep the process alive", async () => {
  const w = workspace({ publish: "async () => { setInterval(() => {}, 1000); }" });
  const r = await runAsync(["run", "--workspace", w, "--payload", payloadFile(w)]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /book: 1 published/);
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
});

test("a floating rejection or a late throw from an outlet is one printed line and a failed run, never a crash", () => {
  for (const [publish, line] of [
    ["async () => { Promise.reject(new Error('floating')); }", /unhandled rejection: floating/],
    ["async () => { setTimeout(() => { throw new Error('late'); }, 0); await new Promise((r) => setTimeout(r, 50)); }", /uncaught exception: late/],
  ]) {
    const w = workspace({ publish });
    const soft = run(["run", "--workspace", w, "--payload", payloadFile(w)]);
    assert.equal(soft.status, 0);
    assert.match(soft.stdout, line);
    assert.match(soft.stdout, /book: 1 published/);
    const w2 = workspace({ publish });
    const strict = run(["run", "--workspace", w2, "--strict", "--json", "--payload", payloadFile(w2)]);
    assert.equal(strict.status, 1);
    const out = JSON.parse(strict.stdout); // still one object
    assert.ok(out.notes.some((n) => line.test(n)));
    assert.equal(out.error, null);
  }
});

test("run --json is always one object { reports, problems, notes, error }", () => {
  const w = workspace();
  const ok = JSON.parse(run(["run", "--workspace", w, "--json", "--stdin"], PAYLOAD).stdout);
  assert.deepEqual(Object.keys(ok).sort(), ["error", "notes", "problems", "reports"]);
  assert.equal(ok.error, null);
});

// A state directory that is a regular file: opening receipts throws after the config has loaded.
function brokenState() {
  const w = workspace();
  writeFileSync(join(w, ".agents/river/config.json"), JSON.stringify({ stateDir: "state-file" }));
  writeFileSync(join(w, "state-file"), "not a directory");
  return w;
}

test("a runtime throw under run exits 0 (1 with --strict) and stays one JSON object", () => {
  const w = brokenState();
  const soft = run(["run", "--workspace", w, "--stdin"], PAYLOAD);
  assert.equal(soft.status, 0);
  assert.match(soft.stdout, /context-river stopped: /);
  assert.equal(run(["run", "--workspace", w, "--strict", "--stdin"], PAYLOAD).status, 1);
  const j = run(["run", "--workspace", w, "--json", "--stdin"], "not json");
  assert.equal(j.status, 0);
  const out = JSON.parse(j.stdout);
  assert.deepEqual(Object.keys(out).sort(), ["error", "notes", "problems", "reports"]);
  assert.equal(typeof out.error, "string");
  assert.ok(out.error.length > 0);
  assert.ok(out.notes.some((n) => /payload/.test(n))); // what was known before the stop is kept
  assert.equal(existsSync(join(w, "sent.log")), false);
});

test("a runtime throw under remove or status exits 1, --strict or not", () => {
  const w = brokenState();
  const rm = run(["remove", "book", "conversations:k1", "--workspace", w]);
  assert.equal(rm.status, 1);
  assert.match(rm.stdout, /context-river stopped: /);
  assert.equal(run(["status", "--workspace", w]).status, 1);
  const s = run(["status", "--workspace", w, "--json"]);
  assert.equal(s.status, 1);
  const out = JSON.parse(s.stdout);
  assert.deepEqual({ ...out, error: undefined }, { outlets: [], problems: [], error: undefined });
  assert.ok(out.error.length > 0);
});

test("status --json on a bad config prints { outlets: [], problems: [], error } and exits 1", () => {
  const w = workspace();
  writeFileSync(join(w, ".agents/river/config.json"), "{ nope");
  const s = run(["status", "--workspace", w, "--json"]);
  assert.equal(s.status, 1);
  const out = JSON.parse(s.stdout);
  assert.deepEqual({ ...out, error: undefined }, { outlets: [], problems: [], error: undefined });
  assert.match(out.error, /config/);
});

test("remove refuses a name that is not an outlet name, and a name no loaded outlet has", () => {
  const w = workspace();
  const state = join(w, ".agents/state");
  const escape = run(["remove", "../x", "conversations:k1", "--workspace", w]);
  assert.equal(escape.status, 1);
  assert.match(escape.stdout, /not an outlet name/);
  const ghost = run(["remove", "ghost", "conversations:k1", "--workspace", w]);
  assert.equal(ghost.status, 1);
  assert.match(ghost.stdout, /no outlet named ghost/);
  assert.equal(existsSync(join(state, "x.jsonl")), false);
  assert.equal(existsSync(join(state, "context-river", "ghost.jsonl")), false);
  assert.equal(existsSync(state), false); // nothing at all was written
});

test("status counts pending items", () => {
  const w = workspace({ publish: "async () => { throw new Error('down'); }" });
  run(["run", "--workspace", w, "--stdin"], PAYLOAD);
  const s = JSON.parse(run(["status", "--workspace", w, "--json"]).stdout);
  assert.deepEqual(s.outlets, [{ name: "book", receipts: { pending: 1 } }]);
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
