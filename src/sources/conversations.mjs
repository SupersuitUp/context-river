// Conversations arrive in a hook payload. Some runners send full records and some send bare
// file paths for the same event, so both are accepted and a bare path is read from its own
// frontmatter. A null meeting key means "could not identify" and never matches another null,
// so identity falls back to the path.
import { readFileSync } from "node:fs";

const front = (text, key) => (text.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, "m")) || [])[1] || null;

function normalise(entry, readFile) {
  if (typeof entry === "string") {
    let text;
    try { text = String(readFile(entry, "utf8")); } catch { return null; }
    entry = { path: entry, title: front(text, "title"), date: front(text, "date"), meetingKey: front(text, "meeting_key") };
  }
  if (!entry || !entry.path) return null;
  const at = entry.start || (entry.date ? `${entry.date}T12:00:00Z` : null);
  if (!at) return null;
  return {
    id: entry.meetingKey || entry.path,
    at,
    title: entry.title ?? null,
    people: entry.participants ?? entry.attendees ?? [],
    data: { path: entry.path, meetingKey: entry.meetingKey ?? null, sources: entry.sources ?? [] },
  };
}

export function fromPayload(payload, { readFile = readFileSync } = {}) {
  return (payload?.filed ?? []).map((e) => normalise(e, readFile)).filter(Boolean);
}

export const conversationsSource = ({ payload, readFile } = {}) => ({
  name: "conversations",
  gather: async () => fromPayload(payload, { readFile }),
});
