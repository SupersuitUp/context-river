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

test("a malformed publish result is reported, receipts nothing from that bundle, and the run continues", async () => {
  for (const bad of [{ failed: "x" }, { failed: [null] }, { failed: [{ reason: "no key" }] }]) {
    const r = receipts(); let n = 0; const wrote = [];
    const o = outlet({ publish: async () => (n++ === 0 ? bad : undefined), writer: async (b) => { wrote.push(b.key); }, bundle: "item" });
    const rep = await runOutlet(o, { sources: { s: src(raw("1"), raw("2")) }, receipts: r, ctx, now: NOON_13 });
    assert.equal(r.has("s:1"), false);
    assert.equal(rep.failed[0].where, "s:1");
    assert.match(rep.failed[0].reason, /malformed/);
    assert.deepEqual(rep.published, ["s:2"]);
  }
});

test("a receipt that cannot be written is a failed line, not an escape", async () => {
  const r = receipts(); const real = r.record;
  r.record = (key, ...rest) => { if (key === "s:1") throw new Error("disk full"); return real(key, ...rest); };
  const rep = await runOutlet(outlet(), { sources: { s: src(raw("1"), raw("2")) }, receipts: r, ctx });
  assert.deepEqual(rep.published, ["s:2"]);
  assert.deepEqual(rep.failed, [{ where: "s:1", reason: "published but the receipt could not be written: disk full" }]);
});

test("a dirty marker or written record that cannot be written is a failed line", async () => {
  const r = receipts(); const real = r.record;
  r.record = (key, status, ...rest) => { if (status === "dirty" || status === "written") throw new Error("disk full"); return real(key, status, ...rest); };
  const o = outlet({ bundle: "day", writer: async () => {} });
  const rep = await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx, now: NOON_13 });
  assert.deepEqual(rep.published, []); // the marker comes before the receipts, so none are written
  assert.deepEqual(rep.failed.map((f) => f.where), ["bundle:2026-10-12"]);
  real("bundle:2026-10-12", "dirty");
  const rep2 = await runOutlet(o, { sources: { s: src() }, receipts: r, ctx, now: NOON_13 });
  assert.deepEqual(rep2.failed.map((f) => f.where), ["bundle:2026-10-12"]);
  assert.match(rep2.failed[0].reason, /disk full/);
  assert.deepEqual(rep2.written, []);
});

test("a day whose marker could not be written is republished, so its writer still runs", async () => {
  const r = receipts(); const real = r.record; let breakMarker = true; const sent = []; const wrote = [];
  r.record = (key, ...rest) => { if (breakMarker && key.startsWith("bundle:")) throw new Error("disk full"); return real(key, ...rest); };
  const o = outlet({ bundle: "day", publish: async (b) => { sent.push(b.key); }, writer: async ({ key }) => { wrote.push(key); } });
  const first = await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx, now: NOON_13 });
  assert.deepEqual(first.published, []);
  assert.equal(r.has("s:1"), false);
  assert.deepEqual(first.failed.map((f) => f.where), ["bundle:2026-10-12"]);
  assert.match(first.failed[0].reason, /published but not receipted/);
  breakMarker = false;
  const second = await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx, now: NOON_13 });
  assert.deepEqual(second.published, ["s:1"]);
  assert.deepEqual(wrote, ["2026-10-12"]);
  assert.deepEqual(second.written, ["2026-10-12"]);
  assert.equal(sent.length, 2); // republished: the destination dedupes
});

test("a malformed publish result sets no day marker", async () => {
  const r = receipts();
  const o = outlet({ bundle: "day", publish: async () => ({ failed: "oops" }), writer: async () => {} });
  await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx, now: NOON_13 });
  assert.deepEqual(r.keysWithStatus("dirty"), []);
});

test("the same key twice in one run is published once", async () => {
  const r = receipts(); const sent = [];
  const o = outlet({ publish: async (b) => { sent.push(...b.items.map((i) => i.id)); } });
  const rep = await runOutlet(o, { sources: { s: src(raw("1"), raw("1")) }, receipts: r, ctx });
  assert.equal(sent.length, 1);
  assert.deepEqual(rep.published, ["s:1"]);
  assert.deepEqual(rep.skipped, [{ key: "s:1", reason: "duplicate in this run" }]);
});

