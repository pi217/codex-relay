import { ALL_AGENTS, type AgentId, type AgentMessage } from "./schema.js";
import type { AgentBus } from "./store.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type HookStatus = {
  settingsPath: string;
  settingsFound: boolean;
  sessionStart: boolean;
  stop: boolean;
};

export type AgentStatus = {
  agent: AgentId;
  readCount: number;
  pending: number;
  lastReadSubject?: string;
};

export type DoctorReport = {
  directory: string;
  initialized: boolean;
  hooks: HookStatus;
  messageCount: number;
  newestAt?: string;
  agents: AgentStatus[];
  healthy: boolean;
  verdict: string;
};

/**
 * One command that answers "is this thing actually wired up?", so a stuck setup
 * does not need a human to read raw JSON out of .coop.
 */
export async function runDoctor(bus: AgentBus): Promise<DoctorReport> {
  const directory = bus.paths.directory;
  const hooks = await readHookStatus(bus.paths.root);
  const initialized = await bus.isInitialized();

  if (!initialized) {
    return {
      directory,
      initialized,
      hooks,
      messageCount: 0,
      agents: [],
      healthy: false,
      verdict: 'The bus is switched off. Run "agent-bus init" to create the mailbox.',
    };
  }

  const messages = await bus.list();
  const agents = await Promise.all(
    collectAgents(messages).map(async (agent) => {
      const cursor = await bus.readCursor(agent);
      const pending = (await bus.unread(agent)).length;
      const lastRead = messages.find((message) => message.id === cursor.lastReadId);
      return {
        agent,
        readCount: cursor.readCount,
        pending,
        lastReadSubject: lastRead?.subject,
      };
    }),
  );

  return {
    directory,
    initialized,
    hooks,
    messageCount: messages.length,
    newestAt: messages.at(-1)?.ts,
    agents,
    ...judge(hooks, messages, agents),
  };
}

function judge(hooks: HookStatus, messages: AgentMessage[], agents: AgentStatus[]) {
  if (!hooks.settingsFound) {
    return {
      healthy: false,
      verdict: `No ${hooks.settingsPath}, so Claude Code has no hooks to run. The CLI works, but nothing is automatic.`,
    };
  }
  if (!hooks.sessionStart || !hooks.stop) {
    const missing = [
      !hooks.sessionStart ? "SessionStart" : undefined,
      !hooks.stop ? "Stop" : undefined,
    ].filter(Boolean);
    return {
      healthy: false,
      verdict: `${missing.join(" and ")} not wired to agent-bus in ${hooks.settingsPath}.`,
    };
  }

  const claudeCode = agents.find((entry) => entry.agent === "claude-code");
  const addressed = messages.filter(
    (message) => message.to === "claude-code" || message.to === ALL_AGENTS,
  ).length;

  if (addressed > 0 && (!claudeCode || claudeCode.readCount === 0)) {
    return {
      healthy: false,
      verdict:
        "Hooks are configured, but Claude Code has never drained its inbox. Start a new session - hooks only load at session start.",
    };
  }
  if (claudeCode && claudeCode.pending > 0) {
    return {
      healthy: true,
      verdict: `Everything is wired up. ${claudeCode.pending} message(s) are waiting for the next Claude Code session.`,
    };
  }
  return {
    healthy: true,
    verdict: "Everything is wired up and Claude Code has been draining its inbox.",
  };
}

function collectAgents(messages: AgentMessage[]): AgentId[] {
  const seen = new Set<AgentId>();
  for (const message of messages) {
    seen.add(message.from);
    if (message.to !== ALL_AGENTS) seen.add(message.to);
  }
  return [...seen].sort();
}

async function readHookStatus(root: string): Promise<HookStatus> {
  const settingsPath = resolve(root, ".claude/settings.json");
  try {
    const raw: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    return {
      settingsPath,
      settingsFound: true,
      sessionStart: mentionsAgentBus(raw, "SessionStart"),
      stop: mentionsAgentBus(raw, "Stop"),
    };
  } catch {
    return { settingsPath, settingsFound: false, sessionStart: false, stop: false };
  }
}

/**
 * Deliberately structural rather than schema-parsed: settings.json belongs to
 * Claude Code, and doctor should not fail because an unrelated key changed.
 */
function mentionsAgentBus(settings: unknown, event: string) {
  if (typeof settings !== "object" || settings === null) return false;
  const hooks = (settings as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null) return false;
  const entries = (hooks as Record<string, unknown>)[event];
  return JSON.stringify(entries ?? null).includes("agent-bus");
}

export function renderDoctorReport(report: DoctorReport) {
  const lines = [
    `mailbox    ${status(report.initialized ? "ok" : "missing")}${report.directory}`,
    `hooks      ${formatHooks(report.hooks)}`,
  ];
  if (report.initialized) {
    lines.push(
      `messages   ${report.messageCount}${report.newestAt ? `, newest ${report.newestAt}` : ""}`,
    );
    for (const agent of report.agents) {
      const last = agent.lastReadSubject ? `, last read "${agent.lastReadSubject}"` : "";
      lines.push(
        `  ${agent.agent.padEnd(14)} read ${agent.readCount}, ${agent.pending} pending${last}`,
      );
    }
  }
  lines.push("", report.verdict);
  return lines.join("\n");
}

function status(label: string) {
  return label.padEnd(9);
}

function formatHooks(hooks: HookStatus) {
  if (!hooks.settingsFound) return `${status("missing")}no .claude/settings.json`;
  const configured = [
    hooks.sessionStart ? "SessionStart" : undefined,
    hooks.stop ? "Stop" : undefined,
  ].filter(Boolean);
  return configured.length === 2
    ? `${status("ok")}${configured.join(", ")}`
    : `${status("partial")}${configured.join(", ") || "none"}`;
}
