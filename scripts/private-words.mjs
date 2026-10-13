#!/usr/bin/env node
// A public package names no person, app or workspace. The list of words lives OUTSIDE the
// repo (a file named by PRIVATE_WORDS_FILE, or the words themselves in PRIVATE_WORDS), because
// any copy kept here, hashed or not, would publish the words it forbids.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const SCANNED = ["src", "bin", "test", "scripts", ".github", "README.md", "CHANGELOG.md", "package.json", "MODULE.json"];

const raw = process.env.PRIVATE_WORDS_FILE ? readFileSync(process.env.PRIVATE_WORDS_FILE, "utf8") : process.env.PRIVATE_WORDS ?? "";
const words = [...new Set(raw.split(/[\n,]/).map((w) => w.trim().toLowerCase()).filter(Boolean))];
if (!words.length) {
  // A release must not ship unscanned, so a publish run passes --require.
  if (process.argv.includes("--require")) {
    console.log("private-words: no list, and this run requires one (set the PRIVATE_WORDS secret)");
    process.exit(1);
  }
  console.log("private-words: skipped, no list (set PRIVATE_WORDS_FILE or PRIVATE_WORDS)");
  process.exit(0);
}

const files = execFileSync("git", ["ls-files", "-z", "--", ...SCANNED], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
let hits = 0;
for (const file of files) {
  // A substring match, so a word joined onto another one is still caught. The hit names the
  // place and never the word.
  readFileSync(join(root, file), "utf8").toLowerCase().split("\n").forEach((line, i) => {
    if (words.some((w) => line.includes(w))) { console.log(`${file}:${i + 1} contains a private word`); hits++; }
  });
}
if (hits) process.exit(1);
console.log(`no private words in ${files.length} files`);
