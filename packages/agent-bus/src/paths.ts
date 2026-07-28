import { resolve } from "node:path";

export const BUS_DIRECTORY_NAME = ".coop";

export type BusPaths = {
  root: string;
  directory: string;
  messages: string;
  tasks: string;
  tasksLock: string;
  cursors: string;
  cursorFor(agent: string): string;
};

export function createBusPaths(root: string): BusPaths {
  const directory = resolve(root, BUS_DIRECTORY_NAME);
  const cursors = resolve(directory, "cursors");
  return {
    root: resolve(root),
    directory,
    messages: resolve(directory, "messages.jsonl"),
    tasks: resolve(directory, "tasks.json"),
    tasksLock: resolve(directory, "tasks.lock"),
    cursors,
    cursorFor(agent) {
      return resolve(cursors, `${agent}.json`);
    },
  };
}
