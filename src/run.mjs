// Gather, decide, bundle, publish, receipt. This function is what a hook ends up calling, so
// it never throws: every failure becomes a line in the report, and silence means "ran clean".
import { makeItem, itemKey } from "./item.mjs";
import { decide } from "./decide.mjs";
import { bundleItems, dayOf } from "./bundle.mjs";

const msg = (e) => e?.message ?? String(e);
const BUNDLE = "bundle:";

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

    const fresh = [];
    for (const item of items) {
      const key = itemKey(item);
      if (receipts.removed(key)) { report.skipped.push({ key, reason: "removed" }); continue; }
      if (receipts.has(key)) { report.skipped.push({ key, reason: "already published" }); continue; }
      const d = decide(outlet, item, context);
      if (d.ok) fresh.push(item); else report.refused.push({ key, reason: d.reason });
    }

    for (const bundle of bundleItems(fresh, outlet.bundle, context.timeZone)) {
      const keys = bundle.items.map(itemKey);
      report.bundles.push({ key: bundle.key, items: keys });
      if (dryRun) continue;
      let result;
      try { result = await outlet.publish(bundle, context); } catch (e) { report.failed.push({ where: bundle.key, reason: msg(e) }); continue; }
      const failed = new Map((result?.failed ?? []).map((f) => [f.key, f.reason]));
      let landed = 0;
      for (const key of keys) {
        if (failed.has(key)) { report.failed.push({ where: key, reason: failed.get(key) }); continue; }
        receipts.record(key, "published", { bundle: bundle.key });
        report.published.push(key); landed++;
      }
      if (landed && outlet.writer && outlet.bundle === "day") receipts.record(BUNDLE + bundle.key, "dirty");
    }

    if (!dryRun && outlet.writer && outlet.bundle === "day") {
      const today = dayOf(now, context.timeZone);
      for (const marker of receipts.keysWithStatus("dirty")) {
        if (!marker.startsWith(BUNDLE)) continue;
        const key = marker.slice(BUNDLE.length);
        if (key >= today) continue; // the day is not over
        try { await outlet.writer({ key }, context); receipts.record(marker, "written"); report.written.push(key); }
        catch (e) { report.failed.push({ where: `writer ${key}`, reason: msg(e) }); }
      }
    }
  } catch (e) {
    report.failed.push({ where: "run", reason: msg(e) });
  }
  return report;
}
