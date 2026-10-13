// A payload is read only when asked for: a file, stdin, or the environment. Reading stdin
// unasked could block a hook forever on a pipe nobody closes, and even when asked the read
// has a deadline, because the caller is a hook with a kill timer of its own.
import { readFileSync } from "node:fs";

const STDIN_DEADLINE_MS = 5000;

// Never a synchronous read of fd 0: that cannot be given a deadline.
function readStdin(stream, ms) {
  return new Promise((done) => {
    const chunks = [];
    const settle = (answer) => { clearTimeout(timer); stream.removeAllListeners("data"); stream.pause(); done(answer); };
    const timer = setTimeout(() => settle({ timedOut: true }), ms);
    stream.on("data", (c) => chunks.push(c));
    stream.once("end", () => settle({ text: Buffer.concat(chunks).toString("utf8") }));
    stream.once("error", (e) => settle({ error: e }));
  });
}

export async function readPayload(flags, notes, { env = process.env, stdin = process.stdin, deadline = STDIN_DEADLINE_MS } = {}) {
  let text = ""; let from = "CONTEXT_RIVER_PAYLOAD";
  if (flags.payload) {
    from = flags.payload;
    try { text = readFileSync(flags.payload, "utf8"); }
    catch (e) { notes.push(`payload file ${flags.payload} could not be read (${e.message}), running without it`); return null; }
  } else if (flags.stdin) {
    from = "stdin";
    const got = await readStdin(stdin, deadline);
    if (got.timedOut) { notes.push(`stdin did not close within ${deadline / 1000} seconds, running without a payload`); return null; }
    if (got.error) { notes.push(`payload on stdin could not be read (${got.error.message}), running without it`); return null; }
    text = got.text;
  } else text = env.CONTEXT_RIVER_PAYLOAD || "";
  if (!text.trim()) return null;
  let value;
  try { value = JSON.parse(text); } catch { notes.push("payload was not readable JSON, running without it"); return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) { notes.push(`payload from ${from} was not a JSON object, running without it`); return null; }
  return value;
}
