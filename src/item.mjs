// One arrival. Identity is (source, id) and must be stable across runs and machines where
// the source allows it, because receipts are keyed on it.
export const NAME = /^[a-z0-9][a-z0-9-]*$/;

// Outlets and sources share one name pattern. `bundle` is the receipts namespace for day
// markers, so a source by that name could write a key that reads as a marker.
export function sourceNameProblem(name) {
  if (typeof name !== "string" || !NAME.test(name)) return `source name ${JSON.stringify(name)} must be lowercase letters, digits and dashes`;
  if (name === "bundle") return 'source name "bundle" is reserved';
  return null;
}

// A time with no offset is read in the zone of whichever machine parses it, so two machines
// would put the same item on different days. A bare date has no time to disagree about.
const HAS_TIME = /\d:\d\d/;
const HAS_OFFSET = /(Z|GMT|UTC|[+-]\d{2}:?\d{2})$/i;

export function makeItem(raw) {
  if (!raw || typeof raw !== "object") throw new TypeError("item must be an object");
  for (const k of ["source", "id", "at"]) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === "") throw new TypeError(`item is missing ${k}`);
  }
  const named = sourceNameProblem(raw.source);
  if (named) throw new TypeError(named);
  if (typeof raw.at === "string" && HAS_TIME.test(raw.at) && !HAS_OFFSET.test(raw.at.trim())) throw new TypeError(`item has an at with a time and no offset: ${raw.at}`);
  const at = new Date(raw.at);
  if (Number.isNaN(at.getTime())) throw new TypeError(`item has an unreadable at: ${raw.at}`);
  return Object.freeze({
    source: raw.source,
    id: String(raw.id),
    at: at.toISOString(),
    kind: raw.kind ?? raw.source,
    title: raw.title ?? null,
    people: Object.freeze([...(raw.people ?? [])]),
    media: Object.freeze([...(raw.media ?? [])]),
    data: Object.freeze({ ...(raw.data ?? {}) }),
  });
}

export const itemKey = (item) => `${item.source}:${item.id}`;
