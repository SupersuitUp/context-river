import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOutlet } from "../src/run.mjs";
import { defineOutlet } from "../src/outlet.mjs";
import { openReceipts } from "../src/receipts.mjs";

const receipts = () => openReceipts(mkdtempSync(join(tmpdir(), "river-")), "o");
const src = (...raws) => ({ gather: async () => raws });
const raw = (id, at = "2026-10-12T15:00:00Z", extra = {}) => ({ id, at, ...extra });
const outlet = (over = {}) => defineOutlet({ name: "o", sources: ["s"], qualifies: () => true, publish: async () => {}, ...over });
const ctx = { timeZone: "UTC" };
const NOON_13 = new Date("2026-10-13T12:00:00Z");

test("publishes once, then skips as already published", async () => {
  const r = receipts(); const sent = [];
  const o = outlet({ publish: async (b) => { sent.push(b.key); } });
  const first = await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx });
  assert.deepEqual(first.published, ["s:1"]);
  const second = await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx });
  assert.deepEqual(second.published, []);
  assert.deepEqual(second.skipped, [{ key: "s:1", reason: "already published" }]);
  assert.equal(sent.length, 1);
});

test("a removed item is never published again", async () => {
  const r = receipts(); r.record("s:1", "removed");
  let called = false;
  const rep = await runOutlet(outlet({ publish: async () => { called = true; } }), { sources: { s: src(raw("1")) }, receipts: r, ctx });
  assert.equal(called, false);
  assert.deepEqual(rep.skipped, [{ key: "s:1", reason: "removed" }]);
});

test("a refusal carries its reason and is not receipted", async () => {
  const r = receipts();
  const rep = await runOutlet(outlet({ qualifies: () => "not a founders call" }), { sources: { s: src(raw("1")) }, receipts: r, ctx });
  assert.deepEqual(rep.refused, [{ key: "s:1", reason: "not a founders call" }]);
  assert.equal(r.status("s:1"), null);
});

test("dry run publishes nothing and writes no receipt", async () => {
  const r = receipts(); let called = false;
  const rep = await runOutlet(outlet({ publish: async () => { called = true; } }), { sources: { s: src(raw("1")) }, receipts: r, ctx, dryRun: true });
  assert.equal(called, false);
  assert.equal(r.status("s:1"), null);
  assert.deepEqual(rep.bundles, [{ key: "s:1", items: ["s:1"] }]);
});

test("a failed publish leaves the bundle for the next run", async () => {
  const r = receipts(); let n = 0;
  const o = outlet({ publish: async () => { if (n++ === 0) throw new Error("network down"); } });
  const first = await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx });
  assert.match(first.failed[0].reason, /network down/);
  assert.deepEqual(first.published, []);
  const second = await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx });
  assert.deepEqual(second.published, ["s:1"]);
});

test("a partial publish receipts only what landed", async () => {
  const r = receipts();
  const o = outlet({ bundle: "day", publish: async () => ({ failed: [{ key: "s:2", reason: "too large" }] }) });
  const rep = await runOutlet(o, { sources: { s: src(raw("1"), raw("2")) }, receipts: r, ctx });
  assert.deepEqual(rep.published, ["s:1"]);
  assert.deepEqual(rep.failed, [{ where: "s:2", reason: "too large" }]);
  assert.equal(r.has("s:2"), false);
});

test("a missing source and a throwing source are reported, the rest still runs", async () => {
  const r = receipts();
  const o = outlet({ sources: ["s", "gone", "bad"] });
  const rep = await runOutlet(o, { sources: { s: src(raw("1")), bad: { gather: async () => { throw new Error("locked"); } } }, receipts: r, ctx });
  assert.deepEqual(rep.published, ["s:1"]);
  assert.deepEqual(rep.failed.map((f) => f.where).sort(), ["source bad", "source gone"]);
});

test("a malformed item is reported and does not stop the run", async () => {
  const r = receipts();
  const rep = await runOutlet(outlet(), { sources: { s: src({ at: "2026-10-12" }, raw("1")) }, receipts: r, ctx });
  assert.deepEqual(rep.published, ["s:1"]);
  assert.match(rep.failed[0].reason, /missing id/);
});

test("the writer runs once a changed day is over, and only once", async () => {
  const r = receipts(); const wrote = [];
  const o = outlet({ bundle: "day", writer: async (b) => { wrote.push(b.key); } });
  // Published during the 12th: the day is not over, so no writer yet.
  await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx, now: new Date("2026-10-12T16:00:00Z") });
  assert.deepEqual(wrote, []);
  // Next day, nothing new: the writer is owed for the 12th.
  const rep = await runOutlet(o, { sources: { s: src() }, receipts: r, ctx, now: NOON_13 });
  assert.deepEqual(wrote, ["2026-10-12"]);
  assert.deepEqual(rep.written, ["2026-10-12"]);
  await runOutlet(o, { sources: { s: src() }, receipts: r, ctx, now: NOON_13 });
  assert.deepEqual(wrote, ["2026-10-12"]);
});

test("a late item for a written day makes it due again", async () => {
  const r = receipts(); const wrote = [];
  const o = outlet({ bundle: "day", writer: async (b) => { wrote.push(b.key); } });
  await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx, now: NOON_13 });
  await runOutlet(o, { sources: { s: src(raw("2")) }, receipts: r, ctx, now: NOON_13 });
  assert.deepEqual(wrote, ["2026-10-12", "2026-10-12"]);
});

test("a failing writer is reported and retried next run", async () => {
  const r = receipts(); let n = 0;
  const o = outlet({ bundle: "day", writer: async () => { if (n++ === 0) throw new Error("no session"); } });
  const first = await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx, now: NOON_13 });
  assert.match(first.failed[0].reason, /no session/);
  assert.deepEqual(first.published, ["s:1"]);
  const second = await runOutlet(o, { sources: { s: src() }, receipts: r, ctx, now: NOON_13 });
  assert.deepEqual(second.written, ["2026-10-12"]);
});

test("runOutlet never throws", async () => {
  const rep = await runOutlet(outlet(), { sources: null, receipts: receipts(), ctx });
  assert.ok(rep.failed.length >= 1);
});
