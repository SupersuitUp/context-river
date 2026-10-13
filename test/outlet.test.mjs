import { test } from "node:test";
import assert from "node:assert/strict";
import { defineOutlet } from "../src/outlet.mjs";

const ok = { name: "day-book", sources: ["conversations"], qualifies: () => true, publish: async () => {} };

test("a minimal outlet gets defaults", () => {
  const o = defineOutlet(ok);
  assert.equal(o.bundle, "item");
  assert.deepEqual(o.gates, []);
  assert.equal(o.writer, null);
  assert.throws(() => { o.name = "x"; }, TypeError);
});

test("every problem is reported at once", () => {
  assert.throws(
    () => defineOutlet({ name: "Bad Name", sources: [], bundle: "week", gates: [1] }),
    (e) => /name/.test(e.message) && /sources/.test(e.message) && /qualifies/.test(e.message)
      && /publish/.test(e.message) && /bundle/.test(e.message) && /gates/.test(e.message),
  );
});

test("writer must be a function when given", () => {
  assert.throws(() => defineOutlet({ ...ok, writer: "biographer" }), /writer/);
  assert.equal(typeof defineOutlet({ ...ok, writer: async () => {} }).writer, "function");
});
