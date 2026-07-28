import { z } from "zod";

/**
 * Reserved recipient that every agent receives.
 */
export const ALL_AGENTS = "all";

export const AgentIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, "agent ids use lowercase letters, digits, and dashes");

export const MessageKindSchema = z.enum(["task", "result", "question", "answer", "status", "note"]);

export const AgentMessageSchema = z.object({
  id: z.string().min(1),
  ts: z.string().min(1),
  threadId: z.string().min(1),
  from: AgentIdSchema,
  to: AgentIdSchema,
  kind: MessageKindSchema,
  subject: z.string().trim().min(1).max(200),
  body: z.string().default(""),
  refs: z.array(z.string().trim().min(1)).default([]),
  replyTo: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  depth: z.number().int().min(0).default(0),
});

export const TaskStatusSchema = z.enum(["open", "claimed", "blocked", "done", "cancelled"]);

export const TaskNoteSchema = z.object({
  ts: z.string().min(1),
  agent: AgentIdSchema,
  text: z.string().trim().min(1),
});

export const AgentTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  status: TaskStatusSchema.default("open"),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  createdBy: AgentIdSchema,
  assignee: AgentIdSchema.optional(),
  owner: AgentIdSchema.optional(),
  paths: z.array(z.string().trim().min(1)).default([]),
  notes: z.array(TaskNoteSchema).default([]),
  threadId: z.string().min(1).optional(),
});

export const TaskFileSchema = z.object({
  version: z.literal(1).default(1),
  tasks: z.array(AgentTaskSchema).default([]),
});

export const CursorSchema = z.object({
  agent: AgentIdSchema,
  lastReadId: z.string().min(1).optional(),
  lastReadAt: z.string().min(1).optional(),
  readCount: z.number().int().min(0).default(0),
});

export type AgentId = z.infer<typeof AgentIdSchema>;
export type MessageKind = z.infer<typeof MessageKindSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type AgentTask = z.infer<typeof AgentTaskSchema>;
export type TaskFile = z.infer<typeof TaskFileSchema>;
export type Cursor = z.infer<typeof CursorSchema>;

export function isVisibleTo(message: AgentMessage, agent: AgentId) {
  if (message.from === agent) return false;
  return message.to === agent || message.to === ALL_AGENTS;
}
