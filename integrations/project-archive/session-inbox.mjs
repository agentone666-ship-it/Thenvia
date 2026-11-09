import { createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Files are transport for the dedicated Codex chat's decisions. */
export async function classifyProject(text, projects, context) {
  const state =
    process.env.AGENTONE_ARCHIVE_STATE ??
    join(homedir(), "Library/Application Support/AgentOne/ProjectArchive");
  const inbox = join(state, "SessionInbox");
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  if (lstatSync(inbox).isSymbolicLink())
    throw new Error("Session inbox must be a regular directory");
  const input = {
    version: 1,
    transcript: text,
    ...(context ? { context } : {}),
    projects: projects.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
  };
  const requestId = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  const request = join(inbox, requestId + ".request.json");
  const response = join(inbox, requestId + ".response.json");
  if (!existsSync(request))
    writeFileSync(
      request,
      JSON.stringify({ request_id: requestId, ...input }, null, 2),
      { flag: "wx", mode: 0o600 },
    );
  if (!existsSync(response)) return null;
  if (lstatSync(response).isSymbolicLink())
    throw new Error("Session response must be a regular file");
  let result;
  try {
    result = JSON.parse(readFileSync(response, "utf8"));
  } catch {
    renameSync(response, response + ".rejected");
    throw new Error("Session returned invalid JSON; retry requested");
  }
  const validChoice =
    result.choice === "unknown" ||
    projects.some((project) => project.id === result.choice);
  if (
    result.request_id !== requestId ||
    !validChoice ||
    !Number.isFinite(result.confidence) ||
    result.confidence < 0 ||
    result.confidence > 1 ||
    typeof result.reason !== "string" ||
    typeof result.quote !== "string" ||
    (result.choice !== "unknown" &&
      (!result.quote.trim() || !text.includes(result.quote)))
  ) {
    renameSync(response, response + ".rejected");
    throw new Error("Session returned unsupported project evidence");
  }
  return result;
}
