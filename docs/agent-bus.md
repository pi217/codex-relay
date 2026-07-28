# Agent Bus

A file-backed mailbox that lets two agents — Claude Code and Cowork — work on
this repository at the same time without a human relaying messages between two
windows.

Everything lives in `.coop/` in the project root, so the bus needs no server, no
port, and no network. Both agents must see the same working copy on the same
machine.

## Turning it on

```sh
pnpm agent-bus init
```

This creates `.coop/`. Until that directory exists the committed hooks are
inert, so cloning the repository does not start any background chatter.

`.coop/` is git-ignored. It is a scratch channel between two running agents, not
project history.

## What is inside

```
.coop/
  messages.jsonl     append-only message log
  tasks.json         work items, with owner and claimed file paths
  cursors/<agent>.json  how far each agent has read
```

Messages are append-only, so no agent can rewrite what another one said. Each
agent has its own cursor file, which means two agents never write to the same
file when they read their inbox. `tasks.json` is the only shared mutable file
and is protected by a lock file with stale-lock recovery.

## The automatic part

The bus is only useful if nobody has to remember it. Two hooks in
`.claude/settings.json` do that for Claude Code:

| Hook           | What it does                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart` | Drains the inbox and prints it. Claude Code puts hook stdout into the session context, so a session starts already knowing what the other agent said. |
| `Stop`         | Posts a turn-finished status with the current branch and changed-file count.                                                                          |

The `Stop` hook deliberately posts a _signal_, not the answer text: the hook
payload does not contain the turn content, and a precise "finished on branch X
with N changed files" is more actionable than a guess.

Both commands use a plain relative path and no shell variables. Claude Code
runs hooks from the project directory, and it spawns PowerShell on Windows,
where `$CLAUDE_PROJECT_DIR` would be read as an undefined PowerShell variable
and expand to nothing. `node scripts/agent-bus.mjs` means the same thing in
bash, cmd, and PowerShell. The launcher resolves the project root from its own
location, so nothing downstream depends on the caller's shell.

Cowork has no local hooks, so the same discipline is carried by the `agent-bus`
skill in `.agents/skills/agent-bus/SKILL.md`: read the inbox when a task starts,
post when a result exists, claim files before editing them.

## Commands

```sh
pnpm -s agent-bus post --from cowork --to claude-code --kind task \
  --subject "Wire the export endpoint" --body "Spec is in docs/export.md" \
  --ref docs/export.md

pnpm -s agent-bus read  --agent claude-code    # peek, cursor stays put
pnpm -s agent-bus drain --agent claude-code    # read and advance the cursor

pnpm -s agent-bus tasks
pnpm -s agent-bus task add --title "Router rewrite" --by cowork \
  --for claude-code --path packages/codex-relay/src/app.ts
pnpm -s agent-bus task claim <task-id> --agent claude-code
pnpm -s agent-bus task update <task-id> --agent claude-code --status done --note "shipped"

pnpm -s agent-bus check --agent claude-code --path packages/codex-relay/src/app.ts
```

`--body -` reads the body from stdin, `--body-file <path>` from a file. Add
`--json` for machine-readable output. `--root <path>` or
`CODEX_AGENT_BUS_ROOT` points the CLI at a different project.

## File ownership

The expensive failure mode with two agents is not a missed message, it is both
of them editing the same file. `task claim` records who owns which paths, and
`check` exits non-zero when a path is owned by someone else:

```sh
$ pnpm -s agent-bus check --agent claude-code --path packages/codex-relay/src/app.ts
cowork owns packages/codex-relay/src/app.ts via task tsk_0001 (Router rewrite)
$ echo $?
1
```

Claims are released automatically when a task moves to `done` or `cancelled`.

## Loop protection

Two agents that answer each other automatically will keep going until something
stops them. Two limits do that:

- A reply chain stops at depth 8 (`--reply-to` increases the depth).
- A thread stops at 60 messages.

Both raise an `AgentBusError` instead of posting, which surfaces to the agent as
a failed command rather than a silent drop.

## Extending it beyond one machine

The store, schema, and loop guards do not assume a filesystem. To reach a
Cowork instance on another machine, keep this data model and put it behind the
relay server in `packages/codex-relay`: `/bus/*` routes for post and read, SSE
for delivery, reusing the existing pairing token for auth. The CLI and the skill
would then talk to that endpoint instead of `.coop/`, and nothing else changes.
