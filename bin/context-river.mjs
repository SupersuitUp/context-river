#!/usr/bin/env node
// The only part of the package that touches argv, stdin and the workspace layout. `run` is
// what a hook calls, so it exits 0 whatever happened unless --strict asks otherwise, and it
// always exits: nothing an outlet leaves behind can keep the process alive.
import { resolve } from "node:path";
import {
  VERSION, loadConfig, loadOutlets, loadSources, openReceipts, runOutlet,
  conversationsSource, shippedSource,
} from "../src/index.mjs";
import { NAME } from "../src/item.mjs";
import { parseArgs } from "../src/cli-args.mjs";
import { readPayload } from "../src/payload.mjs";

const HELP = `context-river ${VERSION}

  context-river run     [--workspace <dir>] [--outlet <name>] [--payload <file>] [--stdin]
                        [--dry-run] [--json] [--strict]
  context-river status  [--workspace <dir>] [--outlet <name>] [--json]
  context-river remove  <outlet> <key> [--workspace <dir>]
  context-river --help | --version

run     Gather from every source, let each outlet decide, publish, keep receipts.
        An item whose publish failed is kept as pending and retried on the next run.
        A payload feeds the conversations source, and is read only when asked for: from
        --payload <file>, else from stdin with --stdin, else from CONTEXT_RIVER_PAYLOAD.
        --stdin waits 5 seconds for stdin to close, then runs without a payload.
        --dry-run says what would be published and records nothing.
        --json prints one object: { reports, problems, notes, error }. error is null
        unless something stopped the run.
        Exits 0 whatever happened, so a hook that calls it cannot fail its caller.
        --strict exits 1 when anything failed.
status  Outlets found, files that did not load, and receipt counts. Exits 1 if it cannot read them.
remove  Remember that <key> must never be published to <outlet> again. The outlet must be loaded.

A flag that takes a value accepts --flag <value> or --flag=<value>. An unknown flag is an error.

Outlets live in <workspace>/.agents/river/outlets/*.mjs, settings in
<workspace>/.agents/river/config.json. Settings name environment variables; they never hold a secret.
`;

const msg = (e) => e?.message ?? String(e);
const { flags, rest, usage } = parseArgs(process.argv.slice(2));
const [command, ...args] = rest;
// What `run` has to show so far. Kept out here so a stop halfway still prints what was known.
const out = { reports: [], problems: [], notes: [] };
let stray = false;

// A refusal before the work, or a throw during it. `run` stays exit 0 for a hook (1 with
// --strict); the commands a person types exit 1.
function stop(message, threw) {
  const line = threw ? `context-river stopped: ${message}` : message;
  if (command === "run" && flags.json) console.log(JSON.stringify({ ...out, error: message }, null, 2));
  else if (command === "status" && flags.json) console.log(JSON.stringify({ outlets: [], problems: [], error: message }, null, 2));
  else { for (const n of out.notes) console.log(n); console.log(line); }
  return command === "run" && !flags.strict ? 0 : 1;
}

function countReceipts(receipts) {
  const counts = {};
  for (const status of ["published", "pending", "removed", "refused", "dirty", "written"]) {
    const n = receipts.keysWithStatus(status).length;
    if (n) counts[status] = n;
  }
  return counts;
}

function remove(config, loaded) {
  const [outlet, key] = args;
  if (!outlet || !key) { console.log("usage: context-river remove <outlet> <key>"); return 1; }
  // The name becomes a file name in the state directory, so it is checked before it is used.
  if (!NAME.test(outlet)) { console.log(`${JSON.stringify(outlet)} is not an outlet name: lowercase letters, digits and dashes`); return 1; }
  if (!loaded.outlets.some((o) => o.name === outlet)) {
    console.log(`no outlet named ${outlet} is loaded, nothing was written`);
    for (const p of loaded.problems) console.log(`did not load ${p.file}: ${p.reason}`);
    return 1;
  }
  openReceipts(config.stateDir, outlet).record(key, "removed");
  console.log(`${outlet}: ${key} will not be published again`);
  return 0;
}

