// Where outlets, sources and settings live. Outlet files are code and can sit in a repo two
// operators share; the config beside them names things and never holds a credential.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const SECRETISH = /key|token|secret|password/i;
const place = (workspace, p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : join(workspace, p));

export function loadConfig(workspace) {
  const file = join(workspace, ".agents/river/config.json");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  for (const [k, v] of Object.entries(raw)) {
    if (SECRETISH.test(k) && !/Env$/.test(k) && typeof v === "string" && v) {
      throw new Error(`config never holds a secret: move ${k} to the environment and name the variable in ${k}Env`);
    }
  }
  const dirs = (list, fallback) => (Array.isArray(list) && list.length ? list : [fallback]).map((p) => place(workspace, p));
  return {
    ...raw,
    timeZone: raw.timeZone ?? "UTC",
    repos: (raw.repos ?? []).map((p) => place(workspace, p)),
    outletDirs: dirs(raw.outletDirs, ".agents/river/outlets"),
    sourceDirs: dirs(raw.sourceDirs, ".agents/river/sources"),
    stateDir: place(workspace, raw.stateDir ?? ".agents/state/context-river"),
  };
}

async function each(dirs, take) {
  const problems = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".mjs") || name.startsWith("_") || name.startsWith(".")) continue;
      const file = join(dir, name);
      try { take((await import(pathToFileURL(file).href)).default, file); }
      catch (e) { problems.push({ file, reason: e?.message ?? String(e) }); }
    }
  }
  return problems;
}

const isOutlet = (o) => o && typeof o.name === "string" && typeof o.qualifies === "function" && typeof o.publish === "function" && Array.isArray(o.sources) && Object.isFrozen(o);

export async function loadOutlets(dirs) {
  const outlets = [];
  const problems = await each(dirs, (value) => {
    if (!isOutlet(value)) throw new Error("the default export is not a defineOutlet result");
    outlets.push(value);
  });
  return { outlets, problems };
}

export async function loadSources(dirs, config = {}) {
  const sources = {};
  const problems = await each(dirs, (value) => {
    const source = typeof value === "function" ? value(config) : value;
    if (!source || typeof source.name !== "string" || typeof source.gather !== "function") throw new Error("the default export is not { name, gather }");
    sources[source.name] = source;
  });
  return { sources, problems };
}
