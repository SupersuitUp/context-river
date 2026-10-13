# Changelog

## 0.1.0

First release. Sources say what arrived; an outlet declares one publication point as a plain
object with a pure `qualifies` and pure gates; `runOutlet` gathers, decides, bundles by item
or by local day, publishes through the outlet's adapter, and keeps an append-only receipt per
outlet. A failed publish is kept as pending and retried on the next run, and an adapter can
return `removed` keys for items that are refused for good.

The `context-river` CLI has `run`, `status` and `remove`. `run` reads a payload only when
asked (`--payload <file>`, `--stdin` with a 5 second deadline, or `CONTEXT_RIVER_PAYLOAD`),
refuses unknown flags, prints one `{ reports, problems, notes, error }` object under `--json`,
and exits 0 unless `--strict`, so a hook that calls it cannot fail its caller.
