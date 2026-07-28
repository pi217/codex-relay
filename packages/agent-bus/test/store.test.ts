import { AgentBusError, createAgentBus } from "../src/store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;

function createBus(overrides: Partial<Parameters<typeof createAgentBus>[0]> = {}) {
  let tick = 0;
  let sequence = 0;
  return createAgentBus({
    root,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    createId: (prefix) => `${prefix}_${String(sequence++).padStart(4, "0")}`,
    ...overrides,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-bus-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("messages", () => {
  it("refuses to post before init", async () => {
    const bus = createBus();
    await expect(
      bus.post({ from: "cowork", to: "claude-code", kind: "task", subject: "hello" }),
    ).rejects.toMatchObject({ code: "not-initialized" });
  });

  it("posts a message and starts a thread", async () => {
    const bus = createBus();
    await bus.init();
    const message = await bus.post({
      from: "cowork",
      to: "claude-code",
      kind: "task",
      subject: "Add the export button",
      body: "The spec is in docs/export.md",
      refs: ["docs/export.md"],
    });

    expect(message).toMatchObject({
      from: "cowork",
      to: "claude-code",
      kind: "task",
      depth: 0,
      refs: ["docs/export.md"],
    });
    expect(await bus.list()).toHaveLength(1);
  });

  it("inherits the thread and increases depth on replies", async () => {
    const bus = createBus();
    await bus.init();
    const first = await bus.post({
      from: "cowork",
      to: "claude-code",
      kind: "question",
      subject: "Which endpoint?",
    });
    const reply = await bus.post({
      from: "claude-code",
      to: "cowork",
      kind: "answer",
      subject: "POST /export",
      replyTo: first.id,
    });

    expect(reply.threadId).toBe(first.threadId);
    expect(reply.depth).toBe(1);
  });

  it("rejects a reply to an unknown message", async () => {
    const bus = createBus();
    await bus.init();
    await expect(
      bus.post({
        from: "cowork",
        to: "claude-code",
        kind: "answer",
        subject: "orphan",
        replyTo: "msg_missing",
      }),
    ).rejects.toMatchObject({ code: "unknown-message" });
  });

  it("stops a ping-pong loop at the depth limit", async () => {
    const bus = createBus({ maxDepth: 2 });
    await bus.init();
    let last = await bus.post({
      from: "cowork",
      to: "claude-code",
      kind: "question",
      subject: "start",
    });
    for (const from of ["claude-code", "cowork"] as const) {
      last = await bus.post({
        from,
        to: from === "cowork" ? "claude-code" : "cowork",
        kind: "answer",
        subject: "again",
        replyTo: last.id,
      });
    }

    await expect(
      bus.post({
        from: "claude-code",
        to: "cowork",
        kind: "answer",
        subject: "and again",
        replyTo: last.id,
      }),
    ).rejects.toMatchObject({ code: "loop-guard" });
  });

  it("caps the number of messages in one thread", async () => {
    const bus = createBus({ maxThreadMessages: 2 });
    await bus.init();
    const first = await bus.post({
      from: "cowork",
      to: "claude-code",
      kind: "note",
      subject: "one",
    });
    await bus.post({
      from: "cowork",
      to: "claude-code",
      kind: "note",
      subject: "two",
      threadId: first.threadId,
    });

    await expect(
      bus.post({
        from: "cowork",
        to: "claude-code",
        kind: "note",
        subject: "three",
        threadId: first.threadId,
      }),
    ).rejects.toMatchObject({ code: "thread-limit" });
  });

  it("skips malformed lines instead of failing the whole read", async () => {
    const bus = createBus();
    await bus.init();
    await bus.post({ from: "cowork", to: "claude-code", kind: "note", subject: "valid" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(bus.paths.messages, "not json\n{}\n", "utf8");

    const messages = await bus.list();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toBe("valid");
  });
});

describe("inbox", () => {
  it("hides an agent's own messages and delivers broadcasts", async () => {
    const bus = createBus();
    await bus.init();
    await bus.post({ from: "claude-code", to: "cowork", kind: "result", subject: "mine" });
    await bus.post({ from: "cowork", to: "all", kind: "status", subject: "broadcast" });

    const inbox = await bus.unread("claude-code");
    expect(inbox.map((message) => message.subject)).toEqual(["broadcast"]);
  });

  it("advances the cursor on drain and stays empty afterwards", async () => {
    const bus = createBus();
    await bus.init();
    await bus.post({ from: "cowork", to: "claude-code", kind: "task", subject: "first" });
    await bus.post({ from: "cowork", to: "claude-code", kind: "task", subject: "second" });

    expect((await bus.drain("claude-code")).map((message) => message.subject)).toEqual([
      "first",
      "second",
    ]);
    expect(await bus.drain("claude-code")).toEqual([]);

    await bus.post({ from: "cowork", to: "claude-code", kind: "task", subject: "third" });
    expect((await bus.drain("claude-code")).map((message) => message.subject)).toEqual(["third"]);
    expect((await bus.readCursor("claude-code")).readCount).toBe(3);
  });

  it("keeps cursors independent per agent", async () => {
    const bus = createBus();
    await bus.init();
    await bus.post({ from: "cowork", to: "all", kind: "status", subject: "shared" });
    await bus.drain("claude-code");

    expect(await bus.unread("cowork")).toEqual([]);
    expect((await bus.unread("codex")).map((message) => message.subject)).toEqual(["shared"]);
  });
});

describe("tasks", () => {
  it("adds, claims, and completes a task", async () => {
    const bus = createBus();
    await bus.init();
    const created = await bus.addTask({
      title: "Wire the export endpoint",
      createdBy: "cowork",
      assignee: "claude-code",
      paths: ["packages/codex-relay/src/app.ts"],
    });
    expect(created.status).toBe("open");

    const claimed = await bus.claimTask(created.id, "claude-code");
    expect(claimed).toMatchObject({ status: "claimed", owner: "claude-code" });

    const done = await bus.updateTask(
      created.id,
      { status: "done", note: "shipped" },
      "claude-code",
    );
    expect(done.status).toBe("done");
    expect(done.owner).toBeUndefined();
    expect(done.notes).toHaveLength(1);
  });

  it("refuses a claim on a task another agent owns", async () => {
    const bus = createBus();
    await bus.init();
    const task = await bus.addTask({ title: "Shared file", createdBy: "cowork" });
    await bus.claimTask(task.id, "claude-code");

    await expect(bus.claimTask(task.id, "cowork")).rejects.toMatchObject({
      code: "already-claimed",
    });
  });

  it("allows a re-claim once the task is released", async () => {
    const bus = createBus();
    await bus.init();
    const task = await bus.addTask({ title: "Shared file", createdBy: "cowork" });
    await bus.claimTask(task.id, "claude-code");
    await bus.updateTask(task.id, { status: "done" }, "claude-code");

    await expect(bus.claimTask(task.id, "cowork")).resolves.toMatchObject({ owner: "cowork" });
  });

  it("reports unknown tasks", async () => {
    const bus = createBus();
    await bus.init();
    await expect(bus.claimTask("tsk_missing", "cowork")).rejects.toMatchObject({
      code: "unknown-task",
    });
  });

  it("serializes concurrent claims so only one agent wins", async () => {
    const bus = createBus();
    await bus.init();
    const task = await bus.addTask({ title: "Race", createdBy: "cowork" });

    const results = await Promise.allSettled([
      bus.claimTask(task.id, "claude-code"),
      bus.claimTask(task.id, "cowork"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");

    expect(fulfilled).toHaveLength(1);
    expect(results.some((result) => result.status === "rejected")).toBe(true);
  });

  it("keeps concurrent task creation from dropping writes", async () => {
    const bus = createBus();
    await bus.init();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        bus.addTask({ title: `task ${index}`, createdBy: "cowork" }),
      ),
    );

    expect(await bus.tasks()).toHaveLength(8);
  });
});

describe("path ownership", () => {
  it("finds files claimed by another agent", async () => {
    const bus = createBus();
    await bus.init();
    const task = await bus.addTask({
      title: "Rewrite the app router",
      createdBy: "cowork",
      paths: ["./packages/codex-relay/src/app.ts", "docs/plan.md"],
    });
    await bus.claimTask(task.id, "cowork");

    const conflicts = await bus.pathConflicts(
      ["packages/codex-relay/src/app.ts", "README.md"],
      "claude-code",
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.paths).toEqual(["./packages/codex-relay/src/app.ts"]);
  });

  it("ignores the agent's own claims and unclaimed tasks", async () => {
    const bus = createBus();
    await bus.init();
    const own = await bus.addTask({ title: "Mine", createdBy: "claude-code", paths: ["a.ts"] });
    await bus.claimTask(own.id, "claude-code");
    await bus.addTask({ title: "Open", createdBy: "cowork", paths: ["b.ts"] });

    expect(await bus.pathConflicts(["a.ts", "b.ts"], "claude-code")).toEqual([]);
  });

  it("throws when the lock cannot be acquired", async () => {
    const bus = createBus({ lockTimeoutMs: 50, lockStaleMs: 60_000 });
    await bus.init();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(bus.paths.tasksLock, "999999", "utf8");

    await expect(bus.addTask({ title: "blocked", createdBy: "cowork" })).rejects.toBeInstanceOf(
      AgentBusError,
    );
  });

  it("breaks a stale lock", async () => {
    const bus = createBus({ lockTimeoutMs: 50, lockStaleMs: 0 });
    await bus.init();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(bus.paths.tasksLock, "999999", "utf8");

    await expect(bus.addTask({ title: "recovered", createdBy: "cowork" })).resolves.toMatchObject({
      title: "recovered",
    });
  });
});
