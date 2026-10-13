// One append-only JSONL file per outlet. The destination is the final authority on duplicates
// (an adapter should treat "already there" as success); this file is what keeps a run cheap
// and what remembers a removal so no machine publishes that item again.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function openReceipts(dir, outletName) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${outletName}.jsonl`);
  const last = new Map();
  let endsClean = true;
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    endsClean = text.endsWith("\n") || text === "";
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && e.key) last.set(e.key, e); } catch { /* torn line */ }
    }
  }
  return {
    file,
    status: (key) => last.get(key)?.status ?? null,
    has: (key) => last.get(key)?.status === "published",
    removed: (key) => last.get(key)?.status === "removed",
    keysWithStatus: (status) => [...last.values()].filter((e) => e.status === status).map((e) => e.key).sort(),
    record(key, status, extra = {}) {
      const entry = { ...extra, key, status, at: new Date().toISOString() };
      // A torn last line must not swallow the next record: start on a fresh line first.
      appendFileSync(file, (endsClean ? "" : "\n") + JSON.stringify(entry) + "\n");
      endsClean = true;
      last.set(key, entry);
      return entry;
    },
  };
}
