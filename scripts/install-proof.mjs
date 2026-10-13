#!/usr/bin/env node
// Pack the package, install the tarball in an empty directory outside this repo, and run it
// the way the README says to. Passing tests prove the parts; this proves it is installable.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const sh = (cmd, args, cwd, input) => execFileSync(cmd, args, { cwd, encoding: "utf8", input });
const tarball = sh("npm", ["pack", "--silent"], root).trim().split("\n").pop();
const dir = mkdtempSync(join(tmpdir(), "river-proof-"));
try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "proof", private: true, type: "module" }));
  sh("npm", ["install", "--silent", join(root, tarball)], dir);
  mkdirSync(join(dir, ".agents/river/outlets"), { recursive: true });
  writeFileSync(join(dir, ".agents/river/outlets/proof.mjs"),
    'import { defineOutlet } from "@supersuit/context-river";\nexport default defineOutlet({ name: "proof", sources: ["conversations"], qualifies: () => true, publish: async () => {} });\n');
  const out = sh(join(dir, "node_modules/.bin/context-river"), ["run", "--stdin", "--workspace", dir],
    dir, JSON.stringify({ filed: [{ path: "/x.md", date: "2026-10-12", meetingKey: "k" }] }));
  if (!/proof: 1 published/.test(out)) throw new Error(`unexpected output from the installed CLI:\n${out}`);
  console.log("installed from the tarball and published one item");
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(root, tarball), { force: true });
}
