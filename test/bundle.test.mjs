import { test } from "node:test";
import assert from "node:assert/strict";
import { dayOf, bundleItems } from "../src/bundle.mjs";
import { makeItem } from "../src/item.mjs";

test("dayOf uses the declared zone, not UTC", () => {
  // 03:30 UTC on the 13th is 22:30 on the 12th in Chicago.
  assert.equal(dayOf("2026-10-13T03:30:00Z", "America/Chicago"), "2026-10-12");
  assert.equal(dayOf("2026-10-13T03:30:00Z", "UTC"), "2026-10-13");
});

const a = makeItem({ source: "s", id: "a", at: "2026-10-12T15:00:00Z" });
const b = makeItem({ source: "s", id: "b", at: "2026-10-13T03:30:00Z" });
const c = makeItem({ source: "s", id: "c", at: "2026-10-13T18:00:00Z" });

test("day mode groups by local day and sorts", () => {
  const out = bundleItems([c, b, a], "day", "America/Chicago");
  assert.deepEqual(out.map((x) => x.key), ["2026-10-12", "2026-10-13"]);
  assert.deepEqual(out[0].items.map((i) => i.id), ["a", "b"]);
  assert.deepEqual(out[1].items.map((i) => i.id), ["c"]);
});

test("item mode is one bundle per item", () => {
  const out = bundleItems([b, a], "item", "UTC");
  assert.deepEqual(out.map((x) => x.key), ["s:a", "s:b"]);
  assert.equal(out[0].items.length, 1);
});
