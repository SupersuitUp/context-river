import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, loadOutlets, loadSources } from "../src/discover.mjs";
import * as api from "../src/index.mjs";

const ws = () => mkdtempSync(join(tmpdir(), "river-ws-"));
const INDEX = pathToFileURL(join(import.meta.dirname, "..", "src", "index.mjs")).href;

test("defaults when there is no config file", () => {
  const w = ws();
  const c = loadConfig(w);
  assert.equal(c.timeZone, "UTC");
  assert.deepEqual(c.outletDirs, [join(w, ".agents/river/outlets")]);
  assert.equal(c.stateDir, join(w, ".agents/state/context-river"));
});

test("config resolves relative and home paths", () => {
  const w = ws();
  mkdirSync(join(w, ".agents/river"), { recursive: true });
  writeFileSync(join(w, ".agents/river/config.json"), JSON.stringify({ timeZone: "America/Chicago", repos: ["~/code/app", "sibling"], outletDirs: ["~/shared/outlets"] }));
  const c = loadConfig(w);
  assert.equal(c.timeZone, "America/Chicago");
  assert.deepEqual(c.repos, [join(homedir(), "code/app"), join(w, "sibling")]);
  assert.deepEqual(c.outletDirs, [join(homedir(), "shared/outlets")]);
});

test("a secret in config is refused, an env var name is fine", () => {
  const w = ws();
  mkdirSync(join(w, ".agents/river"), { recursive: true });
  writeFileSync(join(w, ".agents/river/config.json"), JSON.stringify({ agentKey: "abc123" }));
  assert.throws(() => loadConfig(w), /never holds a secret/);
  writeFileSync(join(w, ".agents/river/config.json"), JSON.stringify({ agentKeyEnv: "APP_AGENT_KEY" }));
  assert.equal(loadConfig(w).agentKeyEnv, "APP_AGENT_KEY");
});

test("loadOutlets imports valid files and reports the rest", async () => {
  const d = join(ws(), "outlets"); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "good.mjs"), `import { defineOutlet } from ${JSON.stringify(INDEX)};\nexport default defineOutlet({ name: "good", sources: ["s"], qualifies: () => true, publish: async () => {} });\n`);
  writeFileSync(join(d, "_draft.mjs"), "export default 1;");
  writeFileSync(join(d, "bad.mjs"), "export default { name: 'bad' };");
  writeFileSync(join(d, "broken.mjs"), "this is not javascript (");
  const { outlets, problems } = await loadOutlets([d, join(d, "missing")]);
  assert.deepEqual(outlets.map((o) => o.name), ["good"]);
  assert.deepEqual(problems.map((p) => p.file.split("/").pop()).sort(), ["bad.mjs", "broken.mjs"]);
});

test("loadSources accepts an object or a factory", async () => {
  const d = join(ws(), "sources"); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "a.mjs"), "export default { name: 'a', gather: async () => [] };");
  writeFileSync(join(d, "b.mjs"), "export default (config) => ({ name: 'b', gather: async () => [{ id: config.timeZone, at: '2026-10-12' }] });");
  writeFileSync(join(d, "c.mjs"), "export default { name: 'c' };");
  const { sources, problems } = await loadSources([d], { timeZone: "UTC" });
  assert.deepEqual(Object.keys(sources).sort(), ["a", "b"]);
  assert.equal((await sources.b.gather({}))[0].id, "UTC");
  assert.equal(problems.length, 1);
});

test("the public surface is complete", () => {
  for (const name of ["VERSION", "makeItem", "itemKey", "openReceipts", "defineOutlet", "decide", "dayOf", "bundleItems", "runOutlet", "fromPayload", "conversationsSource", "shippedSource", "loadConfig", "loadOutlets", "loadSources"]) {
    assert.ok(name in api, `${name} is exported`);
  }
});

const withConfig = (text) => {
  const w = ws();
  mkdirSync(join(w, ".agents/river"), { recursive: true });
  writeFileSync(join(w, ".agents/river/config.json"), typeof text === "string" ? text : JSON.stringify(text));
  return w;
};

