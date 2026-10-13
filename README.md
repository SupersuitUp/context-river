# @supersuit/context-river

The contract between what arrives on a machine and where it gets published.

Calls get recorded, photos get taken, messages come in, work ships. Each place that material
ends up needs the same four things: decide whether an item qualifies, check it is safe to
send, publish it, and remember it was sent. This package is those four things, once.

- A **source** says what arrived.
- An **outlet** is one publication point, declared in one file.
- A **gate** is a pure function that passes an item or refuses it with a sentence.
- A **bundle** is what an outlet publishes in one act: one item, or one day.
- A **receipt** is the record of what happened to an item at an outlet: published, pending,
  removed or refused.

Zero dependencies. Node 20.11 or later.

## Install

```bash
npm install @supersuit/context-river
```

## Declare an outlet

`.agents/river/outlets/day-book.mjs` in your workspace:

```js
const bothPresent = (item, ctx) =>
  ctx.config.pair.every((p) => item.people.includes(p)) ? true : "both people were not present";

export default {
  name: "day-book",
  sources: ["conversations", "shipped"],
  qualifies: (item, ctx) => (item.source === "shipped" ? true : bothPresent(item, ctx)),
  bundle: "day",
  publish: async (bundle, ctx) => { /* merge bundle.items into the day bundle.key */ },
  writer: async ({ key }, ctx) => { /* write the account of that day */ },
};
```

The default export is a plain object, so the file imports nothing and can sit in a folder two
workspaces share. It is validated when it loads, and a file that fails is listed as a load
problem while the other outlets still run. `defineOutlet` is the optional wrapper that runs
the same validation at import time, which is useful in your own tests:

```js
import { defineOutlet } from "@supersuit/context-river";
export default defineOutlet({ name: "day-book", sources: ["conversations"], qualifies: () => true, publish: async () => {} });
```

An outlet name is lowercase letters, digits and dashes, and so is a source name. One name
belongs to one file: when two outlet files declare the same name, the first loads and the
second is reported as a load problem that names both.

`qualifies` and every gate (`gates: [fn, ...]`) return `true` to pass, or a string that says
why not. They take no network and no clock, so each one can be tested, and each refusal is
readable.

`bundle` is `"item"` (the default, one item per publish) or `"day"` (one local day per
publish, in the `timeZone` from your settings).

`writer` is optional and only applies to `bundle: "day"`. It is called once a day has ended
and something new was published for it, and again if a late item arrives.

## What your adapter must do

`publish(bundle, ctx)` receives `{ key, items }` and is the only code that talks to the
place you publish to. The package can keep its promises only if the adapter keeps these.

- **`publish` is idempotent.** Treat "already there" as success. "An item is published once"
  holds per machine, and per run that did not crash: a crash between publishing and writing
  the receipt publishes the item again on the next run.
- **A day bundle is a delta.** It carries only the items that are new since the last run, and
  it can arrive several times for one day. Merge the items into that day. Never replace the
  day with the bundle.
- **Receipts and removals are per machine.** They live in that machine's state directory. Two
  machines that publish to one place each keep their own, so do not share a state directory
  between them. To refuse an item for everyone, return its key in `removed`.
- **A failed publish is kept as pending and retried on the next run**, even when the source
  never returns the item again. Throw to fail the whole bundle, or return
  `{ failed: [{ key, reason }] }` to fail some items and keep the ones that landed. A pending
  item is decided again when it is retried; if it no longer qualifies, the retries stop.
- **Return `{ removed: [key, ...] }` for an item the place you publish to refuses for good.**
  It is receipted as removed, never published again from this machine, and reported as
  skipped with the reason "removed by the destination".
- **`writer` is idempotent too.** Two overlapping runs can call it twice for the same day. A
  lock is planned for a later version.

`ctx` has four reserved keys, and every function you write receives the same object:

| Key | What it holds |
| --- | --- |
| `workspace` | The absolute path of the workspace. |
| `timeZone` | The zone a day is counted in. `"UTC"` unless your settings say otherwise. |
| `payload` | The hook payload for this run, or `null`. |
| `config` | Everything in your settings file. Your own settings are read as `ctx.config.<name>`. |

## Settings

`.agents/river/config.json`:

```json
{
  "timeZone": "America/Chicago",
  "pair": ["ada", "grace"],
  "repos": ["~/code/app"],
  "outletDirs": [".agents/river/outlets", "~/shared/river/outlets"],
  "agentKeyEnv": "APP_AGENT_KEY"
}
```

