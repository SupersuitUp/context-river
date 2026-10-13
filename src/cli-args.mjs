// The flags are a closed list. A flag nobody declared is a usage error, because the one that
// matters most is a misspelled --dry-run, and ignoring it would publish for real.
const VALUE = ["workspace", "outlet", "payload"];
const SWITCH = ["stdin", "dry-run", "json", "strict", "help", "version"];

// The first problem is the usage error; the rest of the line is still read so that --json
// and --strict shape how the error is reported.
export function parseArgs(argv) {
  const flags = {}; const rest = []; let usage = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-") || a === "-") { rest.push(a); continue; }
    const eq = a.indexOf("=");
    const flag = eq === -1 ? a : a.slice(0, eq);
    const name = flag.startsWith("--") ? flag.slice(2) : null;
    if (VALUE.includes(name)) {
      let v = eq === -1 ? argv[i + 1] : a.slice(eq + 1);
      if (eq === -1 && v !== undefined && !v.startsWith("--")) i++; else if (eq === -1) v = undefined;
      if (!v) { usage ??= `${flag} needs a value`; continue; }
      flags[name] = v;
    } else if (SWITCH.includes(name)) {
      if (eq === -1) flags[name] = true; else usage ??= `${flag} takes no value`;
    } else usage ??= `unknown flag ${flag}`;
  }
  return { flags, rest, usage };
}
