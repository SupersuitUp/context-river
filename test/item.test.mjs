import { test } from "node:test";
import assert from "node:assert/strict";
import { makeItem, itemKey } from "../src/item.mjs";

test("makeItem normalises and freezes", () => {
  const i = makeItem({ source: "conversations", id: 42, at: "2026-10-12T15:00:00-05:00", title: "Sync", people: ["ada"] });
  assert.equal(i.id, "42");
  assert.equal(i.at, "2026-10-12T20:00:00.000Z");
  assert.equal(i.kind, "conversations");
  assert.deepEqual(i.media, []);
  assert.deepEqual(i.data, {});
  assert.throws(() => { i.id = "x"; }, TypeError);
});

test("makeItem names the missing field", () => {
  assert.throws(() => makeItem({ source: "x", at: "2026-10-12" }), /id/);
  assert.throws(() => makeItem({ id: "1", at: "2026-10-12" }), /source/);
  assert.throws(() => makeItem({ source: "x", id: "1" }), /at/);
  assert.throws(() => makeItem({ source: "x", id: "1", at: "not a date" }), /at/);
});

test("itemKey joins source and id", () => {
  assert.equal(itemKey(makeItem({ source: "shipped", id: "abc", at: "2026-10-12" })), "shipped:abc");
});

test("an at that carries a time needs an offset; a date, a Date and a number are fine", () => {
  const base = { source: "x", id: "1" };
  for (const at of ["2026-10-12T15:00:00", "2026-10-12 09:00", "2026-10-12T09:00:00.000", "Oct 12 2026 15:00"]) {
    assert.throws(() => makeItem({ ...base, at }), /offset/, at);
  }
  assert.equal(makeItem({ ...base, at: "2026-10-12" }).at, "2026-10-12T00:00:00.000Z");
  assert.equal(makeItem({ ...base, at: "2026-10-12T15:00:00Z" }).at, "2026-10-12T15:00:00.000Z");
  assert.equal(makeItem({ ...base, at: "2026-10-12T15:00:00+0200" }).at, "2026-10-12T13:00:00.000Z");
  assert.equal(makeItem({ ...base, at: new Date("2026-10-12T15:00:00Z") }).at, "2026-10-12T15:00:00.000Z");
  assert.equal(makeItem({ ...base, at: Date.UTC(2026, 9, 12, 15) }).at, "2026-10-12T15:00:00.000Z");
});

test("a source name follows the outlet-name pattern, and bundle is reserved", () => {
  for (const source of ["Bad Name", "a:b", "-x", "../x"]) {
    assert.throws(() => makeItem({ source, id: "1", at: "2026-10-12" }), /source name/, source);
  }
  assert.throws(() => makeItem({ source: "bundle", id: "2026-10-12", at: "2026-10-12" }), /reserved/);
  assert.equal(makeItem({ source: "camera-roll2", id: "1", at: "2026-10-12" }).source, "camera-roll2");
});
