import type { AgentId, AgentMessage, AgentTask } from "./schema.js";

/**
 * Rendered for the SessionStart hook, so the text lands directly in the
 * receiving agent's context.
 */
export function renderInbox(messages: AgentMessage[], agent: AgentId, openTasks: AgentTask[] = []) {
  if (messages.length === 0 && openTasks.length === 0) return "";

  const lines: string[] = [];
  lines.push(`<agent-bus recipient="${agent}">`);

  if (messages.length > 0) {
    lines.push(`${messages.length} new message(s) since your last session.`);
    lines.push("");
    for (const message of messages) {
      lines.push(renderMessage(message));
      lines.push("");
    }
  }

  if (openTasks.length > 0) {
    lines.push(`Open tasks assigned to you (${openTasks.length}):`);
    for (const task of openTasks) {
      lines.push(`- ${task.id} [${task.status}] ${task.title}${renderTaskPaths(task)}`);
    }
    lines.push("");
  }

  lines.push(
    `Reply with: pnpm -s agent-bus post --from ${agent} --to <agent> --kind answer --reply-to <message-id> --subject "..." --body "..."`,
  );
  lines.push("</agent-bus>");
  return lines.join("\n");
}

export function renderMessage(message: AgentMessage) {
  const lines = [
    `[${message.kind}] ${message.subject}`,
    `id=${message.id} from=${message.from} to=${message.to} thread=${message.threadId} at=${message.ts}`,
  ];
  if (message.taskId) lines.push(`task=${message.taskId}`);
  if (message.refs.length > 0) lines.push(`refs: ${message.refs.join(", ")}`);
  if (message.body.trim()) {
    lines.push("");
    lines.push(message.body.trim());
  }
  return lines.join("\n");
}

export function renderTaskLine(task: AgentTask) {
  const owner = task.owner ? ` owner=${task.owner}` : "";
  const assignee = task.assignee ? ` assignee=${task.assignee}` : "";
  return `${task.id} [${task.status}]${owner}${assignee} ${task.title}${renderTaskPaths(task)}`;
}

function renderTaskPaths(task: AgentTask) {
  return task.paths.length > 0 ? ` (${task.paths.join(", ")})` : "";
}
