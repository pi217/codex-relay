import {
  parseHookPayload,
  readGitSummaryOf,
  renderStopBody,
  runSessionStartHook,
  runStopHook,
} from "../src/hooks.js";
import { createAgentBus } from "../src/store.js";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);

let root: string;

function createBus() {
  let tick = 0;
  let sequence = 0;
  return createAgentBus({
    root,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    createId: (prefix) => `${prefix}_${String(sequence++).padStart(4, "0")}`,
  });
}

const git = async () => ({ branch: "main", changedFiles: ["src/a.ts", "src/b.ts"] });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-bus-hooks-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("session start hook", () => {
  it("stays silent when the bus was never initialized", async () => {
    const bus = createBus();
    expect(await runSessionStartHook({ bus, agent: "claude-code" })).toBe("");
  });

  it("stays silent when there is nothing new", async () => {
    const bus = createBus();
    await bus.init();
    expect(await runSessionStartHook({ bus, agent: "claude-code" })).toBe("");
  });

  it("renders unread messages and open tasks, then advances the cursor", async () => {
    const bus = createBus();
    await bus.init();
    await bus.post({
      from: "cowork",
      to: "claude-code",
      kind: "task",
      subject: "Add the export button",
      body: "Spec lives in docs/export.md",
      refs: ["docs/export.md"],
    });
    await bus.addTask({
      title: "Wire the endpoint",
      createdBy: "cowork",
      assignee: "claude-code",
    });

    const output = await runSessionStartHook({ bus, agent: "claude-code" });
    expect(output).toContain('<agent-bus recipient="claude-code">');
    expect(output).toContain("Add the export button");
    expect(output).toContain("Spec lives in docs/export.md");
    expect(output).toContain("Wire the endpoint");
    expect(output).toContain("refs: docs/export.md");

    expect(await runSessionStartHook({ bus, agent: "claude-code" })).toContain("Wire the endpoint");
    expect(await runSessionStartHook({ bus, agent: "claude-code" })).not.toContain(
      "Add the export button",
    );
  });
});

describe("stop hook", () => {
  it("posts a turn-finished status with the git state", async () => {
    const bus = createBus();
    await bus.init();

    const message = await runStopHook({ bus, agent: "claude-code", readGitSummary: git });
    expect(message).toMatchObject({
      from: "claude-code",
      to: "all",
      kind: "status",
      subject: "claude-code finished a turn",
    });
    expect(message?.body).toContain("branch main");
    expect(message?.refs).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does not repeat an identical status", async () => {
    const bus = createBus();
    await bus.init();
    await runStopHook({ bus, agent: "claude-code", readGitSummary: git });

    expect(await runStopHook({ bus, agent: "claude-code", readGitSummary: git })).toBeUndefined();
    expect(await bus.list()).toHaveLength(1);
  });

  it("posts again once the git state changed", async () => {
    const bus = createBus();
    await bus.init();
    await runStopHook({ bus, agent: "claude-code", readGitSummary: git });

    const next = await runStopHook({
      bus,
      agent: "claude-code",
      readGitSummary: async () => ({ branch: "main", changedFiles: ["src/a.ts"] }),
    });
    expect(next).toBeDefined();
    expect(await bus.list()).toHaveLength(2);
  });

  it("skips a stop triggered by another stop hook", async () => {
    const bus = createBus();
    await bus.init();
    const message = await runStopHook({
      bus,
      agent: "claude-code",
      payload: { stop_hook_active: true },
      readGitSummary: git,
    });

    expect(message).toBeUndefined();
    expect(await bus.list()).toEqual([]);
  });

  it("does nothing when the bus was never initialized", async () => {
    const bus = createBus();
    expect(await runStopHook({ bus, agent: "claude-code", readGitSummary: git })).toBeUndefined();
  });
});

describe("payload parsing", () => {
  it("reads the fields it needs and tolerates junk", () => {
    expect(parseHookPayload('{"session_id":"abc","stop_hook_active":true}')).toEqual({
      session_id: "abc",
      stop_hook_active: true,
    });
    expect(parseHookPayload("")).toEqual({});
    expect(parseHookPayload("not json")).toEqual({});
    expect(parseHookPayload('{"stop_hook_active":"yes"}')).toEqual({});
  });
});

describe("stop body", () => {
  it("describes a clean tree and a missing repository", () => {
    expect(renderStopBody({ branch: "main", changedFiles: [] })).toContain("clean working tree");
    expect(renderStopBody(undefined)).toContain("No git information");
  });
});

describe("git summary", () => {
  it("returns nothing outside a repository", async () => {
    expect(await readGitSummaryOf(root)).toBeUndefined();
  });

  it("lists changed files and ignores the mailbox itself", async () => {
    await run("git", ["init", "--initial-branch", "work", root]);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await mkdir(join(root, ".coop"), { recursive: true });
    await writeFile(join(root, ".coop", "messages.jsonl"), "{}\n", "utf8");

    const summary = await readGitSummaryOf(root);
    expect(summary?.branch).toBe("work");
    expect(summary?.changedFiles).toEqual(["a.ts"]);
  });
});
