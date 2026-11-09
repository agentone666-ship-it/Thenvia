import {
  mkdirSync,
  copyFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const source = dirname(fileURLToPath(import.meta.url));
const state = join(
  homedir(),
  "Library/Application Support/AgentOne/ProjectArchive",
);
const runtime = join(state, "runtime");
const archive = join(runtime, "integrations/project-archive");
const memory = join(runtime, "plugins/agentone-memory");
mkdirSync(archive, { recursive: true, mode: 0o700 });
mkdirSync(memory, { recursive: true, mode: 0o700 });
const oldClassifier = join(archive, "classify.mjs");
if (existsSync(oldClassifier)) unlinkSync(oldClassifier);
for (const file of [
  "run.mjs",
  "archive.mjs",
  "session-inbox.mjs",
  "work-orders.mjs",
  "WORKFLOW.md",
])
  copyFileSync(join(source, file), join(archive, file));
for (const file of [
  "store.mjs",
  "recall.mjs",
  "conversations.mjs",
  "schema.sql",
  "migrate-v2.sql",
])
  copyFileSync(
    resolve(source, "../../plugins/agentone-memory", file),
    join(memory, file),
  );
const label = "life.agentone.project-archive";
const folder = join(homedir(), "Library/LaunchAgents");
mkdirSync(folder, { recursive: true });
const plist = join(folder, label + ".plist");
const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
for (const file of ["stdout.log", "stderr.log"]) {
  const path = join(state, file);
  writeFileSync(path, "", { flag: "a", mode: 0o600 });
  chmodSync(path, 0o600);
}
writeFileSync(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(join(archive, "run.mjs"))}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${escape(join(state, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${escape(join(state, "stderr.log"))}</string>
</dict></plist>`,
  { mode: 0o600 },
);
const domain = "gui/" + userInfo().uid;
const registered =
  spawnSync("/bin/launchctl", ["print", domain + "/" + label], {
    stdio: "ignore",
  }).status === 0;
const result = spawnSync(
  "/bin/launchctl",
  registered
    ? ["kickstart", "-k", domain + "/" + label]
    : ["bootstrap", domain, plist],
  { encoding: "utf8" },
);
if (result.status !== 0)
  throw new Error("Background archive registration failed: " + result.stderr);
console.log(
  "Project recording archive installed. Status: " + join(state, "status.json"),
);
