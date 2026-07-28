import {
  AgentMessageSchema,
  AgentTaskSchema,
  CursorSchema,
  TaskFileSchema,
  isVisibleTo,
  type AgentId,
  type AgentMessage,
  type AgentTask,
  type Cursor,
  type MessageKind,
  type TaskFile,
  type TaskStatus,
} from "./schema.js";
import { createBusPaths, type BusPaths } from "./paths.js";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type AgentBusErrorCode =
  | "not-initialized"
  | "unknown-message"
  | "unknown-task"
  | "loop-guard"
  | "thread-limit"
  | "already-claimed"
  | "lock-timeout";

export class AgentBusError extends Error {
  readonly code: AgentBusErrorCode;

  constructor(code: AgentBusErrorCode, message: string) {
    super(message);
    this.name = "AgentBusError";
    this.code = code;
  }
}

export type PostMessageInput = {
  from: AgentId;
  to: AgentId;
  kind: MessageKind;
  subject: string;
  body?: string;
  refs?: string[];
  threadId?: string;
  replyTo?: string;
  taskId?: string;
};

export type AddTaskInput = {
  title: string;
  createdBy: AgentId;
  assignee?: AgentId;
  paths?: string[];
  threadId?: string;
};

export type UpdateTaskInput = {
  status?: TaskStatus;
  assignee?: AgentId;
  paths?: string[];
  note?: string;
};

export type PathConflict = {
  task: AgentTask;
  paths: string[];
};

export type AgentBusOptions = {
  root: string;
  now?: () => Date;
  createId?: (prefix: string) => string;
  maxDepth?: number;
  maxThreadMessages?: number;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
};

export type AgentBus = ReturnType<typeof createAgentBus>;

const defaultMaxDepth = 8;
const defaultMaxThreadMessages = 60;
const defaultLockTimeoutMs = 5000;
const defaultLockStaleMs = 15000;

