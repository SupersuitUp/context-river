// One arrival. Identity is (source, id) and must be stable across runs and machines where
// the source allows it, because receipts are keyed on it.
export function makeItem(raw) {
  if (!raw || typeof raw !== "object") throw new TypeError("item must be an object");
  for (const k of ["source", "id", "at"]) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === "") throw new TypeError(`item is missing ${k}`);
  }
  const at = new Date(raw.at);
  if (Number.isNaN(at.getTime())) throw new TypeError(`item has an unreadable at: ${raw.at}`);
  return Object.freeze({
    source: String(raw.source),
    id: String(raw.id),
    at: at.toISOString(),
    kind: raw.kind ?? String(raw.source),
    title: raw.title ?? null,
    people: Object.freeze([...(raw.people ?? [])]),
    media: Object.freeze([...(raw.media ?? [])]),
    data: Object.freeze({ ...(raw.data ?? {}) }),
  });
}

export const itemKey = (item) => `${item.source}:${item.id}`;
