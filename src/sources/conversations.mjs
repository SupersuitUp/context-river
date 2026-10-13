// Conversations arrive in a hook payload. Some runners send full records and some send bare
// file paths for the same event, so both are accepted and a bare path is read from its own
// frontmatter. A null meeting key means "could not identify" and never matches another null,
// so identity falls back to the path.
import { readFileSync } from "node:fs";

// Only the leading --- block counts: a "date:" line in the body is prose, not metadata.
const block = (text) => (text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/) || [])[1] ?? null;

// One value from the block. [ \t] rather than \s so an empty value cannot swallow the next line.
function front(text, key) {
  const inner = block(text);
  if (inner === null) return null;
  const m = inner.match(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m"));
  const v = (m?.[1] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  return v === "" ? null : v;
}

// "null" and "~" are how YAML writes nothing; they identify no meeting.
const NULLISH = new Set(["", "null", "~"]);
const cleanKey = (k) => (k == null || NULLISH.has(String(k).trim()) ? null : String(k));

// A date-only value gets the noon fallback. A time with no offset is read as its written day
// at noon too: the written date is the local day, and the day is what a bundle needs, while an
// offset-less time of day cannot be placed. A value with an offset is kept as written.
function instant(date) {
  if (!date) return null;
  const day = date.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(day);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date}T12:00:00Z`;
  if (/\d:\d\d/.test(date) && !/(Z|GMT|UTC|[+-]\d{2}:?\d{2})$/i.test(date.trim())) return validDay ? `${day}T12:00:00Z` : null;
  return Number.isNaN(new Date(date).getTime()) ? null : date;
}

function normalise(entry, readFile) {
  if (typeof entry === "string") {
    let text;
    try { text = String(readFile(entry, "utf8")); } catch { return null; }
    entry = { path: entry, title: front(text, "title"), date: front(text, "date"), meetingKey: front(text, "meeting_key") };
  }
  if (!entry || !entry.path) return null;
  const record = entry; // as filed, so an outlet can read fields this source knows nothing about
  entry = { ...entry, meetingKey: cleanKey(entry.meetingKey) };
  const at = instant(entry.start || entry.date);
  if (!at) return null;
  return {
    id: entry.meetingKey || entry.path,
    at,
    title: entry.title ?? null,
    people: entry.participants ?? entry.attendees ?? [],
    data: { path: entry.path, meetingKey: entry.meetingKey ?? null, sources: entry.sources ?? [], record },
  };
}

export function fromPayload(payload, { readFile = readFileSync } = {}) {
  return (payload?.filed ?? []).map((e) => normalise(e, readFile)).filter(Boolean);
}

export const conversationsSource = ({ payload, readFile } = {}) => ({
  name: "conversations",
  gather: async () => fromPayload(payload, { readFile }),
});
