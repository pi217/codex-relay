import { main } from "../src/cli.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let stdout: string[];
let stderr: string[];

async function cli(...args: string[]) {
  const code = await main([...args, "--root", root]);
  return { code, out: stdout.join(""), err: stderr.join("") };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-bus-cli-"));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("cli", () => {
  it("prints usage without a command", async () => {
    const { code, out } = await cli();
    expect(code).toBe(1);
    expect(out).toContain("agent-bus init");
  });

  it("rejects an unknown command", async () => {
    const { code, err } = await cli("nope");
    expect(code).toBe(1);
    expect(err).toContain("unknown command: nope");
  });

  it("runs a full post and drain round trip", async () => {
    await cli("init");
    const posted = await cli(
      "post",
      "--from",
      "cowork",
      "--to",
      "claude-code",
      "--kind",
      "task",
      "--subject",
      "Add the export button",
      "--body",
      "Spec in docs/export.md",
      "--ref",
      "docs/export.md",
    );
    expect(posted.code).toBe(0);
    expect(posted.out).toMatch(/posted msg_\S+ in thread thr_\S+/);

    stdout = [];
    const drained = await cli("drain", "--agent", "claude-code");
    expect(drained.out).toContain("Add the export button");
    expect(drained.out).toContain("refs: docs/export.md");

    stdout = [];
    expect((await cli("drain", "--agent", "claude-code")).out).toContain("no new messages");
  });

  it("keeps read non-destructive", async () => {
    await cli("init");
    await cli(
      "post",
      "--from",
      "cowork",
      "--to",
      "claude-code",
      "--kind",
      "note",
      "--subject",
      "hi",
    );

    stdout = [];
    await cli("read", "--agent", "claude-code");
    stdout = [];
    expect((await cli("read", "--agent", "claude-code")).out).toContain("hi");
  });

  it("reports a missing sender", async () => {
    await cli("init");
    await expect(
      cli("post", "--to", "cowork", "--kind", "note", "--subject", "hi"),
    ).rejects.toThrow("missing --from");
  });

  it("validates the message kind", async () => {
    await cli("init");
    await expect(
      cli("post", "--from", "cowork", "--to", "all", "--kind", "gossip", "--subject", "hi"),
    ).rejects.toThrow(/Invalid option/);
  });

  it("manages tasks end to end", async () => {
    await cli("init");
    stdout = [];
    const created = await cli(
      "task",
      "add",
      "--title",
      "Wire the endpoint",
      "--by",
      "cowork",
      "--for",
      "claude-code",
      "--path",
      "src/app.ts",
      "--json",
    );
    const task = JSON.parse(created.out) as { id: string };

    stdout = [];
    expect((await cli("task", "claim", task.id, "--agent", "claude-code")).out).toContain(
      "claimed",
    );

    stdout = [];
    const listed = await cli("tasks");
    expect(listed.out).toContain("Wire the endpoint");
    expect(listed.out).toContain("owner=claude-code");

    stdout = [];
    const updated = await cli(
      "task",
      "update",
      task.id,
      "--agent",
      "claude-code",
      "--status",
      "done",
      "--note",
      "shipped",
    );
    expect(updated.out).toContain("[done]");
  });

  it("exits non-zero when another agent owns a path", async () => {
    await cli("init");
    stdout = [];
    const created = await cli(
      "task",
      "add",
      "--title",
      "Router rewrite",
      "--by",
      "cowork",
      "--path",
      "src/app.ts",
      "--json",
    );
    const task = JSON.parse(created.out) as { id: string };
    await cli("task", "claim", task.id, "--agent", "cowork");

    stdout = [];
    const conflict = await cli("check", "--agent", "claude-code", "--path", "src/app.ts");
    expect(conflict.code).toBe(1);
    expect(conflict.out).toContain("cowork owns src/app.ts");

    stdout = [];
    const clean = await cli("check", "--agent", "claude-code", "--path", "src/other.ts");
    expect(clean.code).toBe(0);
  });

  it("reports an uninitialized bus instead of writing files", async () => {
    await expect(
      cli("post", "--from", "cowork", "--to", "all", "--kind", "note", "--subject", "hi"),
    ).rejects.toMatchObject({ code: "not-initialized" });
  });
});
