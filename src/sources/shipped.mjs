// What was shipped: commits on each declared repo's current branch in a short look-back
// window. Receipts make the overlap between runs harmless, so there is no cursor to corrupt.
import { execFileSync } from "node:child_process";

export const shippedSource = ({ repos = [], days = 3, exec = execFileSync, now = () => new Date() } = {}) => ({
  name: "shipped",
  gather: async () => {
    const since = new Date(now().getTime() - days * 86_400_000).toISOString();
    const out = [];
    for (const repo of repos) {
      let text;
      try { text = String(exec("git", ["-C", repo, "log", `--since=${since}`, "--pretty=%H%x1f%cI%x1f%s"], { encoding: "utf8" })); }
      catch { continue; }
      for (const line of text.split("\n")) {
        const [id, at, title] = line.split("\x1f");
        if (id && at) out.push({ id, at, kind: "commit", title: title ?? "", data: { repo } });
      }
    }
    return out;
  },
});
