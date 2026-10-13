import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPayload, conversationsSource } from "../src/sources/conversations.mjs";
import { shippedSource } from "../src/sources/shipped.mjs";

test("object entries become raw items keyed on the meeting key", () => {
  const out = fromPayload({ filed: [{ path: "/w/t/a.md", title: "Sync", date: "2026-10-12", meetingKey: "k1", attendees: ["Ada", "Grace"], participants: ["ada", "grace"], sources: [{ type: "meet_cloud" }] }] });
  assert.deepEqual(out, [{ id: "k1", at: "2026-10-12T12:00:00Z", title: "Sync", people: ["ada", "grace"], data: { path: "/w/t/a.md", meetingKey: "k1", sources: [{ type: "meet_cloud" }] } }]);
});

test("a null meeting key falls back to the path, never to a shared null", () => {
  const out = fromPayload({ filed: [{ path: "/w/t/a.md", date: "2026-10-12", meetingKey: null }, { path: "/w/t/b.md", date: "2026-10-12", meetingKey: null }] });
  assert.deepEqual(out.map((r) => r.id), ["/w/t/a.md", "/w/t/b.md"]);
});

test("bare path strings are read from frontmatter", () => {
  const readFile = () => '---\ntitle: "Planning"\ndate: "2026-10-11"\n---\nbody';
  const out = fromPayload({ filed: ["/w/t/c.md"] }, { readFile });
  assert.equal(out[0].id, "/w/t/c.md");
  assert.equal(out[0].title, "Planning");
  assert.equal(out[0].at, "2026-10-11T12:00:00Z");
});

test("an unreadable or dateless entry is dropped, the rest survive", () => {
  const readFile = (p) => { if (p.endsWith("gone.md")) throw new Error("ENOENT"); return "---\ntitle: x\n---"; };
  const out = fromPayload({ filed: ["/w/gone.md", "/w/nodate.md", { path: "/w/ok.md", date: "2026-10-12" }] }, { readFile });
  assert.deepEqual(out.map((r) => r.id), ["/w/ok.md"]);
});

test("start wins over date; attendees are the fallback for people", () => {
  const out = fromPayload({ filed: [{ path: "/a.md", date: "2026-10-12", start: "2026-10-12T21:15:00Z", attendees: ["Ada"] }] });
  assert.equal(out[0].at, "2026-10-12T21:15:00Z");
  assert.deepEqual(out[0].people, ["Ada"]);
});

test("no payload gathers nothing", async () => {
  assert.deepEqual(await conversationsSource({}).gather({}), []);
  assert.deepEqual(fromPayload(null), []);
});

test("shipped reads commits per repo and survives a broken repo", async () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args);
    if (args.includes("/bad")) throw new Error("not a git repository");
    return "abc\x1f2026-10-12T15:00:00-05:00\x1fShip the thing\ndef\x1f2026-10-12T16:00:00-05:00\x1fFix it\n";
  };
  const out = await shippedSource({ repos: ["/bad", "/good"], days: 3, exec, now: () => new Date("2026-10-13T00:00:00Z") }).gather({});
  assert.deepEqual(out.map((r) => r.id), ["abc", "def"]);
  assert.deepEqual(out[0], { id: "abc", at: "2026-10-12T15:00:00-05:00", kind: "commit", title: "Ship the thing", data: { repo: "/good" } });
  assert.ok(calls[1].includes("--since=2026-10-10T00:00:00.000Z"));
});
