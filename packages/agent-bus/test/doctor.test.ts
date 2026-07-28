import { renderDoctorReport, runDoctor } from "../src/doctor.js";
import { createAgentBus } from "../src/store.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

async function writeSettings(hooks: unknown) {
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(join(root, ".claude/settings.json"), JSON.stringify({ hooks }), "utf8");
}

const workingHooks = {
  SessionStart: [
    { hooks: [{ type: "command", command: "node scripts/agent-bus.mjs hook session-start" }] },
  ],
  Stop: [{ hooks: [{ type: "command", command: "node scripts/agent-bus.mjs hook stop" }] }],
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-bus-doctor-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("doctor", () => {
  it("says the bus is switched off before init", async () => {
    const report = await runDoctor(createBus());
    expect(report.healthy).toBe(false);
    expect(report.initialized).toBe(false);
    expect(report.verdict).toContain("agent-bus init");
  });

  it("reports missing settings", async () => {
    const bus = createBus();
    await bus.init();

    const report = await runDoctor(bus);
    expect(report.hooks.settingsFound).toBe(false);
    expect(report.healthy).toBe(false);
    expect(report.verdict).toContain("no hooks to run");
  });

  it("names the hook that is missing", async () => {
    const bus = createBus();
    await bus.init();
    await writeSettings({ SessionStart: workingHooks.SessionStart });

    const report = await runDoctor(bus);
    expect(report.hooks).toMatchObject({ sessionStart: true, stop: false });
    expect(report.verdict).toContain("Stop");
  });

  it("catches hooks that point at something else", async () => {
    const bus = createBus();
    await bus.init();
    await writeSettings({
      SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      Stop: workingHooks.Stop,
    });

    const report = await runDoctor(bus);
    expect(report.hooks.sessionStart).toBe(false);
    expect(report.verdict).toContain("SessionStart");
  });

  it("flags an inbox that was never drained", async () => {
    const bus = createBus();
    await bus.init();
    await writeSettings(workingHooks);
    await bus.post({ from: "cowork", to: "claude-code", kind: "task", subject: "Zweiter Test" });

    const report = await runDoctor(bus);
    expect(report.healthy).toBe(false);
    expect(report.verdict).toContain("never drained");
  });

  it("reports a healthy bus once the inbox was drained", async () => {
    const bus = createBus();
    await bus.init();
    await writeSettings(workingHooks);
    await bus.post({ from: "cowork", to: "claude-code", kind: "task", subject: "Zweiter Test" });
    await bus.drain("claude-code");

    const report = await runDoctor(bus);
    expect(report.healthy).toBe(true);
    expect(report.verdict).toContain("draining its inbox");
    expect(report.agents).toContainEqual(
      expect.objectContaining({
        agent: "claude-code",
        readCount: 1,
        pending: 0,
        lastReadSubject: "Zweiter Test",
      }),
    );
  });

  it("stays healthy but counts what is still waiting", async () => {
    const bus = createBus();
    await bus.init();
    await writeSettings(workingHooks);
    await bus.post({ from: "cowork", to: "claude-code", kind: "task", subject: "first" });
    await bus.drain("claude-code");
    await bus.post({ from: "cowork", to: "claude-code", kind: "task", subject: "second" });

    const report = await runDoctor(bus);
    expect(report.healthy).toBe(true);
    expect(report.verdict).toContain("1 message(s) are waiting");
  });

  it("renders a report a human can read", async () => {
    const bus = createBus();
    await bus.init();
    await writeSettings(workingHooks);
    await bus.post({ from: "cowork", to: "claude-code", kind: "task", subject: "Zweiter Test" });
    await bus.drain("claude-code");

    const text = renderDoctorReport(await runDoctor(bus));
    expect(text).toContain("mailbox    ok");
    expect(text).toContain("hooks      ok       SessionStart, Stop");
    expect(text).toContain("mailbox    ok       ");
    expect(text).toContain('last read "Zweiter Test"');
  });
});