test("runOutlet resolves with a run line when the run itself blows up", async () => {
  const r = receipts(); r.removed = () => { throw new Error("receipts unreadable"); };
  const rep = await runOutlet(outlet(), { sources: { s: src(raw("1")) }, receipts: r, ctx });
  assert.ok(rep.failed.some((f) => f.where === "run" && /receipts unreadable/.test(f.reason)));
});

test("a publish that throws keeps the item pending, and the next run publishes it though its source returns nothing", async () => {
  const r = receipts(); let n = 0; const sent = [];
  const o = outlet({ publish: async (b) => { if (n++ === 0) throw new Error("network down"); sent.push(b.items[0]); } });
  const first = await runOutlet(o, { sources: { s: src(raw("1", "2026-10-12T15:00:00Z", { title: "Sync", people: ["ada"], data: { path: "/a.md" } })) }, receipts: r, ctx });
  assert.deepEqual(first.published, []);
  assert.equal(r.status("s:1"), "pending");
  const reopened = openReceipts(join(r.file, ".."), "o"); // a later process, reading the ledger from disk
  const second = await runOutlet(o, { sources: { s: src() }, receipts: reopened, ctx });
  assert.deepEqual(second.published, ["s:1"]);
  assert.equal(reopened.status("s:1"), "published");
  assert.deepEqual({ ...sent[0] }, { source: "s", id: "1", at: "2026-10-12T15:00:00.000Z", kind: "s", title: "Sync", people: ["ada"], media: [], data: { path: "/a.md" } });
  const third = await runOutlet(o, { sources: { s: src() }, receipts: reopened, ctx });
  assert.deepEqual(third.published, []);
  assert.equal(sent.length, 1);
});

test("an item returned in failed is kept pending with its reason and retried", async () => {
  const r = receipts(); let n = 0;
  const o = outlet({ bundle: "day", publish: async () => (n++ === 0 ? { failed: [{ key: "s:2", reason: "too large" }] } : undefined) });
  await runOutlet(o, { sources: { s: src(raw("1"), raw("2")) }, receipts: r, ctx });
  assert.equal(r.status("s:2"), "pending");
  assert.deepEqual(r.pendingItems().map((i) => i.id), ["2"]);
  const second = await runOutlet(o, { sources: { s: src() }, receipts: r, ctx });
  assert.deepEqual(second.published, ["s:2"]);
  assert.deepEqual(second.bundles, [{ key: "2026-10-12", items: ["s:2"] }]);
});

test("a malformed publish result keeps the bundle's items pending", async () => {
  const r = receipts(); let n = 0;
  const o = outlet({ publish: async () => (n++ === 0 ? { failed: "x" } : undefined) });
  await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx });
  assert.equal(r.status("s:1"), "pending");
  assert.deepEqual((await runOutlet(o, { sources: { s: src() }, receipts: r, ctx })).published, ["s:1"]);
});

test("a freshly gathered copy wins over the pending one, and it is published once", async () => {
  const r = receipts(); let n = 0; const sent = [];
  const o = outlet({ publish: async (b) => { if (n++ === 0) throw new Error("down"); sent.push(...b.items.map((i) => i.title)); } });
  await runOutlet(o, { sources: { s: src(raw("1", undefined, { title: "old" })) }, receipts: r, ctx });
  const second = await runOutlet(o, { sources: { s: src(raw("1", undefined, { title: "new" })) }, receipts: r, ctx });
  assert.deepEqual(sent, ["new"]);
  assert.deepEqual(second.published, ["s:1"]);
  assert.deepEqual(second.skipped, []);
});

test("a pending item that is now refused is recorded refused and not retried", async () => {
  const r = receipts(); let open = true; let calls = 0;
  const o = outlet({ qualifies: () => (open ? true : "the window closed"), publish: async () => { calls++; throw new Error("down"); } });
  await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx });
  open = false;
  const second = await runOutlet(o, { sources: { s: src() }, receipts: r, ctx });
  assert.deepEqual(second.refused, [{ key: "s:1", reason: "the window closed" }]);
  assert.equal(r.status("s:1"), "refused");
  assert.deepEqual(r.pendingItems(), []);
  open = true;
  const third = await runOutlet(o, { sources: { s: src() }, receipts: r, ctx });
  assert.deepEqual(third.bundles, []);
  assert.equal(calls, 1);
});

