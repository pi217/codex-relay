import { ALL_AGENTS, AgentIdSchema, MessageKindSchema, TaskStatusSchema } from "./schema.js";
import { parseHookPayload, runSessionStartHook, runStopHook } from "./hooks.js";
import { renderMessage, renderTaskLine } from "./render.js";
import { AgentBusError, createAgentBus, type AgentBus } from "./store.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const usage = `agent-bus - a project mailbox shared by Claude Code and Cowork

Usage:
  agent-bus init
  agent-bus post --from <agent> --to <agent|all> --kind <kind> --subject <text> [options]
  agent-bus read --agent <agent> [--json]
  agent-bus drain --agent <agent> [--json]
  agent-bus tasks [--json]
  agent-bus task add --title <text> --by <agent> [--for <agent>] [--path <path>...]
  agent-bus task claim <task-id> --agent <agent>
  agent-bus task update <task-id> --agent <agent> [--status <status>] [--note <text>] [--path <path>...]
  agent-bus check --agent <agent> --path <path>...
  agent-bus hook session-start --agent <agent>
  agent-bus hook stop --agent <agent>

Kinds:    ${MessageKindSchema.options.join(", ")}
Statuses: ${TaskStatusSchema.options.join(", ")}

Post options:
  --body <text>       message body ("-" reads stdin)
  --body-file <path>  read the body from a file
  --thread <id>       continue an existing thread
  --reply-to <id>     reply to a message (inherits its thread, increases depth)
  --task <id>         link the message to a task
  --ref <path>        attach a reference; repeatable
  --root <path>       project root (defaults to CODEX_AGENT_BUS_ROOT or cwd)
`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      agent: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      by: { type: "string" },
      for: { type: "string" },
      from: { type: "string" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      kind: { type: "string" },
      note: { type: "string" },
      path: { type: "string", multiple: true },
      ref: { type: "string", multiple: true },
      "reply-to": { type: "string" },
      root: { type: "string" },
      status: { type: "string" },
      subject: { type: "string" },
      task: { type: "string" },
      thread: { type: "string" },
      title: { type: "string" },
      to: { type: "string" },
    },
  });

  const [command, ...rest] = positionals;
  if (!command || values.help) {
    process.stdout.write(usage);
    return command ? 0 : 1;
  }

  const root =
    (typeof values.root === "string" ? values.root : undefined) ??
    process.env.CODEX_AGENT_BUS_ROOT ??
    process.cwd();
  const bus = createAgentBus({ root });

  switch (command) {
    case "init":
      return runInit(bus);
    case "post":
      return runPost(bus, values);
    case "read":
      return runRead(bus, values, { peek: true });
    case "drain":
      return runRead(bus, values, { peek: false });
    case "tasks":
      return runTaskList(bus, values);
    case "task":
      return runTask(bus, rest, values);
    case "check":
      return runCheck(bus, values);
    case "hook":
      return runHook(bus, rest, values);
    default:
      process.stderr.write(`unknown command: ${command}\n\n${usage}`);
      return 1;
  }
}

type Values = Record<string, unknown>;

function readString(values: Values, key: string) {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function readStringList(values: Values, key: string) {
  const value = values[key];
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" ? [value] : [];
}

function requireAgent(values: Values, key: string) {
  const value = readString(values, key);
  if (!value) throw new Error(`missing --${key}`);
  return AgentIdSchema.parse(value);
}

async function runInit(bus: AgentBus) {
  await bus.init();
  process.stdout.write(`initialized ${bus.paths.directory}\n`);
  return 0;
}

async function readBody(values: Values) {
  const bodyFile = readString(values, "body-file");
  if (bodyFile) return readFile(bodyFile, "utf8");
  const body = readString(values, "body");
  if (body === "-") return readStdin();
  return body ?? "";
}

async function runPost(bus: AgentBus, values: Values) {
  const subject = readString(values, "subject");
  if (!subject) throw new Error("missing --subject");
  const to = readString(values, "to") ?? ALL_AGENTS;
  const message = await bus.post({
    from: requireAgent(values, "from"),
    to: AgentIdSchema.parse(to),
    kind: MessageKindSchema.parse(readString(values, "kind") ?? "note"),
    subject,
    body: await readBody(values),
    refs: readStringList(values, "ref"),
    threadId: readString(values, "thread"),
    replyTo: readString(values, "reply-to"),
    taskId: readString(values, "task"),
  });
  process.stdout.write(
    values.json
      ? `${JSON.stringify(message)}\n`
      : `posted ${message.id} in thread ${message.threadId}\n`,
  );
  return 0;
}

async function runRead(bus: AgentBus, values: Values, options: { peek: boolean }) {
  const agent = requireAgent(values, "agent");
  const messages = options.peek ? await bus.unread(agent) : await bus.drain(agent);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(messages)}\n`);
    return 0;
  }
  if (messages.length === 0) {
    process.stdout.write(`no new messages for ${agent}\n`);
    return 0;
  }
  process.stdout.write(`${messages.map(renderMessage).join("\n\n")}\n`);
  return 0;
}

