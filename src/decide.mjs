// The decision is pure: no network, no model, no clock. A refusal is always a sentence,
// because "skipped" with no reason is indistinguishable from "never ran".
const verdict = (answer, name) => {
  if (answer === true) return null;
  if (typeof answer === "string" && answer.trim()) return answer;
  return `${name} refused without a reason`;
};

export function decide(outlet, item, ctx) {
  try {
    const q = verdict(outlet.qualifies(item, ctx), "qualifies");
    if (q) return { ok: false, reason: q };
    for (const gate of outlet.gates) {
      const g = verdict(gate(item, ctx), gate.name || "a gate");
      if (g) return { ok: false, reason: g };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `the decision threw: ${e?.message ?? e}` };
  }
}
