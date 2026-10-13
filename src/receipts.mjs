// One append-only JSONL file per outlet. The destination is the final authority on duplicates
// (an adapter should treat "already there" as success); this file is what keeps a run cheap
// and what remembers a removal so no machine publishes that item again.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function openReceipts(dir, outletName) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${outletName}.jsonl`);
  const last = new Map();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
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
      appendFileSync(file, JSON.stringify(entry) + "\n");
      last.set(key, entry);
      return entry;
    },
  };
}
