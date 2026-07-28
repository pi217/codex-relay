import { ALL_AGENTS, type AgentId } from "./schema.js";
import { BUS_DIRECTORY_NAME } from "./paths.js";
import { renderInbox } from "./render.js";
import type { AgentBus } from "./store.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);

export const HookPayloadSchema = z.object({
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
  source: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
});

export type HookPayload = z.infer<typeof HookPayloadSchema>;

export type GitSummary = {
  branch: string;
  changedFiles: string[];
};

export type SessionStartHookOptions = {
  bus: AgentBus;
  agent: AgentId;
};

export type StopHookOptions = {
  bus: AgentBus;
  agent: AgentId;
  payload?: HookPayload;
  readGitSummary?: () => Promise<GitSummary | undefined>;
};

export function parseHookPayload(raw: string): HookPayload {
  try {
    const parsed = HookPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Runs on SessionStart. The returned text is printed on stdout, which Claude
 * Code injects into the session context, so the agent starts a session already
 * knowing what the other side said.
 */
export async function runSessionStartHook({ bus, agent }: SessionStartHookOptions) {
  if (!(await bus.isInitialized())) return "";
  const messages = await bus.drain(agent);
  const openTasks = (await bus.tasks()).filter(
    (task) =>
      (task.assignee === agent || task.owner === agent) &&
      (task.status === "open" || task.status === "claimed" || task.status === "blocked"),
  );
  return renderInbox(messages, agent, openTasks);
}

/**
 * Runs on Stop. It publishes a turn-finished signal with the git state, not the
 * turn content: the hook payload does not carry the answer text, and guessing
 * it would be worse than a precise signal the other agent can act on.
 */
export async function runStopHook({ bus, agent, payload, readGitSummary }: StopHookOptions) {
  if (!(await bus.isInitialized())) return undefined;
  if (payload?.stop_hook_active) return undefined;

  const git = await (readGitSummary ?? (() => readGitSummaryOf(bus.paths.root)))();
  const body = renderStopBody(git);
  const previous = (await bus.list())
    .filter((message) => message.from === agent && message.kind === "status")
    .at(-1);
  if (previous?.body === body) return undefined;

  return bus.post({
    from: agent,
    to: ALL_AGENTS,
    kind: "status",
    subject: `${agent} finished a turn`,
    body,
    refs: git?.changedFiles.slice(0, 20) ?? [],
  });
}

export function renderStopBody(git: GitSummary | undefined) {
  if (!git) return "Turn finished. No git information available.";
  if (git.changedFiles.length === 0) {
    return `Turn finished on branch ${git.branch} with a clean working tree.`;
  }
  return `Turn finished on branch ${git.branch} with ${git.changedFiles.length} changed file(s).`;
}

export async function readGitSummaryOf(cwd: string): Promise<GitSummary | undefined> {
  let status: string;
  try {
    status = (await run("git", ["status", "--porcelain"], { cwd })).stdout;
  } catch {
    return undefined;
  }

  return {
    branch: await readBranchName(cwd),
    changedFiles: status
      .split("\n")
      .map((line) => line.slice(3).trim())
      // The mailbox itself changes on every post; reporting it as project work
      // would make every status message look different.
      .filter((line) => line.length > 0 && !line.startsWith(`${BUS_DIRECTORY_NAME}/`)),
  };
}

/**
 * `git branch --show-current` also answers in a repository without commits,
 * where `rev-parse HEAD` fails. It returns nothing on a detached HEAD, so the
 * commit is the fallback.
 */
async function readBranchName(cwd: string) {
  try {
    const current = (await run("git", ["branch", "--show-current"], { cwd })).stdout.trim();
    if (current) return current;
    return (await run("git", ["rev-parse", "--short", "HEAD"], { cwd })).stdout.trim();
  } catch {
    return "unknown";
  }
}
