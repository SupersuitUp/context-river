// A bundle is what an outlet publishes in one act. A day is a LOCAL day in a zone the
// consumer declares once, so two machines in different places agree on which day it was.
import { itemKey } from "./item.mjs";

export function dayOf(when, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(when));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function bundleItems(items, mode, timeZone) {
  const groups = new Map();
  for (const item of items) {
    const key = mode === "day" ? dayOf(item.at, timeZone) : itemKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([key, list]) => ({ key, items: list.sort((x, y) => x.at.localeCompare(y.at)) }));
}