export function createAgentBus(options: AgentBusOptions) {
  const paths = createBusPaths(options.root);
  const now = options.now ?? (() => new Date());
  const maxDepth = options.maxDepth ?? defaultMaxDepth;
  const maxThreadMessages = options.maxThreadMessages ?? defaultMaxThreadMessages;
  const lockTimeoutMs = options.lockTimeoutMs ?? defaultLockTimeoutMs;
  const lockStaleMs = options.lockStaleMs ?? defaultLockStaleMs;
  let idCounter = 0;
  const createId =
    options.createId ??
    ((prefix: string) => {
      idCounter += 1;
      const time = now().getTime().toString(36);
      const random = Math.random().toString(36).slice(2, 8);
      return `${prefix}_${time}${idCounter.toString(36)}${random}`;
    });

  async function init() {
    await mkdir(paths.cursors, { recursive: true });
    await appendFile(paths.messages, "", "utf8");
    if (!(await pathExists(paths.tasks))) {
      await writeJsonAtomic(paths.tasks, TaskFileSchema.parse({}));
    }
  }

  async function isInitialized() {
    return pathExists(paths.directory);
  }

  async function requireInitialized() {
    if (!(await isInitialized())) {
      throw new AgentBusError(
        "not-initialized",
        `no ${paths.directory} directory; run "agent-bus init" first`,
      );
    }
  }

  async function list(): Promise<AgentMessage[]> {
    const raw = await readFileOrEmpty(paths.messages);
    const messages: AgentMessage[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = safeParseMessage(trimmed);
      if (parsed) messages.push(parsed);
    }
    return messages;
  }

  async function thread(threadId: string) {
    return (await list()).filter((message) => message.threadId === threadId);
  }

  async function post(input: PostMessageInput): Promise<AgentMessage> {
    await requireInitialized();
    const messages = await list();
    const parent = input.replyTo
      ? messages.find((message) => message.id === input.replyTo)
      : undefined;
    if (input.replyTo && !parent) {
      throw new AgentBusError("unknown-message", `no message with id ${input.replyTo}`);
    }

    const threadId = input.threadId ?? parent?.threadId ?? createId("thr");
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > maxDepth) {
      throw new AgentBusError(
        "loop-guard",
        `reply depth ${depth} exceeds the limit of ${maxDepth} in thread ${threadId}; a human should take over`,
      );
    }

    const threadSize = messages.filter((message) => message.threadId === threadId).length;
    if (threadSize >= maxThreadMessages) {
      throw new AgentBusError(
        "thread-limit",
        `thread ${threadId} already holds ${threadSize} messages (limit ${maxThreadMessages})`,
      );
    }

    const message = AgentMessageSchema.parse({
      id: createId("msg"),
      ts: now().toISOString(),
      threadId,
      from: input.from,
      to: input.to,
      kind: input.kind,
      subject: input.subject,
      body: input.body ?? "",
      refs: input.refs ?? [],
      replyTo: input.replyTo,
      taskId: input.taskId,
      depth,
    });
    await appendFile(paths.messages, `${JSON.stringify(message)}\n`, "utf8");
    return message;
  }

  async function readCursor(agent: AgentId): Promise<Cursor> {
    try {
      return CursorSchema.parse(JSON.parse(await readFile(paths.cursorFor(agent), "utf8")));
    } catch {
      return CursorSchema.parse({ agent });
    }
  }

  async function unread(agent: AgentId): Promise<AgentMessage[]> {
    const [messages, cursor] = await Promise.all([list(), readCursor(agent)]);
    const visible = messages.filter((message) => isVisibleTo(message, agent));
    if (!cursor.lastReadId) return visible;
    const lastIndex = visible.findIndex((message) => message.id === cursor.lastReadId);
    return lastIndex === -1 ? visible : visible.slice(lastIndex + 1);
  }

  async function drain(agent: AgentId): Promise<AgentMessage[]> {
    await requireInitialized();
    const pending = await unread(agent);
    const latest = pending.at(-1);
    if (!latest) return [];
    const cursor = await readCursor(agent);
    await mkdir(paths.cursors, { recursive: true });
    await writeJsonAtomic(
      paths.cursorFor(agent),
      CursorSchema.parse({
        agent,
        lastReadId: latest.id,
        lastReadAt: now().toISOString(),
        readCount: cursor.readCount + pending.length,
      }),
    );
    return pending;
  }

  async function readTaskFile(): Promise<TaskFile> {
    try {
      return TaskFileSchema.parse(JSON.parse(await readFile(paths.tasks, "utf8")));
    } catch {
      return TaskFileSchema.parse({});
    }
  }

  async function tasks(): Promise<AgentTask[]> {
    return (await readTaskFile()).tasks;
  }

  async function mutateTasks<T>(mutate: (file: TaskFile) => T | Promise<T>): Promise<T> {
    await requireInitialized();
    return withTaskLock(paths, { lockTimeoutMs, lockStaleMs }, async () => {
      const file = await readTaskFile();
      const result = await mutate(file);
      await writeJsonAtomic(paths.tasks, TaskFileSchema.parse(file));
      return result;
    });
  }

  async function addTask(input: AddTaskInput): Promise<AgentTask> {
    const timestamp = now().toISOString();
    return mutateTasks((file) => {
      const task = AgentTaskSchema.parse({
        id: createId("tsk"),
        title: input.title,
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: input.createdBy,
        assignee: input.assignee,
        paths: input.paths ?? [],
        notes: [],
        threadId: input.threadId,
      });
      file.tasks.push(task);
      return task;
    });
  }

  async function claimTask(id: string, agent: AgentId): Promise<AgentTask> {
    return mutateTasks((file) => {
      const task = file.tasks.find((candidate) => candidate.id === id);
      if (!task) throw new AgentBusError("unknown-task", `no task with id ${id}`);
      if (task.owner && task.owner !== agent && task.status === "claimed") {
        throw new AgentBusError("already-claimed", `task ${id} is already owned by ${task.owner}`);
      }
      task.owner = agent;
      task.status = "claimed";
      task.updatedAt = now().toISOString();
      return task;
    });
  }

  async function updateTask(
    id: string,
    patch: UpdateTaskInput,
    agent: AgentId,
  ): Promise<AgentTask> {
    return mutateTasks((file) => {
      const task = file.tasks.find((candidate) => candidate.id === id);
      if (!task) throw new AgentBusError("unknown-task", `no task with id ${id}`);
      if (patch.status) task.status = patch.status;
      if (patch.assignee) task.assignee = patch.assignee;
      if (patch.paths) task.paths = patch.paths;
      if (patch.note) {
        task.notes.push({ ts: now().toISOString(), agent, text: patch.note });
      }
      if (patch.status === "done" || patch.status === "cancelled") {
        task.owner = undefined;
      }
      task.updatedAt = now().toISOString();
      return task;
    });
  }

  /**
   * Files another agent already claimed. This is the guard that keeps two
   * agents from editing the same file at the same time.
   */
  async function pathConflicts(candidatePaths: string[], agent: AgentId): Promise<PathConflict[]> {
    const wanted = new Set(candidatePaths.map(normalizePath));
    const conflicts: PathConflict[] = [];
    for (const task of await tasks()) {
      if (task.status !== "claimed" || !task.owner || task.owner === agent) continue;
      const overlap = task.paths.filter((path) => wanted.has(normalizePath(path)));
      if (overlap.length > 0) conflicts.push({ task, paths: overlap });
    }
    return conflicts;
  }

  return {
    paths,
    init,
    isInitialized,
    list,
    thread,
    post,
    readCursor,
    unread,
    drain,
    tasks,
    addTask,
    claimTask,
    updateTask,
    pathConflicts,
  };
}

function safeParseMessage(line: string): AgentMessage | undefined {
  try {
    const parsed = AgentMessageSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function normalizePath(path: string) {
  return path.replace(/^\.\//, "").replace(/\/+$/, "");
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readFileOrEmpty(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function writeJsonAtomic(path: string, value: unknown) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function withTaskLock<T>(
  paths: BusPaths,
  options: { lockTimeoutMs: number; lockStaleMs: number },
  run: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + options.lockTimeoutMs;
  for (;;) {
    try {
      const handle = await open(paths.tasksLock, "wx");
      await handle.writeFile(String(process.pid), "utf8");
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isStaleLock(paths.tasksLock, options.lockStaleMs)) {
        await rm(paths.tasksLock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AgentBusError(
          "lock-timeout",
          `could not acquire ${paths.tasksLock} within ${options.lockTimeoutMs}ms`,
        );
      }
      await delay(25);
    }
  }

  try {
    return await run();
  } finally {
    await rm(paths.tasksLock, { force: true });
  }
}

async function isStaleLock(path: string, staleMs: number) {
  try {
    const stats = await stat(path);
    return Date.now() - stats.mtimeMs > staleMs;
  } catch {
    return false;
  }
}
