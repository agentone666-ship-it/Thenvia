import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProject } from "./session-inbox.mjs";

test("dedicated session exchange deduplicates requests and validates replies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agentone-session-inbox-"));
  const previous = process.env.AGENTONE_ARCHIVE_STATE;
  process.env.AGENTONE_ARCHIVE_STATE = root;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTONE_ARCHIVE_STATE;
    else process.env.AGENTONE_ARCHIVE_STATE = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const text = "我们讨论 dsh 的云端工作台需求。";
  const projects = [
    { id: "project-dsh", name: "dsh", description: "DeepSeek Harness" },
  ];
  assert.equal(await classifyProject(text, projects), null);
  assert.equal(await classifyProject(text, projects), null);
  const folder = join(root, "SessionInbox");
  const files = readdirSync(folder);
  assert.equal(files.length, 1);
  const request = JSON.parse(readFileSync(join(folder, files[0]), "utf8"));
  assert.equal(request.transcript, text);
  const response = join(folder, request.request_id + ".response.json");
  const result = {
    request_id: request.request_id,
    choice: "project-dsh",
    confidence: 0.95,
    reason: "明确提及项目",
    quote: "dsh 的云端工作台需求",
  };
  writeFileSync(response, JSON.stringify({ ...result, choice: "../../wrong" }));
  await assert.rejects(() => classifyProject(text, projects), /unsupported/);
  writeFileSync(
    response,
    JSON.stringify({ ...result, quote: "未在录音里说过的话" }),
  );
  await assert.rejects(() => classifyProject(text, projects), /unsupported/);
  writeFileSync(response, JSON.stringify(result));
  assert.deepEqual(await classifyProject(text, projects), result);
});