`timeZone`, `repos`, `outletDirs`, `sourceDirs` and `stateDir` are read by the package; paths
are relative to the workspace, or start with `~/`. `outletDirs` replaces the default folder,
so list `.agents/river/outlets` when you want it alongside a shared one. Anything else, like
`pair` above, is yours and reaches your code as `ctx.config.pair`.

Settings name environment variables. A value under a key that looks like a credential is
refused at load.

## Run it

```bash
context-river run --dry-run     # say what would be published, record nothing
context-river run               # publish and keep receipts
context-river status            # outlets, load problems, receipt counts
context-river remove day-book conversations:k1   # never publish this item again
```

| Flag | Commands | What it does |
| --- | --- | --- |
| `--workspace <dir>` | all | The workspace to run in. The current directory by default. |
| `--outlet <name>` | `run`, `status` | Only this outlet. |
| `--payload <file>` | `run` | Read the payload from a file. |
| `--stdin` | `run` | Read the payload from standard input. |
| `--dry-run` | `run` | Publish nothing and record nothing. |
| `--json` | `run`, `status` | Print one JSON object. |
| `--strict` | `run` | Exit 1 when anything failed. |
| `--help`, `--version` | | Print the usage, or the version. |

A flag that takes a value accepts `--flag <value>` or `--flag=<value>`. A flag that is not in
this table is a usage error and nothing runs, so a mistyped `--dry-run` never publishes.

`run` feeds the `conversations` source a payload only when you ask for one: `--payload <file>`
reads a file, `--stdin` reads standard input, and the `CONTEXT_RIVER_PAYLOAD` environment
variable is the fallback. With none of those, nothing is read. `--stdin` waits 5 seconds for
standard input to close; after that it prints a note and runs without a payload.

`run` exits 0 whatever happened, so a hook that calls it can never fail its caller. Once
every outlet has returned it exits, even when one of them left a timer or a connection open.
A `publish` that never returns is the one thing it cannot end by itself, which is why the hook
below sets a timeout. Every refusal and failure is printed with its reason. `--strict` exits 1
when anything failed.

`run --json` prints one object, on success and on failure:

```json
{
  "reports": [{
    "outlet": "day-book", "gathered": 2,
    "published": ["conversations:k1"],
    "skipped": [{ "key": "shipped:abc", "reason": "already published" }],
    "refused": [], "failed": [], "written": [],
    "bundles": [{ "key": "2026-10-12", "items": ["conversations:k1"] }]
  }],
  "problems": [],
  "notes": [],
  "error": null
}
```

`problems` lists outlet and source files that did not load, `notes` says what happened to the
payload, and `error` is `null` unless something stopped the run before it finished.

`status` and `remove` are typed by a person, so they exit 1 when they cannot do what was
asked. `remove` needs the name of an outlet that is loaded. `status` counts receipts by what
last happened to each item: `published`, `pending` (a publish failed and will be retried),
`removed`, `refused` (a pending item that stopped qualifying), and for day bundles `dirty`
and `written` (whether the day's `writer` is owed).

### From a hook

A hook that receives a JSON payload on stdin passes it straight through:

```js
#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// The child inherits this hook's stdin, so the payload is never read here. The timeout sits
// under the hook runner's own kill timer and the result is ignored: a hook must neither fail
// nor hang whatever called it.
spawnSync("npx", ["--no-install", "context-river", "run", "--stdin"], { stdio: "inherit", timeout: 90_000 });
```

The built-in `conversations` source reads `filed[]` from that payload, as full records or as
bare file paths, and passes each record through whole as `item.data.record`. The built-in
`shipped` source reads recent commits from `repos`.

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

An `at` with a time needs an offset: `2026-10-12T15:04:00Z` or `2026-10-12T10:04:00-05:00`.
A time with no offset would land on different days on two machines, so it is refused. A bare
date (`2026-10-12`), a `Date` and a number of milliseconds are all fine.

A source name follows the same pattern as an outlet name, and `bundle` is reserved. A source
file named like a built-in source (`conversations`, `shipped`) replaces it. Two of your own
source files with one name are a load problem, like two outlets.

## What it will not do

- Publish an item that was removed, or one that is already receipted as published on this machine.
- Drop an item because its publish failed.
- Skip an item without saying why.
- Fail the process that called it, or stay alive after its outlets have returned.
- Hold a secret.
