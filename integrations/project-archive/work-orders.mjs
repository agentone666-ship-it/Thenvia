import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  realpathSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { projectsFromCodex } from "./archive.mjs";
import {
  MemoryStore,
  memoryRoot,
} from "../../plugins/agentone-memory/store.mjs";
import { ConversationStore } from "../../plugins/agentone-memory/conversations.mjs";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const QUALITY_LIMITS = {
  goal: 10,
  scope: 15,
  function: 30,
  usability: 15,
  validation: 20,
  handoff: 10,
};

/** Durable dispatch receipts and an auditable quality floor for the coordinating chat. */
export class WorkOrders {
  constructor(root, projects = projectsFromCodex, verifySource) {
    this.root = root;
    this.projects = projects;
    this.verifySource = verifySource;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = join(root, "work-orders.sqlite");
    if (existsSync(file))
      check(
        !lstatSync(file).isSymbolicLink(),
        "Work-order database must be a regular file",
      );
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS work_orders (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal_key TEXT NOT NULL,
        state TEXT NOT NULL, thread_id TEXT UNIQUE, host_id TEXT,
        contract TEXT NOT NULL, report TEXT, review TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
        UNIQUE(project_id,goal_key));`);
  }
  close() {
    this.db.close();
  }
  list() {
    return this.db
      .prepare("SELECT * FROM work_orders ORDER BY created_ms")
      .all()
      .map((row) => ({
        ...row,
        contract: JSON.parse(row.contract),
        report: row.report ? JSON.parse(row.report) : null,
        review: row.review ? JSON.parse(row.review) : null,
      }));
  }
  get(id) {
    const row = this.list().find((row) => row.id === id);
    check(row, "Unknown work order");
    return row;
  }
  reserve(input) {
    check(
      typeof input.goal_key === "string" &&
        /^[a-z0-9][a-z0-9_-]{3,100}$/.test(input.goal_key),
      "A stable goal key is required",
    );
    let project = this.projects().find((p) => p.id === input.project_id);
    if (input.project_id === "idea-lab") {
      const lab = join(this.root, "IdeaLab");
      mkdirSync(lab, { recursive: true, mode: 0o700 });
      check(
        !lstatSync(lab).isSymbolicLink(),
        "Idea lab must be a regular directory",
      );
      const path = join(lab, input.goal_key);
      mkdirSync(path, { recursive: true, mode: 0o700 });
      check(
        !lstatSync(path).isSymbolicLink(),
        "Idea workspace must be a regular directory",
      );
      project = { id: "idea-lab", path };
    }
    check(project, "Project is not registered");
    check(
      typeof input.objective === "string" &&
        input.objective.trim().length >= 10,
      "A concrete objective is required",
    );
    check(
      Array.isArray(input.acceptance) &&
        input.acceptance.length >= 3 &&
        input.acceptance.every(
          (s) => typeof s === "string" && s.trim().length >= 5,
        ),
      "At least three concrete acceptance checks are required",
    );
    check(
      typeof input.request_id === "string" &&
        /^[a-f0-9]{64}$/.test(input.request_id),
      "Invalid recording request",
    );
    const requestPath = join(
      this.root,
      "SessionInbox",
      input.request_id + ".request.json",
    );
    check(
      !lstatSync(requestPath).isSymbolicLink(),
      "Recording request must be a regular file",
    );
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    const { request_id, ...requestInput } = request;
    check(
      hash(JSON.stringify(requestInput)) === request_id,
      "Recording request was modified",
    );
    check(
      request.request_id === input.request_id &&
        (project.id === "idea-lab" ||
          request.projects.some((p) => p.id === project.id)),
      "Recording and project do not match",
    );
    check(
      typeof input.quote === "string" &&
        input.quote.trim().length >= 5 &&
        request.transcript.includes(input.quote),
      "Opportunity needs an exact recording quote",
    );
    check(
      request.context?.conversation_id && request.context?.source_digest,
      "Opportunity needs source provenance",
    );
    this.verifySource?.(request.context, input.quote);
    const id = hash(project.id + "\n" + input.goal_key).slice(0, 24);
    const contract = {
      ...input,
      id,
      project_path: project.path,
      source: request.context,
      quality_floor: 60,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT id FROM work_orders WHERE id=?")
        .get(id);
      if (existing) {
        this.db.exec("COMMIT");
        return { created: false, order: this.get(id) };
      }
      const active = this.db
        .prepare(
          "SELECT COUNT(*) n FROM work_orders WHERE state IN ('reserved','running','reviewing','rework')",
        )
        .get().n;
      check(active < 2, "Two work sessions are already active");
      this.db
        .prepare(
          "INSERT INTO work_orders(id,project_id,goal_key,state,contract,created_ms,updated_ms) VALUES(?,?,?,'reserved',?,?,?)",
        )
        .run(
          id,
          project.id,
          input.goal_key,
          JSON.stringify(contract),
          Date.now(),
          Date.now(),
        );
      this.db.exec("COMMIT");
      return { created: true, order: this.get(id) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  bind(id, threadId, hostId = "local") {
    const order = this.get(id);
    check(
      typeof threadId === "string" && /^[a-f0-9-]{36}$/.test(threadId),
      "Invalid work-session ID",
    );
    check(
      !order.thread_id || order.thread_id === threadId,
      "Order is already bound to another session",
    );
    check(
      ["reserved", "running"].includes(order.state),
      "Order cannot be rebound",
    );
    this.db
      .prepare(
        "UPDATE work_orders SET thread_id=?,host_id=?,state='running',updated_ms=? WHERE id=?",
      )
      .run(threadId, hostId, Date.now(), id);
    return this.get(id);
  }
  submit(id, report) {
    const order = this.get(id);
    check(
      ["running", "rework", "reviewing"].includes(order.state),
      "Order is not ready for a report",
    );
    check(
      report.thread_id === order.thread_id,
      "Report belongs to a different session",
    );
    check(
      Array.isArray(report.artifacts) && report.artifacts.length > 0,
      "Delivery artifacts are required",
    );
    const root = realpathSync(order.contract.project_path);
    for (const artifact of report.artifacts) {
      check(typeof artifact === "string", "Invalid artifact");
      const path = realpathSync(artifact);
      check(
        path.startsWith(root + sep) && lstatSync(path).isFile(),
        "Artifact must be an existing file in the project",
      );
    }
    check(
      Array.isArray(report.checks) &&
        report.checks.length > 0 &&
        report.checks.every((c) => typeof c === "string" && c.trim()),
      "Validation evidence is required",
    );
    this.db
      .prepare(
        "UPDATE work_orders SET state='reviewing',report=?,review=NULL,updated_ms=? WHERE id=?",
      )
      .run(JSON.stringify(report), Date.now(), id);
    return this.get(id);
  }
  resume(id) {
    const order = this.get(id);
    check(order.state === "blocked", "Only a blocked order can resume");
    this.verifySource?.(order.contract.source, order.contract.quote);
    const active = this.db
      .prepare(
        "SELECT COUNT(*) n FROM work_orders WHERE state IN ('reserved','running','reviewing','rework')",
      )
      .get().n;
    check(active < 2, "Two work sessions are already active");
    this.db
      .prepare("UPDATE work_orders SET state=?,updated_ms=? WHERE id=?")
      .run(order.thread_id ? "running" : "reserved", Date.now(), id);
    return this.get(id);
  }
  stop(id, state, reason) {
    check(["blocked", "cancelled"].includes(state), "Invalid stopped state");
    this.get(id);
    check(
      typeof reason === "string" && reason.trim().length >= 10,
      "A specific stopping reason is required",
    );
    this.db
      .prepare(
        "UPDATE work_orders SET state=?,review=?,updated_ms=? WHERE id=?",
      )
      .run(state, JSON.stringify({ reason }), Date.now(), id);
    return this.get(id);
  }
  review(id, review) {
    const order = this.get(id);
    check(
      order.state === "reviewing" && order.report,
      "A delivery report is required before review",
    );
    check(
      typeof review.reviewer_thread_id === "string" &&
        review.reviewer_thread_id !== order.thread_id,
      "A separate coordinating session must review the delivery",
    );
    check(
      typeof review.evidence === "string" &&
        review.evidence.trim().length >= 10,
      "Independent inspection evidence is required",
    );
    let score = 0;
    for (const [name, limit] of Object.entries(QUALITY_LIMITS)) {
      const n = review.scores?.[name];
      check(
        Number.isInteger(n) && n >= 0 && n <= limit,
        "Invalid quality score: " + name,
      );
      score += n;
    }
    const gates = [
      "core_flow_verified",
      "validation_verified",
      "usable_artifact_verified",
      "no_major_blocker",
    ];
    check(
      gates.every((name) => typeof review[name] === "boolean"),
      "Every quality gate must be explicitly reviewed",
    );
    this.verifySource?.(order.contract.source, order.contract.quote);
    const accepted =
      score >= 60 &&
      Object.entries(QUALITY_LIMITS).every(
        ([name, limit]) => review.scores[name] >= Math.ceil(limit * 0.6),
      ) &&
      gates.every((name) => review[name]);
    check(
      accepted ||
        (typeof review.rework === "string" &&
          review.rework.trim().length >= 10),
      "Failed quality review needs specific rework instructions",
    );
    this.db
      .prepare(
        "UPDATE work_orders SET state=?,review=?,updated_ms=? WHERE id=?",
      )
      .run(
        accepted ? "accepted" : "rework",
        JSON.stringify({ ...review, total: score }),
        Date.now(),
        id,
      );
    return this.get(id);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root =
    process.env.AGENTONE_ARCHIVE_STATE ??
    join(homedir(), "Library/Application Support/AgentOne/ProjectArchive");
  const config = existsSync(join(root, "config.json"))
    ? JSON.parse(readFileSync(join(root, "config.json"), "utf8"))
    : {};
  const verify = (context, quote) => {
    const memory = new MemoryStore(config.memoryRoot ?? memoryRoot());
    try {
      const snapshot = new ConversationStore(memory).snapshot(
        context.conversation_id,
        true,
      );
      check(
        snapshot.c.input_digest === context.source_digest,
        "Recording source changed",
      );
      check(
        snapshot.c.transcript_text.includes(quote),
        "Opportunity quote is absent from the current recording",
      );
    } finally {
      memory.close();
    }
  };
  const orders = new WorkOrders(root, projectsFromCodex, verify);
  try {
    const [command, id, arg] = process.argv.slice(2);
    let result;
    if (command === "list") result = orders.list();
    else if (command === "reserve")
      result = orders.reserve(JSON.parse(readFileSync(id, "utf8")));
    else if (command === "bind")
      result = orders.bind(id, arg, process.argv[5] ?? "local");
    else if (command === "resume") result = orders.resume(id);
    else if (command === "stop") result = orders.stop(id, arg, process.argv[5]);
    else if (command === "submit")
      result = orders.submit(id, JSON.parse(readFileSync(arg, "utf8")));
    else if (command === "review")
      result = orders.review(id, JSON.parse(readFileSync(arg, "utf8")));
    else
      throw new Error(
        "Use list, reserve <proposal.json>, bind <id> <threadId> [hostId], resume <id>, stop <id> <blocked|cancelled> <reason>, submit <id> <report.json>, or review <id> <review.json>",
      );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    orders.close();
  }
}
