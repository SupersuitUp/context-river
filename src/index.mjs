import { readFileSync } from "node:fs";

// The version is written once, in package.json, which always ships inside the package.
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export { makeItem, itemKey } from "./item.mjs";
export { openReceipts } from "./receipts.mjs";
export { defineOutlet } from "./outlet.mjs";
export { decide } from "./decide.mjs";
export { dayOf, bundleItems } from "./bundle.mjs";
export { runOutlet } from "./run.mjs";
export { fromPayload, conversationsSource } from "./sources/conversations.mjs";
export { shippedSource } from "./sources/shipped.mjs";
export { loadConfig, loadOutlets, loadSources } from "./discover.mjs";
