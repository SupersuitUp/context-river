import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "private-words.mjs");
const check = (env, args = []) => {
  const clean = { ...process.env };
  delete clean.PRIVATE_WORDS; delete clean.PRIVATE_WORDS_FILE;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...clean, ...env } });
};
// A word this repo is known to contain (the CLI tests use it as an unknown command), standing
// in for a private one. Built at run time so this file adds no second place to keep in step.
const PLANTED = ["frob", "nicate"].join("");
const ABSENT = [["zzqx", "vvkq"].join(""), ["qqzv", "kkxw"].join("")]; // in no file, this one included

test("the private-words check is skipped, visibly, when no list is given", () => {
  const r = check({});
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "private-words: skipped, no list (set PRIVATE_WORDS_FILE or PRIVATE_WORDS)");
});

test("--require turns a missing list into a failure, and a present list is unaffected", () => {
  const r = check({}, ["--require"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), "private-words: no list, and this run requires one (set the PRIVATE_WORDS secret)");
  assert.equal(check({ PRIVATE_WORDS: " , " }, ["--require"]).status, 1);
  const ok = check({ PRIVATE_WORDS: ABSENT[0] }, ["--require"]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^no private words in \d+ files$/m);
});

test("a listed word is found by substring and without regard to case, and the hit never prints it", () => {
  for (const words of [PLANTED, PLANTED.toUpperCase(), `${ABSENT[0]}, ${PLANTED.slice(1, -1)}`, `${ABSENT[0]}\n${PLANTED}`]) {
    const r = check({ PRIVATE_WORDS: words });
    assert.equal(r.status, 1, words);
    assert.match(r.stdout, /^test\/cli\.test\.mjs:\d+ contains a private word$/m);
    assert.ok(!r.stdout.toLowerCase().includes(PLANTED.slice(1, -1)));
  }
});

test("the list can come from a file outside the repo, and a clean repo passes", () => {
  const file = join(mkdtempSync(join(tmpdir(), "river-words-")), "words.txt");
  writeFileSync(file, `${PLANTED}\n`);
  assert.equal(check({ PRIVATE_WORDS_FILE: file }).status, 1);
  writeFileSync(file, `${ABSENT[0]}\n\n${ABSENT[1]}\n`);
  const clean = check({ PRIVATE_WORDS_FILE: file });
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /no private words in \d+ files/);
});

test("no list of words is kept in the repo", () => {
  assert.equal(existsSync(join(ROOT, "scripts", "forbidden.sha256")), false);
});
