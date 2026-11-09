import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkOrders } from "./work-orders.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "agentone-work-orders-"));
  const project = join(root, "project");
  mkdirSync(project);
  mkdirSync(join(root, "SessionInbox"));
  const input = {
    transcript: "我们想做一个可以运行的云端工作台原型。",
    projects: [{ id: "p1" }],
    context: { conversation_id: "c1", source_digest: "digest" },
  };
  const request = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  writeFileSync(
    join(root, "SessionInbox", request + ".request.json"),
    JSON.stringify({ request_id: request, ...input }),
  );
  const orders = new WorkOrders(
    root,
    () => [{ id: "p1", path: project }],
    () => {},
  );
  t.after(() => {
    orders.close();
    rmSync(root, { recursive: true, force: true });
  });
  const proposal = {
    project_id: "p1",
    goal_key: "workbench-prototype",
    objective: "实现可以跑通核心流程的云端工作台原型",
    acceptance: [
      "可以创建一个工作空间",
      "可以保存并重新读取",
      "提供核心流程验证证据",
    ],
    request_id: request,
    quote: "可以运行的云端工作台原型",
  };
  return { orders, proposal, project, root };
}
test("duplicate ideas reuse a durable order and uncertain session binding cannot be replaced", (t) => {
  const { orders, proposal } = fixture(t);
  const first = orders.reserve(proposal);
  assert.equal(first.created, true);
  assert.equal(orders.reserve(proposal).created, false);
  orders.bind(first.order.id, "11111111-1111-1111-1111-111111111111");
  assert.throws(
    () => orders.bind(first.order.id, "22222222-2222-2222-2222-222222222222"),
    /already bound/,
  );
});
test("an invented quote or unregistered project cannot start work", (t) => {
  const { orders, proposal } = fixture(t);
  assert.throws(
    () => orders.reserve({ ...proposal, quote: "这个任务并没有说过" }),
    /exact recording quote/,
  );
  assert.throws(
    () => orders.reserve({ ...proposal, project_id: "other" }),
    /not registered/,
  );
});
test("two active work sessions bound automatic concurrency", (t) => {
  const { orders, proposal } = fixture(t);
  orders.reserve(proposal);
  orders.reserve({ ...proposal, goal_key: "second-prototype" });
  assert.throws(
    () => orders.reserve({ ...proposal, goal_key: "third-prototype" }),
    /already active/,
  );
});
test("a high total cannot bypass the main-flow gate and failed work can be resubmitted", (t) => {
  const { orders, proposal, project } = fixture(t);
  const id = orders.reserve(proposal).order.id;
  const thread = "11111111-1111-1111-1111-111111111111";
  orders.bind(id, thread);
  const artifact = join(project, "prototype.html");
  writeFileSync(artifact, "actual prototype fixture");
  const report = {
    thread_id: thread,
    artifacts: [artifact],
    checks: ["Fixture main-flow inspection log"],
  };
  orders.submit(id, report);
  const review = {
    reviewer_thread_id: "coordinator",
    scores: {
      goal: 10,
      scope: 15,
      function: 30,
      usability: 15,
      validation: 20,
      handoff: 10,
    },
    core_flow_verified: false,
    validation_verified: true,
    usable_artifact_verified: true,
    no_major_blocker: true,
    evidence: "Independently opened the fixture and checked its main flow.",
    rework: "Finish the failing main flow and run the validation again.",
  };
  assert.equal(orders.review(id, review).state, "rework");
  orders.submit(id, report);
  assert.equal(
    orders.review(id, { ...review, core_flow_verified: true }).state,
    "accepted",
  );
});
test("a worker cannot review its own delivery or submit a missing artifact", (t) => {
  const { orders, proposal, project } = fixture(t);
  const id = orders.reserve(proposal).order.id;
  const thread = "11111111-1111-1111-1111-111111111111";
  orders.bind(id, thread);
  assert.throws(() =>
    orders.submit(id, {
      thread_id: thread,
      artifacts: [join(project, "missing")],
      checks: ["test"],
    }),
  );
  const artifact = join(project, "result.txt");
  writeFileSync(artifact, "result");
  orders.submit(id, {
    thread_id: thread,
    artifacts: [artifact],
    checks: ["test log"],
  });
  assert.throws(
    () => orders.review(id, { reviewer_thread_id: thread }),
    /separate/,
  );
});

test("blocked work can resume its original session while cancelled work stays stopped", (t) => {
  const { orders, proposal } = fixture(t);
  const id = orders.reserve(proposal).order.id;
  const thread = "11111111-1111-1111-1111-111111111111";
  orders.bind(id, thread);
  orders.stop(
    id,
    "blocked",
    "Waiting for the required test environment to be available.",
  );
  assert.equal(orders.resume(id).thread_id, thread);
  orders.stop(
    id,
    "cancelled",
    "The user explicitly cancelled this experiment and its execution.",
  );
  assert.throws(() => orders.resume(id), /Only a blocked/);
});

test("a new idea can use a bounded standalone experiment directory", (t) => {
  const { orders, proposal, root } = fixture(t);
  const result = orders.reserve({ ...proposal, project_id: "idea-lab" });
  assert.equal(result.created, true);
  assert.equal(
    result.order.contract.project_path,
    join(root, "IdeaLab", proposal.goal_key),
  );
});
