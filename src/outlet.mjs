// An outlet is one publication point, declared in one file. Everything about a destination
// lives here so that a change to what qualifies is a change to one tested file.
const BUNDLES = ["item", "day"];

export function defineOutlet(spec = {}) {
  const problems = [];
  if (typeof spec.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(spec.name)) problems.push("name must be lowercase letters, digits and dashes");
  if (!Array.isArray(spec.sources) || !spec.sources.length || spec.sources.some((s) => typeof s !== "string")) problems.push("sources must be a non-empty list of source names");
  if (typeof spec.qualifies !== "function") problems.push("qualifies must be a function");
  if (typeof spec.publish !== "function") problems.push("publish must be a function");
  const bundle = spec.bundle ?? "item";
  if (!BUNDLES.includes(bundle)) problems.push(`bundle must be one of ${BUNDLES.join(", ")}`);
  const gates = spec.gates ?? [];
  if (!Array.isArray(gates) || gates.some((g) => typeof g !== "function")) problems.push("gates must be a list of functions");
  if (spec.writer != null && typeof spec.writer !== "function") problems.push("writer must be a function when given");
  if (problems.length) throw new TypeError(`outlet ${spec.name ?? "(unnamed)"}: ${problems.join("; ")}`);
  return Object.freeze({
    name: spec.name, sources: Object.freeze([...spec.sources]), qualifies: spec.qualifies,
    bundle, gates: Object.freeze([...gates]), publish: spec.publish, writer: spec.writer ?? null,
  });
}
