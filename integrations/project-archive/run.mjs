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
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopped = true;
  });
const archive = new ProjectArchive({
  memoryRoot: config.memoryRoot,
  stateRoot: root,
  projects: () => projectsFromCodex(),
  classify: classifyProject,
  since: config.since,
});
while (!stopped) {
  try {
    const result = await archive.run();
    writeFileSync(
      join(root, "status.json"),
      JSON.stringify({
        ...result,
        updated_at: new Date().toISOString(),
        classifier: "dedicated_codex_session",
      }),
      { mode: 0o600 },
    );
  } catch {
    writeFileSync(
      join(root, "status.json"),
      JSON.stringify({
        status: "waiting_or_retrying",
        updated_at: new Date().toISOString(),
        classifier: "dedicated_codex_session",
      }),
      { mode: 0o600 },
    );
  }
  if (process.argv.includes("--once")) break;
  await new Promise((resolve) => setTimeout(resolve, 15000));
}
archive.close();
