import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReceipts } from "../src/receipts.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "river-"));

test("a recorded key is remembered across opens", () => {
  const dir = tmp();
  openReceipts(dir, "o").record("a:1", "published", { bundle: "2026-10-12" });
  const r = openReceipts(dir, "o");
  assert.equal(r.has("a:1"), true);
  assert.equal(r.has("a:2"), false);
  assert.equal(r.status("a:1"), "published");
});

test("the last line for a key wins, and removed is not has", () => {
  const dir = tmp();
  const r = openReceipts(dir, "o");
  r.record("a:1", "published");
  r.record("a:1", "removed");
  const again = openReceipts(dir, "o");
  assert.equal(again.has("a:1"), false);
  assert.equal(again.removed("a:1"), true);
});

test("a torn last line is skipped, not fatal", () => {
  const dir = tmp();
  const r = openReceipts(dir, "o");
  r.record("a:1", "published");
  appendFileSync(r.file, '{"key":"a:2","sta');
  assert.equal(openReceipts(dir, "o").has("a:1"), true);
});

test("keysWithStatus lists current status only", () => {
  const dir = tmp();
  const r = openReceipts(dir, "o");
  r.record("bundle:2026-10-11", "dirty");
  r.record("bundle:2026-10-12", "dirty");
  r.record("bundle:2026-10-11", "written");
  assert.deepEqual(r.keysWithStatus("dirty"), ["bundle:2026-10-12"]);
});

test("outlets do not share a file", () => {
  const dir = tmp();
  openReceipts(dir, "one").record("a:1", "published");
  assert.equal(openReceipts(dir, "two").has("a:1"), false);
  assert.match(readFileSync(openReceipts(dir, "one").file, "utf8"), /"a:1"/);
});

test("a record written after a torn line is not glued onto it", () => {
  const dir = tmp();
  const r = openReceipts(dir, "o");
  r.record("a:1", "published");
  appendFileSync(r.file, '{"key":"a:2","sta');
  const afterTear = openReceipts(dir, "o");
  afterTear.record("a:3", "published");
  afterTear.record("a:4", "removed");
  const again = openReceipts(dir, "o");
  assert.equal(again.has("a:1"), true);
  assert.equal(again.has("a:3"), true);
  assert.equal(again.removed("a:4"), true);
  assert.equal(again.status("a:2"), null);
});

test("pendingItems lists the stored item of every key whose current status is pending", () => {
  const dir = tmp();
  const r = openReceipts(dir, "o");
  r.record("a:1", "pending", { item: { source: "a", id: "1", at: "2026-10-12T15:00:00.000Z" }, reason: "down" });
  r.record("a:2", "pending", { item: { source: "a", id: "2", at: "2026-10-12T16:00:00.000Z" }, reason: "down" });
  r.record("a:3", "pending", { reason: "no item was stored" });
  r.record("a:2", "published");
  const again = openReceipts(dir, "o");
  assert.deepEqual(again.pendingItems(), [{ source: "a", id: "1", at: "2026-10-12T15:00:00.000Z" }]);
  assert.equal(again.has("a:1"), false);
  assert.deepEqual(again.keysWithStatus("pending"), ["a:1", "a:3"]);
});
