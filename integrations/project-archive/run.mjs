import { classifyProject } from "./session-inbox.mjs";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProjectArchive, projectsFromCodex } from "./archive.mjs";
import { watchChanges, pendingEvents, workerEvents, EventDispatch, atomicJSON } from "./event-hooks.mjs";
import { queueCodex } from "./codex-session.mjs";
import { memoryRoot } from "../../plugins/agentone-memory/store.mjs";

const root =
  process.env.AGENTONE_ARCHIVE_STATE ??
  join(homedir(), "Library/Application Support/AgentOne/ProjectArchive");
mkdirSync(root, { recursive: true, mode: 0o700 });
const configPath = join(root, "config.json");
const config = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, "utf8"))
  : { since: Date.now(), memoryRoot: memoryRoot() };
if (!existsSync(configPath))
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const lock = join(root, "worker.lock");
try {
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
} catch {
  let stale = false;
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    if (pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        stale = error.code === "ESRCH";
      }
    } else stale = Date.now() - statSync(lock).mtimeMs > 60000;
  } catch {}
  if (!stale) process.exit(0);
  unlinkSync(lock);
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
}
process.on("exit", () => {
  try {
    if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
  } catch {}
});
if (!existsSync(join(config.memoryRoot, "memory.sqlite")))
  throw new Error("Recording database is unavailable");
const archive = new ProjectArchive({
  memoryRoot: config.memoryRoot,
  stateRoot: root,
  projects: () => projectsFromCodex(),
  classify: classifyProject,
  since: config.since,
});
mkdirSync(join(root, "SessionInbox"), { recursive: true, mode: 0o700 });
const dispatch = new EventDispatch(root, async (events) => {
  if (!config.session_id || !config.codex_binary)
    throw new Error("Dedicated Codex hook configuration is missing");
  return queueCodex({ binary: config.codex_binary, threadId: config.session_id,
    prompt: `程序事件 hook（用户已取消全部定时轮询）：${JSON.stringify(events)}。先读取 ${join(root, "runtime/integrations/project-archive/WORKFLOW.md")} 并执行。本轮只处理新事件和相关工单；无需等待下一轮定时器，不要创建定时任务。归档响应落盘后程序会自动接续。工作会话仍使用桌面会话工具创建和跟进；完成、失败或中断的本地状态事件会自动唤醒本会话验收。本地队列确认仅代表已入队，不能当成模型处理完成。`,
  });
});
let scanning = false, again = false, closing = false;
async function scan() {
  if (closing) return;
  if (scanning) { again = true; return; }
  scanning = true;
  try {
    do {
      again = false;
      try {
        const result = await archive.run();
        atomicJSON(join(root, "status.json"), { ...result, updated_at: new Date().toISOString(),
          classifier: "dedicated_codex_session", trigger: "filesystem_hook" });
      } catch (error) {
        atomicJSON(join(root, "status.json"), { status: "needs_attention", error: error.message,
          updated_at: new Date().toISOString(), classifier: "dedicated_codex_session", trigger: "filesystem_hook" });
      }
      // Physical database events may be frequent; only NEW actionable content invokes Codex.
      dispatch.enqueue([...pendingEvents(root), ...workerEvents(root)]);
    } while (again && !closing);
  } finally { scanning = false; }
}
const stopDataWatching = process.argv.includes("--once") ? () => {} : watchChanges([
  { path: config.memoryRoot, accept: name => /^memory\.sqlite(?:-wal)?$/.test(name) },
  { path: join(root, "SessionInbox"), accept: name => /\.(request|response|opportunities)\.json(?:\.rejected)?$/.test(name) },
], scan);
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const stopWorkWatching = process.argv.includes("--once") ? () => {} : watchChanges([
  { path: root, accept: name => /^work-orders\.sqlite(?:-wal)?$/.test(name) },
  { path: codexHome, accept: name => /^thread_history_1\.sqlite(?:-wal)?$/.test(name) },
], () => dispatch.enqueue(workerEvents(root, codexHome)));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  closing = true; stopDataWatching(); stopWorkWatching(); archive.close(); process.exit(0);
});
await scan(); // One catch-up after launch; never a repeating timer.
if (process.argv.includes("--once")) { await dispatch.completion; archive.close(); }
