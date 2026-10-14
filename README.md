# pi-simple-background-tasks

**Durable background shell tasks for Pi.**

A KISS fork of [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks). It keeps the core — running long shell jobs in the background without blocking the session.

## Features

- **Run long jobs without blocking**: start a named shell command in the background, keep talking to Pi, and get a completion notification in chat when it finishes.
- **Durable tasks**: task state is persisted under `~/.pi/agent/tasks`, so it survives session restarts.
- **Task manager overlay**: a TUI panel lists running and recent tasks with status and bounded output (default **Shift↓**).
- **Survive Pi reloads**: opt in to keeping a shell task alive across a same-process `/reload`.
- **Cross-platform**: POSIX shell and Windows (process-group kill).

## Install

```bash
# Global install from the git main branch
pi install git:github.com/jlsalvador/pi-simple-background-tasks@main

# Project-local install from git
pi install git:github.com/jlsalvador/pi-simple-background-tasks@main -l
```

## Quick start

1. Start a background command:

   ```text
   /bg --name "Typecheck watch" npm run typecheck -- --watch
   ```

   `/bg` starts a tracked shell task and returns the task id plus output path. User-launched `/bg` tasks notify in the UI but do not automatically wake a follow-up model turn. Add one leading `--survive-reload` only when the shell process must keep running across a same-process `/reload`.

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

## Commands

| Command | Purpose |
| --- | --- |
| `/bg [--survive-reload] [--agent] [--name "name"] <command>` | Start a tracked shell command. |
| `/jobs` | List running and recent tasks. |
| `/tasks [id]` | Open the task manager overlay. |
| `/logs <id> [maxBytes]` | Show bounded output from a task. |
| `/kill <id>` | Stop a running task. |

The default **Shift↓** shortcut opens the task manager (configurable).

## Configuration

Configuration follows the PI extension-config pattern. Create `pi-background-tasks.json` in the global or project location; project keys override global keys, and absent keys keep their defaults.

| Location | Path |
| --- | --- |
| Global | `~/.pi/agent/extensions/pi-background-tasks.json` |
| Project | `.pi/pi-background-tasks.json` |

| Key | Type | Default |
| --- | --- | --- |
| `tasksDir` | string path | `~/.pi/agent/tasks` |
| `dockShortcut` | `"shift+down"` / `"ctrl+alt+b"` / `"off"` | `"shift+down"` |

Example:

```json
{
  "tasksDir": "~/my-tasks",
  "dockShortcut": "ctrl+alt+b"
}
```

## Development

```bash
npm install
npm run check   # tsc --noEmit && biome check .
npm run fix     # biome check --write .
```

## License

ISC — see [LICENSE](LICENSE).
