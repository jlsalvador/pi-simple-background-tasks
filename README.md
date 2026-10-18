# pi-simple-background-tasks

**Durable background shell tasks for Pi.**

A KISS fork of [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks). It keeps the core — running long shell jobs in the background without blocking the session. See [FORK-CHANGES.md](FORK-CHANGES.md) for the full list of changes relative to upstream and how to re-check the divergence.

## Features

- **Run long jobs without blocking**: start a named shell command in the background, keep talking to Pi, and get a completion notification in chat when it finishes.
- **Durable tasks**: task state is persisted under `~/.pi/agent/tasks`, and every task spawns detached, so a same-process `/reload` or a full Pi restart never kills a running task — the next activation adopts it from disk.
- **Deliberate lifecycle**: a Pi session shutdown kills running tasks by design; `/reload`, crashes and restarts never do.
- **Task manager overlay**: a TUI panel lists running and recent tasks with status and bounded output (default **Shift↓**); **f** toggles fullscreen, **w** wraps long output lines.
- **Cross-platform**: POSIX (own process group, `-pgid` kill authority) and Windows (detached via a WMI-created outer process, `taskkill /T /F` tree ownership, `cmd`-runner exit markers).

## Install

```bash
# Default install (npm)
pi install npm:pi-simple-background-tasks

# Project-local install (npm)
pi install -l npm:pi-simple-background-tasks

# Or from the git main branch
pi install git:github.com/jlsalvador/pi-simple-background-tasks@main
```

## Quick start

1. Start a background command:

   ```text
   /bg --name "Typecheck watch" npm run typecheck -- --watch
   ```

   `/bg` starts a tracked shell command and returns the task id plus output path. User-launched `/bg` tasks notify in the UI but do not automatically wake a follow-up model turn. Tasks survive `/reload` and Pi restarts unconditionally; quitting the agent kills them.

2. List tasks or open the task manager:

   ```text
   /jobs
   ```

3. Read bounded output only when you need it:

   ```text
   /logs b12ab34c 20000
   ```

## Tools

| Tool | Purpose |
| --- | --- |
| `bg_run` | Start a background shell command and return a task id plus output path. |
| `bg_status` | Inspect one task, or list running and recent tasks. |
| `bg_logs` | Read bounded output from a task. |
| `bg_kill` | Stop a running task. |
| `bg_clean` | Delete finished tasks to free disk space. Only terminal tasks are removed; running tasks are reported and left alone. Scope: one task by ID, this session (default), or the whole folder. |

## Commands

| Command | Purpose |
| --- | --- |
| `/bg [--name "name"] <command>` | Start a tracked shell command. |
| `/jobs` | List running and recent tasks. |
| `/tasks [id]` | Open the task manager overlay. |
| `/logs <id> [maxBytes]` | Show bounded output from a task. |
| `/kill <id>` | Stop a running task. |
| `/clean [session\|all\|<id>]` | Delete finished tasks: one, this session (default), or all. |

**Shift↓** and **Ctrl+Alt+B** both open the task manager.

## Configuration

Configuration follows the PI extension-config pattern. Create `pi-background-tasks.json` in the global or project location; project keys override global keys, and absent keys keep their defaults.

| Location | Path |
| --- | --- |
| Global | `~/.pi/agent/extensions/pi-background-tasks.json` |
| Project | `.pi/pi-background-tasks.json` |

| Key | Type | Default |
| --- | --- | --- |
| `tasksDir` | string path | `~/.pi/agent/tasks` |

Example:

```json
{
  "tasksDir": "~/my-tasks"
}
```

## Development

```bash
npm install
npm run check   # tsc --noEmit && biome check .
npm run fix     # biome check --write .
npm test        # registry platform suite (tests/), run per-platform
```

`npm test` verifies the detached-task promises (survival across a real parent
exit, adoption, kills) with `node:test` against processes it genuinely spawns.
Run it on the platform whose behavior you want to verify: on POSIX it exercises
process groups and the group kill; on Windows it exercises WMI-created tasks,
the cmd runner and `taskkill /T /F`. Only the platform-specific pieces skip.

## License

ISC — see [LICENSE](LICENSE).