test("harmless keys that merely contain key/token are fine; names ending in a secret word are refused", () => {
  const ok = { keywords: "a, b", tokenizer: "bpe", keyboard: "us", secretary: "x" };
  assert.deepEqual({ ...loadConfig(withConfig(ok)) }.keywords, "a, b");
  for (const k of ["agentKey", "api_key", "TOKEN", "clientSecret", "PASSWORD"]) {
    assert.throws(() => loadConfig(withConfig({ [k]: "abc" })), /never holds a secret/, k);
  }
});

test("a secret nested in an object or array is refused, and the error names the path", () => {
  assert.throws(() => loadConfig(withConfig({ auth: { token: "x" } })), /auth\.token/);
  assert.throws(() => loadConfig(withConfig({ list: [{ deep: { apiKey: "x" } }] })), /list\.0\.deep\.apiKey/);
  assert.equal(loadConfig(withConfig({ auth: { tokenEnv: "T" } })).auth.tokenEnv, "T");
});

test("a malformed config.json throws an error naming the file and the parser's message", () => {
  const w = withConfig("{ not json");
  assert.throws(() => loadConfig(w), (e) => e instanceof Error && !(e instanceof SyntaxError) && e.message.includes(join(w, ".agents/river/config.json")) && /JSON|Expected|position/i.test(e.message));
});

test("a non-array repos, outletDirs or sourceDirs is an error naming the field", () => {
  for (const f of ["repos", "outletDirs", "sourceDirs"]) {
    assert.throws(() => loadConfig(withConfig({ [f]: "some/dir" })), (e) => e instanceof Error && !(e instanceof TypeError) && e.message.includes(f), f);
  }
});

const OUTLET = (name) => `export default { name: ${JSON.stringify(name)}, sources: ["s"], qualifies: () => true, publish: async () => {} };\n`;

test("loadOutlets accepts a plain spec with no import and validates it", async () => {
  const d = join(ws(), "outlets"); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "plain.mjs"), OUTLET("plain"));
  writeFileSync(join(d, "wrong.mjs"), `export default { name: "wrong", sources: ["s"], qualifies: () => true, publish: "later" };\n`);
  writeFileSync(join(d, "number.mjs"), "export default 5;\n");
  const { outlets, problems } = await loadOutlets([d]);
  assert.deepEqual(outlets.map((o) => o.name), ["plain"]);
  assert.ok(Object.isFrozen(outlets[0]));
  assert.equal(outlets[0].bundle, "item");
  assert.match(problems.find((p) => p.file.endsWith("wrong.mjs")).reason, /publish must be a function/);
  assert.ok(problems.some((p) => p.file.endsWith("number.mjs")));
});

test("two outlet files with one name: the first loads, the second is a problem naming both files", async () => {
  const w = ws(); const d1 = join(w, "one"); const d2 = join(w, "two");
  mkdirSync(d1); mkdirSync(d2);
  writeFileSync(join(d1, "a.mjs"), OUTLET("book"));
  writeFileSync(join(d1, "b.mjs"), OUTLET("book"));
  writeFileSync(join(d2, "c.mjs"), OUTLET("book"));
  const { outlets, problems } = await loadOutlets([d1, d2]);
  assert.equal(outlets.length, 1);
  assert.deepEqual(problems.map((p) => p.file), [join(d1, "b.mjs"), join(d2, "c.mjs")]);
  for (const p of problems) assert.ok(p.reason.includes(join(d1, "a.mjs")) && /book/.test(p.reason), p.reason);
});

test("two source files with one name: the first loads, the second is a problem naming both files", async () => {
  const d = join(ws(), "sources"); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "a.mjs"), "export default { name: 'roll', gather: async () => ['first'] };");
  writeFileSync(join(d, "b.mjs"), "export default { name: 'roll', gather: async () => ['second'] };");
  const { sources, problems } = await loadSources([d]);
  assert.deepEqual(await sources.roll.gather({}), ["first"]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, join(d, "b.mjs"));
  assert.ok(problems[0].reason.includes(join(d, "a.mjs")));
});

test("a source file with a malformed or reserved name is a problem", async () => {
  const d = join(ws(), "sources"); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "a.mjs"), "export default { name: 'bundle', gather: async () => [] };");
  writeFileSync(join(d, "b.mjs"), "export default { name: 'Camera Roll', gather: async () => [] };");
  const { sources, problems } = await loadSources([d]);
  assert.deepEqual(Object.keys(sources), []);
  assert.match(problems[0].reason, /reserved/);
  assert.match(problems[1].reason, /source name/);
});
