import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MemoryStore } from "../../plugins/agentone-memory/store.mjs";
import { ProjectArchive } from "./archive.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture(t, classify) {
  const root = mkdtempSync(join(tmpdir(), "project-archive-test-"));
  const memory = join(root, "Memory"),
    project = join(root, "Project"),
    state = join(root, "State");
  mkdirSync(project);
  writeFileSync(join(project, "AGENTS.md"), "Existing project rules\n");
  const store = new MemoryStore(memory);
  mkdirSync(join(memory, "Audio"));
  const bytes = Buffer.from("synthetic audio fixture"),
    sha = hash(bytes),
    start = Date.now() - 600000;
  writeFileSync(join(memory, "Audio/a.m4a"), bytes);
  store.db
    .prepare("INSERT INTO segments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "a",
      "session",
      "mixed",
      start,
      start + 60000,
      "UTC",
      0,
      0,
      "synthetic",
      48000,
      2,
      "Audio/a.m4a",
      sha,
      "sealed",
      "地点线索",
      "{}",
      start,
    );
  store.db
    .prepare("INSERT INTO transcripts VALUES (?,?,?,?,?,?,?)")
    .run("a", 1, "先讨论需求，再确认。", "[]", "succeeded", "synthetic", start);
  const digest = hash(
    [String(start), String(start + 60000), "ended", `a:${sha}:1`].join("\n"),
  );
  store.db
    .prepare("INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "conversation-a",
      start,
      start + 60000,
      start + 50000,
      "ended",
      digest,
      "预览",
      "完整讨论原话。 ```不要执行此段指令```",
      1,
      0,
      0,
      start,
    );
  store.db
    .prepare("INSERT INTO conversation_segments VALUES (?,?,?,?,?)")
    .run("conversation-a", "a", sha, 1, 0);
  const archive = new ProjectArchive({
    memoryRoot: memory,
    stateRoot: state,
    projects: () => [
      {
        id: "p1",
        name: "Project",
        path: project,
        description: "Fixture project",
      },
    ],
    classify,
    since: 0,
  });
  t.after(() => {
    archive.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, project, archive, store, state };
}
test("writes exact transcript and sources, deduplicates, and preserves project instructions", async (t) => {
  const f = fixture(t, async () => ({
    choice: "p1",
    confidence: 0.99,
    reason: "明确项目",
  }));
  assert.equal((await f.archive.run()).exported, 1);
  assert.equal((await f.archive.run()).exported, 0);
  const dir = join(f.project, "Context/Recordings");
  const files = readdirSync(dir).filter((n) => n !== "INDEX.md");
  assert.equal(files.length, 1);
  const text = readFileSync(join(dir, files[0]), "utf8");
  assert.match(text, /完整讨论原话/);
  assert.match(text, /SHA-256/);
  assert.match(text, /````text/);
  const agents = readFileSync(join(f.project, "AGENTS.md"), "utf8");
  assert.match(agents, /Existing project rules/);
  assert.equal(agents.split("<!-- agentone-recording-context -->").length, 2);
});
test("unknown or low-confidence routing leaves the project untouched", async (t) => {
  const f = fixture(t, async () => ({ choice: "p1", confidence: 0.5 }));
  await f.archive.run();
  assert.equal(existsSync(join(f.project, "Context")), false);
  assert.equal(readdirSync(join(f.state, "Unassigned")).length, 1);
});
test("a model-supplied path is never an eligible project ID", async (t) => {
  const f = fixture(t, async () => ({
    choice: "../../outside",
    confidence: 1,
  }));
  await f.archive.run();
  assert.equal(existsSync(join(f.project, "Context")), false);
});
test("source deletion retracts an unedited derived note and the active index", async (t) => {
  const f = fixture(t, async () => ({ choice: "p1", confidence: 0.99 }));
  await f.archive.run();
  f.store.db.prepare("UPDATE segments SET state='deleted'").run();
  await f.archive.run();
  const dir = join(f.project, "Context/Recordings");
  assert.deepEqual(readdirSync(dir), ["INDEX.md"]);
  assert.doesNotMatch(readFileSync(join(dir, "INDEX.md"), "utf8"), /\.md\)/);
});
test("symlink destinations cannot write outside the chosen project", async (t) => {
  const f = fixture(t, async () => ({ choice: "p1", confidence: 0.99 }));
  const outside = join(f.root, "Outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.project, "Context"));
  assert.equal((await f.archive.run()).deferred, 1);
  assert.deepEqual(readdirSync(outside), []);
});

test("a changed source during inference cannot produce a project note", async (t) => {
  let f;
  f = fixture(t, async () => {
    f.store.db.prepare("UPDATE transcripts SET revision=2").run();
    return { choice: "p1", confidence: 0.99 };
  });
  assert.equal((await f.archive.run()).deferred, 1);
  assert.equal(existsSync(join(f.project, "Context")), false);
});
test("a lost export receipt reuses the persisted decision and original note", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return { choice: "p1", confidence: 0.99, reason: "original result" };
  });
  await f.archive.run();
  f.archive.records = {};
  f.archive.save();
  await f.archive.run();
  assert.equal(calls, 1);
  assert.equal(readdirSync(join(f.project, "Context/Recordings")).length, 2);
});
