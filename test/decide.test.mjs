import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/decide.mjs";
import { defineOutlet } from "../src/outlet.mjs";
import { makeItem } from "../src/item.mjs";

const item = makeItem({ source: "conversations", id: "1", at: "2026-10-12", people: ["ada", "grace"] });
const outlet = (over) => defineOutlet({ name: "o", sources: ["conversations"], qualifies: () => true, publish: async () => {}, ...over });

test("passes when qualifies and every gate return true", () => {
  assert.deepEqual(decide(outlet({ gates: [() => true, () => true] }), item, {}), { ok: true });
});

test("a string from qualifies is the reason", () => {
  assert.deepEqual(decide(outlet({ qualifies: () => "only one founder present" }), item, {}), { ok: false, reason: "only one founder present" });
});

test("the first refusing gate wins and later gates do not run", () => {
  let ran = false;
  const r = decide(outlet({ gates: [() => "a third person was present", () => { ran = true; return true; }] }), item, {});
  assert.equal(r.reason, "a third person was present");
  assert.equal(ran, false);
});

test("a non-true, non-string answer still yields a sentence naming the function", () => {
  function noOutsiders() { return false; }
  assert.match(decide(outlet({ gates: [noOutsiders] }), item, {}).reason, /noOutsiders refused without a reason/);
  assert.match(decide(outlet({ qualifies: () => undefined }), item, {}).reason, /qualifies refused without a reason/);
});

test("a throwing gate refuses, it never escapes", () => {
  const r = decide(outlet({ gates: [() => { throw new Error("boom"); }] }), item, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /boom/);
});

test("ctx reaches qualifies and gates", () => {
  const seen = [];
  decide(outlet({ qualifies: (_i, c) => { seen.push(c.x); return true; }, gates: [(_i, c) => { seen.push(c.x); return true; }] }), item, { x: 7 });
  assert.deepEqual(seen, [7, 7]);
});
