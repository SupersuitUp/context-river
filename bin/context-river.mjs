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

  context-river run     [--workspace <dir>] [--outlet <name>] [--payload <file>] [--stdin]
                        [--dry-run] [--json] [--strict]
  context-river status  [--workspace <dir>] [--json]
  context-river remove  <outlet> <key> [--workspace <dir>]

run     Gather from every source, let each outlet decide, publish, keep receipts.
        A payload feeds the conversations source, and is read only when asked for: from
        --payload <file>, else from stdin with --stdin, else from CONTEXT_RIVER_PAYLOAD.
        --json prints one object: { reports, problems, notes }.
        Exits 0 whatever happened, so a hook that calls it cannot fail its caller.
        --strict exits 1 when anything failed.
status  Outlets found, files that did not load, and receipt counts.
remove  Remember that <key> must never be published to <outlet> again.

Outlets live in <workspace>/.agents/river/outlets/*.mjs, settings in
<workspace>/.agents/river/config.json. Settings name environment variables; they never hold a secret.
`;

const VALUE_FLAGS = ["workspace", "outlet", "payload"];

function parse(argv) {
  const flags = {}; const rest = []; let usage = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && VALUE_FLAGS.includes(a.slice(2))) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { usage ??= `${a} needs a value`; continue; }
      flags[a.slice(2)] = v; i++;
    } else if (a.startsWith("--")) flags[a.slice(2)] = true;
    else rest.push(a);
  }
  return { flags, rest, usage };
}

// A payload is read only when asked for: a file, stdin, or the environment. Reading stdin
// unasked could block a hook forever on a pipe nobody closes.
function readPayload(flags, notes) {
  let text = ""; let from = "CONTEXT_RIVER_PAYLOAD";
  if (flags.payload) {
    from = flags.payload;
    try { text = readFileSync(flags.payload, "utf8"); }
    catch (e) { notes.push(`payload file ${flags.payload} could not be read (${e.message}), running without it`); return null; }
  } else if (flags.stdin) {
    from = "stdin";
    try { text = readFileSync(0, "utf8"); }
    catch (e) { notes.push(`payload on stdin could not be read (${e.message}), running without it`); return null; }
  } else text = process.env.CONTEXT_RIVER_PAYLOAD || "";
  if (!text.trim()) return null;
  let value;
  try { value = JSON.parse(text); } catch { notes.push("payload was not readable JSON, running without it"); return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) { notes.push(`payload from ${from} was not a JSON object, running without it`); return null; }
  return value;
}

function countReceipts(receipts) {
  const counts = {};
  for (const status of ["published", "removed", "dirty", "written"]) {
    const n = receipts.keysWithStatus(status).length;
    if (n) counts[status] = n;
  }
  return counts;
}

// A refusal before any work: `run` stays quiet-exit-0 for a hook (1 with --strict), others exit 1.
function fail(command, flags, message, stopped = false) {
  if (command === "run" && flags.json) console.log(JSON.stringify({ reports: [], problems: [], notes: [], error: message }, null, 2));
  else console.log(command === "run" && stopped ? `context-river stopped: ${message}` : message);
  if (command === "run") return flags.strict ? 1 : 0;
  return 1;
}

async function main() {
  const { flags, rest, usage } = parse(process.argv.slice(2));
  const [command, ...args] = rest;
  if (flags.version) { console.log(VERSION); return 0; }
  if (flags.help || !command) { console.log(HELP); return 0; }
  if (usage) return fail(command, flags, usage);
  const workspace = resolve(flags.workspace || process.cwd());
  let config;
  try { config = loadConfig(workspace); } catch (e) { return fail(command, flags, e?.message ?? String(e), true); }

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
  const payload = readPayload(flags, notes);
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

  if (flags.json) console.log(JSON.stringify({ reports, problems, notes }, null, 2));
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
