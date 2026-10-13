# @supersuit/context-river

The contract between what arrives on a machine and where it gets published.

Calls get recorded, photos get taken, messages come in, work ships. Each place that material
ends up needs the same four things: decide whether an item qualifies, check it is safe to
send, publish it, and remember it was sent. This package is those four things, once.

- A **source** says what arrived.
- An **outlet** is one publication point, declared in one file.
- A **gate** is a pure function that passes an item or refuses it with a sentence.
- A **bundle** is what an outlet publishes in one act: one item, or one day.
- A **receipt** is the record that an item reached an outlet, so it is never sent twice.

Zero dependencies. Node 20.11 or later.

## Install

```bash
npm install @supersuit/context-river
```

## Declare an outlet

`.agents/river/outlets/day-book.mjs` in your workspace:

```js
import { defineOutlet } from "@supersuit/context-river";

const bothPresent = (item, ctx) =>
  ctx.pair.every((p) => item.people.includes(p)) ? true : "both people were not present";

export default defineOutlet({
  name: "day-book",
  sources: ["conversations", "shipped"],
  qualifies: (item, ctx) => (item.source === "shipped" ? true : bothPresent(item, ctx)),
  bundle: "day",
  publish: async (bundle, ctx) => { /* send bundle.items for bundle.key */ },
  writer: async ({ key }, ctx) => { /* write the account of that day */ },
});
```

`qualifies` and every gate return `true` to pass, or a string that says why not. They take
no network and no clock, so each one can be tested, and each refusal is readable.

`publish` receives `{ key, items }`. Throw to leave the whole bundle for the next run, or
return `{ failed: [{ key, reason }] }` to keep the items that did land.

`writer` is optional and only applies to `bundle: "day"`. It is called once a day has ended
and something new was published for it, and again if a late item arrives.

## Settings

`.agents/river/config.json`:

```json
{
  "timeZone": "America/Chicago",
  "repos": ["~/code/app"],
  "outletDirs": ["~/shared/river/outlets"],
  "agentKeyEnv": "APP_AGENT_KEY"
}
```

Settings name environment variables. A value under a key that looks like a credential is
refused at load.

## Run it

```bash
context-river run --dry-run     # say what would be published
context-river run               # publish and keep receipts
context-river status            # outlets, load problems, receipt counts
context-river remove day-book conversations:k1   # never publish this item again
```

`run` feeds the `conversations` source a payload only when you ask for one: `--stdin` reads
it from standard input, `--payload <file>` reads a file, and the `CONTEXT_RIVER_PAYLOAD`
environment variable is the fallback. With none of those, nothing is read.

`run` exits 0 whatever happened, so a hook that calls it can never fail its caller. Every
refusal and failure is printed with its reason. `--strict` exits 1 when anything failed, and
`--json` prints one object, `{ reports, problems, notes }`. Other flags: `--workspace <dir>`
and `--outlet <name>`. `context-river --help` lists them all.

### From a hook

A hook that receives a JSON payload on stdin passes it straight through:

```js
#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
spawnSync("npx", ["--no-install", "context-river", "run", "--stdin"], { input: readFileSync(0), stdio: ["pipe", "inherit", "inherit"] });
```

The built-in `conversations` source reads `filed[]` from that payload, as full records or as
bare file paths. The built-in `shipped` source reads recent commits from `repos`.

## Your own sources

`.agents/river/sources/camera-roll.mjs`:

```js
export default (config) => ({
  name: "camera-roll",
  gather: async (ctx) => [{ id: "library-id", at: "2026-10-12T15:04:00Z", kind: "photo", media: ["/path/to.jpg"] }],
});
```

An item needs `id` and `at`. Its identity is `source:id`, which is what receipts are keyed on,
so pick an id that is the same on every run.

## What it will not do

- Publish an item twice, or publish an item that was removed.
- Skip an item without saying why.
- Fail the process that called it.
- Hold a secret.