function status(config, loaded, outlets) {
  const found = {
    outlets: outlets.map((o) => ({ name: o.name, receipts: countReceipts(openReceipts(config.stateDir, o.name)) })),
    problems: loaded.problems,
  };
  if (flags.json) console.log(JSON.stringify(found, null, 2));
  else {
    for (const o of found.outlets) console.log(`${o.name}: ${JSON.stringify(o.receipts)}`);
    for (const p of found.problems) console.log(`did not load ${p.file}: ${p.reason}`);
    if (!found.outlets.length) console.log("no outlets");
  }
  return 0;
}

async function run(workspace, config, loaded, outlets) {
  const payload = await readPayload(flags, out.notes);
  const custom = await loadSources(config.sourceDirs, config);
  const sources = {
    conversations: conversationsSource({ payload }),
    shipped: shippedSource({ repos: config.repos }),
    ...custom.sources,
  };
  out.problems.push(...loaded.problems, ...custom.problems);
  // Four reserved keys. Settings stay under `config` so a setting can never shadow one of them.
  const ctx = { workspace, timeZone: config.timeZone, payload, config };
  for (const outlet of outlets) {
    out.reports.push(await runOutlet(outlet, { sources, receipts: openReceipts(config.stateDir, outlet.name), ctx, dryRun: Boolean(flags["dry-run"]) }));
  }
  // One turn of the loop, so a rejection an outlet left floating is reported before the output is written.
  await new Promise((turn) => setImmediate(turn));

  if (flags.json) console.log(JSON.stringify({ ...out, error: null }, null, 2));
  else {
    for (const n of out.notes) console.log(n);
    if (!outlets.length) console.log("no outlets");
    for (const r of out.reports) {
      if (flags["dry-run"]) console.log(`${r.outlet}: would publish ${r.bundles.length} bundle(s), ${r.refused.length} refused`);
      else console.log(`${r.outlet}: ${r.published.length} published, ${r.refused.length} refused, ${r.failed.length} failed`);
      for (const x of r.refused) console.log(`  refused ${x.key}: ${x.reason}`);
      for (const x of r.failed) console.log(`  failed ${x.where}: ${x.reason}`);
      for (const k of r.written) console.log(`  wrote the account for ${k}`);
    }
    for (const p of out.problems) console.log(`did not load ${p.file}: ${p.reason}`);
  }
  const anyFailure = stray || out.problems.length || out.reports.some((r) => r.failed.length);
  return flags.strict && anyFailure ? 1 : 0;
}

async function main() {
  if (usage) return stop(usage, false);
  if (flags.version) { console.log(VERSION); return 0; }
  if (flags.help || !command) { console.log(HELP); return 0; }
  if (!["run", "status", "remove"].includes(command)) { console.log(HELP); return 1; }
  const workspace = resolve(flags.workspace || process.cwd());
  const config = loadConfig(workspace);
  const loaded = await loadOutlets(config.outletDirs);
  if (command === "remove") return remove(config, loaded);
  const outlets = loaded.outlets.filter((o) => !flags.outlet || o.name === flags.outlet);
  if (command === "status") return status(config, loaded, outlets);
  return run(workspace, config, loaded, outlets);
}

if (command === "run") {
  // Outlet code runs in this process. Something it left floating becomes one line and a
  // failed run; without these handlers Node would exit non-zero and fail the hook.
  const caught = (what) => (e) => {
    stray = true;
    const line = `context-river: ${what}: ${msg(e)}`;
    if (flags.json) out.notes.push(line); else console.log(line);
  };
  process.on("unhandledRejection", caught("unhandled rejection"));
  process.on("uncaughtException", caught("uncaught exception"));
}

// Exit explicitly once stdout has drained: a timer or a socket an outlet left open would
// otherwise keep the process, and the hook waiting on it, alive.
main().catch((e) => stop(msg(e), true)).then((code) => process.stdout.write("", () => process.exit(code)));