async function runTaskList(bus: AgentBus, values: Values) {
  const tasks = await bus.tasks();
  if (values.json) {
    process.stdout.write(`${JSON.stringify(tasks)}\n`);
    return 0;
  }
  process.stdout.write(
    tasks.length === 0 ? "no tasks\n" : `${tasks.map(renderTaskLine).join("\n")}\n`,
  );
  return 0;
}

async function runTask(bus: AgentBus, rest: string[], values: Values) {
  const [action, id] = rest;
  switch (action) {
    case "add": {
      const title = readString(values, "title");
      if (!title) throw new Error("missing --title");
      const assignee = readString(values, "for");
      const task = await bus.addTask({
        title,
        createdBy: requireAgent(values, "by"),
        assignee: assignee ? AgentIdSchema.parse(assignee) : undefined,
        paths: readStringList(values, "path"),
        threadId: readString(values, "thread"),
      });
      process.stdout.write(values.json ? `${JSON.stringify(task)}\n` : `${renderTaskLine(task)}\n`);
      return 0;
    }
    case "claim": {
      if (!id) throw new Error("missing task id");
      const task = await bus.claimTask(id, requireAgent(values, "agent"));
      process.stdout.write(values.json ? `${JSON.stringify(task)}\n` : `${renderTaskLine(task)}\n`);
      return 0;
    }
    case "update": {
      if (!id) throw new Error("missing task id");
      const status = readString(values, "status");
      const assignee = readString(values, "for");
      const paths = readStringList(values, "path");
      const task = await bus.updateTask(
        id,
        {
          status: status ? TaskStatusSchema.parse(status) : undefined,
          note: readString(values, "note"),
          paths: paths.length > 0 ? paths : undefined,
          assignee: assignee ? AgentIdSchema.parse(assignee) : undefined,
        },
        requireAgent(values, "agent"),
      );
      process.stdout.write(values.json ? `${JSON.stringify(task)}\n` : `${renderTaskLine(task)}\n`);
      return 0;
    }
    case "list":
    case undefined:
      return runTaskList(bus, values);
    default:
      throw new Error(`unknown task action: ${action}`);
  }
}

async function runCheck(bus: AgentBus, values: Values) {
  const agent = requireAgent(values, "agent");
  const paths = readStringList(values, "path");
  if (paths.length === 0) throw new Error("missing --path");
  const conflicts = await bus.pathConflicts(paths, agent);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(conflicts)}\n`);
    return conflicts.length === 0 ? 0 : 1;
  }
  if (conflicts.length === 0) {
    process.stdout.write(`no conflicts for ${agent}\n`);
    return 0;
  }
  for (const conflict of conflicts) {
    process.stdout.write(
      `${conflict.task.owner} owns ${conflict.paths.join(", ")} via task ${conflict.task.id} (${conflict.task.title})\n`,
    );
  }
  return 1;
}

async function runHook(bus: AgentBus, rest: string[], values: Values) {
  const [event] = rest;
  const agent = requireAgent(values, "agent");
  const payload = parseHookPayload(await readStdin());

  switch (event) {
    case "session-start": {
      const inbox = await runSessionStartHook({ bus, agent });
      if (inbox) process.stdout.write(`${inbox}\n`);
      return 0;
    }
    case "stop": {
      await runStopHook({ bus, agent, payload });
      return 0;
    }
    default:
      process.stderr.write(`unknown hook event: ${event}\n`);
      return 0;
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const entryPoint = process.argv[1];
const isDirectRun = entryPoint ? pathToFileURL(entryPoint).href === import.meta.url : false;

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message =
        error instanceof AgentBusError ? `${error.code}: ${error.message}` : String(error);
      process.stderr.write(`agent-bus: ${message}\n`);
      process.exitCode = 1;
    });
}
