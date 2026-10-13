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
