#!/usr/bin/env node
// The only part of the package that touches argv, stdin and the workspace layout. `run` is
// what a hook calls, so it exits 0 whatever happened unless --strict asks otherwise.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VERSION, loadConfig, loadOutlets, loadSources, openReceipts, runOutlet,
  conversationsSource, shippedSource,
} from "../src/index.mjs";

const HELP = `context-river ${VERSION}

  context-river run     [--workspace <dir>] [--outlet <name>] [--dry-run] [--json] [--strict]
  context-river status  [--workspace <dir>] [--json]
  context-river remove  <outlet> <key> [--workspace <dir>]

run     Gather from every source, let each outlet decide, publish, keep receipts.
        A payload piped on stdin (or in CONTEXT_RIVER_PAYLOAD) feeds the conversations source.
        Exits 0 whatever happened, so a hook that calls it cannot fail its caller.
        --strict exits 1 when anything failed.
status  Outlets found, files that did not load, and receipt counts.
remove  Remember that <key> must never be published to <outlet> again.

Outlets live in <workspace>/.agents/river/outlets/*.mjs, settings in
<workspace>/.agents/river/config.json. Settings name environment variables; they never hold a secret.
`;

function parse(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace" || a === "--outlet") flags[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) flags[a.slice(2)] = true;
    else rest.push(a);
  }
  return { flags, rest };
}

function readPayload(notes) {
  let text = process.env.CONTEXT_RIVER_PAYLOAD || "";
  if (!process.stdin.isTTY) { try { text = readFileSync(0, "utf8") || text; } catch { /* no stdin */ } }
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { notes.push("payload was not readable JSON, running without it"); return null; }
}

function countReceipts(receipts) {
  const counts = {};
  for (const status of ["published", "removed", "dirty", "written"]) {
    const n = receipts.keysWithStatus(status).length;
    if (n) counts[status] = n;
  }
  return counts;
}

async function main() {
  const { flags, rest } = parse(process.argv.slice(2));
  const [command, ...args] = rest;
  if (flags.version) { console.log(VERSION); return 0; }
  if (flags.help || !command) { console.log(HELP); return 0; }
  const workspace = resolve(flags.workspace || process.cwd());
  const config = loadConfig(workspace);

  if (command === "remove") {
    const [outlet, key] = args;
    if (!outlet || !key) { console.log("usage: context-river remove <outlet> <key>"); return 1; }
    openReceipts(config.stateDir, outlet).record(key, "removed");
    console.log(`${outlet}: ${key} will not be published again`);
    return 0;
  }

  const loaded = await loadOutlets(config.outletDirs);
  const outlets = loaded.outlets.filter((o) => !flags.outlet || o.name === flags.outlet);

  if (command === "status") {
    const status = {
      outlets: outlets.map((o) => ({ name: o.name, receipts: countReceipts(openReceipts(config.stateDir, o.name)) })),
      problems: loaded.problems,
    };
    if (flags.json) console.log(JSON.stringify(status, null, 2));
    else {
      for (const o of status.outlets) console.log(`${o.name}: ${JSON.stringify(o.receipts)}`);
      for (const p of status.problems) console.log(`did not load ${p.file}: ${p.reason}`);
      if (!status.outlets.length) console.log("no outlets");
    }
    return 0;
  }

  if (command !== "run") { console.log(HELP); return 1; }

  const notes = [];
  const payload = readPayload(notes);
  const custom = await loadSources(config.sourceDirs, config);
  const sources = {
    conversations: conversationsSource({ payload }),
    shipped: shippedSource({ repos: config.repos }),
    ...custom.sources,
  };
  const problems = [...loaded.problems, ...custom.problems];
  const ctx = { ...config, workspace, payload };
  const reports = [];
  for (const outlet of outlets) {
    reports.push(await runOutlet(outlet, { sources, receipts: openReceipts(config.stateDir, outlet.name), ctx, dryRun: Boolean(flags["dry-run"]) }));
  }

  if (flags.json) console.log(JSON.stringify(reports, null, 2));
  else {
    for (const n of notes) console.log(n);
    if (!outlets.length) console.log("no outlets");
    for (const r of reports) {
      if (flags["dry-run"]) console.log(`${r.outlet}: would publish ${r.bundles.length} bundle(s), ${r.refused.length} refused`);
      else console.log(`${r.outlet}: ${r.published.length} published, ${r.refused.length} refused, ${r.failed.length} failed`);
      for (const x of r.refused) console.log(`  refused ${x.key}: ${x.reason}`);
      for (const x of r.failed) console.log(`  failed ${x.where}: ${x.reason}`);
      for (const k of r.written) console.log(`  wrote the account for ${k}`);
    }
    for (const p of problems) console.log(`did not load ${p.file}: ${p.reason}`);
  }
  const anyFailure = problems.length || reports.some((r) => r.failed.length);
  return flags.strict && anyFailure ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  console.log(`context-river stopped: ${e?.message ?? e}`);
  process.exitCode = process.argv.includes("--strict") ? 1 : 0;
});
