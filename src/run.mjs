// Gather, decide, bundle, publish, receipt. This function is what a hook ends up calling, so
// it never throws: every failure becomes a line in the report, and silence means "ran clean".
import { makeItem, itemKey } from "./item.mjs";
import { decide } from "./decide.mjs";
import { bundleItems, dayOf } from "./bundle.mjs";

const msg = (e) => e?.message ?? String(e);
const BUNDLE = "bundle:";

// A receipt that cannot be written must not abandon the rest of the run: say so and carry on.
// Returns true when the record landed.
function tryRecord(receipts, report, where, ...args) {
  try { receipts.record(...args); return true; }
  catch (e) { report.failed.push({ where, reason: `published but the receipt could not be written: ${msg(e)}` }); return false; }
}

// Same care for the day markers. The dirty marker is written BEFORE a bundle's items are
// receipted, so a failure here leaves those items un-receipted and the next run republishes
// them and tries the marker again; the written marker is retried because it stays dirty.
function tryMarker(receipts, report, marker, status, note = "") {
  try { receipts.record(marker, status); return true; }
  catch (e) { report.failed.push({ where: marker, reason: `the ${status} marker could not be written: ${msg(e)}${note}` }); return false; }
}

// A publish that failed must survive a source that will not return the item again (a hook
// payload arrives once), so the item itself goes into the ledger and the next run feeds it back in.
function keepPending(receipts, report, item, reason) {
  try { receipts.record(itemKey(item), "pending", { item, reason }); }
  catch (e) { report.failed.push({ where: itemKey(item), reason: `failed and could not be kept for the next run: ${msg(e)}` }); }
}

export async function runOutlet(outlet, { sources, receipts, ctx = {}, dryRun = false, now = new Date() } = {}) {
  const report = { outlet: outlet.name, gathered: 0, published: [], skipped: [], refused: [], failed: [], written: [], bundles: [] };
  const context = { timeZone: "UTC", ...ctx };
  try {
    const items = [];
    for (const name of outlet.sources) {
      const source = sources?.[name];
      if (!source || typeof source.gather !== "function") { report.failed.push({ where: `source ${name}`, reason: "no such source" }); continue; }
      let raws;
      try { raws = (await source.gather(context)) ?? []; } catch (e) { report.failed.push({ where: `source ${name}`, reason: msg(e) }); continue; }
      for (const raw of raws) {
        try { items.push(makeItem({ ...raw, source: name })); } catch (e) { report.failed.push({ where: `source ${name}`, reason: msg(e) }); }
      }
    }
    report.gathered = items.length;

    // Items left pending by an earlier run join this one; a fresh copy from a source wins.
    const have = new Set(items.map(itemKey));
    for (const raw of receipts.pendingItems()) {
      try { const item = makeItem(raw); if (!have.has(itemKey(item))) items.push(item); }
      catch (e) { report.failed.push({ where: "pending", reason: msg(e) }); }
    }

    const fresh = [];
    const seen = new Set(); // one key is published once per run, however many sources return it
    for (const item of items) {
      const key = itemKey(item);
      if (seen.has(key)) { report.skipped.push({ key, reason: "duplicate in this run" }); continue; }
      seen.add(key);
      if (receipts.removed(key)) { report.skipped.push({ key, reason: "removed" }); continue; }
      if (receipts.has(key)) { report.skipped.push({ key, reason: "already published" }); continue; }
      const d = decide(outlet, item, context);
      if (d.ok) { fresh.push(item); continue; }
      report.refused.push({ key, reason: d.reason });
      // A pending item that no longer qualifies stops being retried.
      if (!dryRun && receipts.status(key) === "pending") {
        try { receipts.record(key, "refused", { reason: d.reason }); }
        catch (e) { report.failed.push({ where: key, reason: `the refusal could not be recorded: ${msg(e)}` }); }
      }
    }

    for (const bundle of bundleItems(fresh, outlet.bundle, context.timeZone)) {
      const keys = bundle.items.map(itemKey);
      report.bundles.push({ key: bundle.key, items: keys });
      if (dryRun) continue;
      let result;
      try { result = await outlet.publish(bundle, context); }
      catch (e) {
        report.failed.push({ where: bundle.key, reason: msg(e) });
        for (const item of bundle.items) keepPending(receipts, report, item, msg(e));
        continue;
      }
      // An adapter that answers in the wrong shape leaves us unable to know what landed, so
      // nothing is receipted as published: the items stay pending and the destination dedupes.
      const list = result?.failed ?? [];
      const gone = result?.removed ?? [];
      if (!Array.isArray(list) || list.some((f) => typeof f?.key !== "string") || !Array.isArray(gone) || gone.some((k) => typeof k !== "string")) {
        const reason = "the publish adapter returned a malformed result";
        report.failed.push({ where: bundle.key, reason });
        for (const item of bundle.items) keepPending(receipts, report, item, reason);
        continue;
      }
      // A destination can refuse an item for good; that outranks a failure reported for the same key.
      const removed = new Set(gone);
      const failed = new Map(list.filter((f) => !removed.has(f.key)).map((f) => [f.key, f.reason]));
      const landing = keys.filter((key) => !failed.has(key) && !removed.has(key));
      for (const item of bundle.items) {
        const key = itemKey(item);
        if (failed.has(key)) { report.failed.push({ where: key, reason: failed.get(key) }); keepPending(receipts, report, item, failed.get(key)); }
        if (!removed.has(key)) continue;
        try { receipts.record(key, "removed", { by: "destination" }); report.skipped.push({ key, reason: "removed by the destination" }); }
        catch (e) { report.failed.push({ where: key, reason: `the removal could not be recorded: ${msg(e)}` }); }
      }
      // The marker comes first: receipting without it would make the next run skip these items
      // as published and the day's writer would never be told the day changed.
      if (landing.length && outlet.writer && outlet.bundle === "day"
        && !tryMarker(receipts, report, BUNDLE + bundle.key, "dirty", "; the items were published but not receipted and will be retried next run")) continue;
      for (const key of landing) {
        if (tryRecord(receipts, report, key, key, "published", { bundle: bundle.key })) report.published.push(key);
      }
    }

    if (!dryRun && outlet.writer && outlet.bundle === "day") {
      const today = dayOf(now, context.timeZone);
      for (const marker of receipts.keysWithStatus("dirty")) {
        if (!marker.startsWith(BUNDLE)) continue;
        const key = marker.slice(BUNDLE.length);
        if (key >= today) continue; // the day is not over
        try { await outlet.writer({ key }, context); }
        catch (e) { report.failed.push({ where: `writer ${key}`, reason: msg(e) }); continue; }
        if (tryMarker(receipts, report, marker, "written")) report.written.push(key);
      }
    }
  } catch (e) {
    report.failed.push({ where: "run", reason: msg(e) });
  }
  return report;
}