test("a dry run records nothing about a pending item", async () => {
  const r = receipts(); let open = true;
  const o = outlet({ qualifies: () => (open ? true : "no"), publish: async () => { throw new Error("down"); } });
  await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx });
  const dry = await runOutlet(o, { sources: { s: src() }, receipts: r, ctx, dryRun: true });
  assert.deepEqual(dry.bundles, [{ key: "s:1", items: ["s:1"] }]);
  open = false;
  const refusedDry = await runOutlet(o, { sources: { s: src() }, receipts: r, ctx, dryRun: true });
  assert.deepEqual(refusedDry.refused, [{ key: "s:1", reason: "no" }]);
  assert.equal(r.status("s:1"), "pending");
  const first = await runOutlet(outlet({ publish: async () => { throw new Error("down"); } }), { sources: { s: src(raw("9")) }, receipts: r, ctx, dryRun: true });
  assert.deepEqual(first.failed, []);
  assert.equal(r.status("s:9"), null);
});

test("a removed pending item is not fed back in", async () => {
  const r = receipts(); let calls = 0;
  const o = outlet({ publish: async () => { calls++; throw new Error("down"); } });
  await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx });
  r.record("s:1", "removed");
  const second = await runOutlet(o, { sources: { s: src() }, receipts: r, ctx });
  assert.deepEqual(second.bundles, []);
  assert.equal(calls, 1);
});

test("publish may return removed keys: receipted as removed, skipped with a reason, never published", async () => {
  const r = receipts(); const sent = [];
  const o = outlet({ bundle: "day", publish: async (b) => { sent.push(b.items.map((i) => i.id)); return { removed: ["s:2", "s:elsewhere"] }; }, writer: async () => {} });
  const rep = await runOutlet(o, { sources: { s: src(raw("1"), raw("2")) }, receipts: r, ctx });
  assert.deepEqual(rep.published, ["s:1"]);
  assert.deepEqual(rep.skipped, [{ key: "s:2", reason: "removed by the destination" }]);
  assert.deepEqual(rep.failed, []);
  assert.equal(r.removed("s:2"), true);
  assert.equal(r.status("s:elsewhere"), null);
  const second = await runOutlet(o, { sources: { s: src(raw("1"), raw("2")) }, receipts: r, ctx });
  assert.deepEqual(second.skipped.find((x) => x.key === "s:2"), { key: "s:2", reason: "removed" });
  assert.deepEqual(sent, [["1", "2"]]);
});

test("a key in both removed and failed is removed, and a pending item can be removed by the destination", async () => {
  const r = receipts(); let n = 0;
  const o = outlet({ publish: async () => { if (n++ === 0) throw new Error("down"); return { removed: ["s:1"], failed: [{ key: "s:1", reason: "also this" }] }; } });
  await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: r, ctx });
  const second = await runOutlet(o, { sources: { s: src() }, receipts: r, ctx });
  assert.deepEqual(second.published, []);
  assert.deepEqual(second.failed, []);
  assert.equal(r.removed("s:1"), true);
  assert.deepEqual(r.pendingItems(), []);
});

test("a malformed removed is treated like a malformed failed", async () => {
  for (const bad of [{ removed: "s:1" }, { removed: [null] }, { removed: [{ key: "s:1" }] }]) {
    const r = receipts();
    const rep = await runOutlet(outlet({ publish: async () => bad }), { sources: { s: src(raw("1")) }, receipts: r, ctx });
    assert.match(rep.failed[0].reason, /malformed/);
    assert.deepEqual(rep.published, []);
    assert.equal(r.removed("s:1"), false);
    assert.equal(r.has("s:1"), false);
  }
});

test("a pending receipt that cannot be written is a failed line", async () => {
  const r = receipts(); const real = r.record;
  r.record = (key, status, ...rest) => { if (status === "pending") throw new Error("disk full"); return real(key, status, ...rest); };
  const rep = await runOutlet(outlet({ publish: async () => { throw new Error("down"); } }), { sources: { s: src(raw("1")) }, receipts: r, ctx });
  assert.deepEqual(rep.failed.map((f) => f.where), ["s:1", "s:1"]);
  assert.match(rep.failed[1].reason, /disk full/);
});

test("the context is passed as given, and timeZone defaults to UTC", async () => {
  const seen = [];
  const o = outlet({ qualifies: (item, c) => { seen.push(c); return true; } });
  await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: receipts() });
  await runOutlet(o, { sources: { s: src(raw("1")) }, receipts: receipts(), ctx: { timeZone: "America/Chicago", config: { pair: ["ada"] } } });
  assert.deepEqual(seen, [{ timeZone: "UTC" }, { timeZone: "America/Chicago", config: { pair: ["ada"] } }]);
});
