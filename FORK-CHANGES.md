# Fork changes: pi-simple-background-tasks vs pi-background-tasks

This package is a **KISS fork** of
[pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks).

## Fork base and comparison versions

- **Fork base**: upstream `v2.6.9`, commit `4aceb55`.
  The first commit of this repo (`990d60a`, "Import pi-background-tasks 2.6.9 as the fork base") is byte-identical to that upstream commit.
- **Upstream at last comparison** (2026-10-17): `v2.6.10`, commit `799182f`.
- **Commits in upstream after the fork base**: 4 — see "Upstream since the fork base" below. None are adopted.

## Divergence summary

Relative to the 2.6.9 source, the fork changes **69 files (34,235 lines removed, 5,275 added)**, ending with **14 source files** plus a 3-file `node:test` platform suite:

| Subsystem (as in 2.6.9) | Fork |
| --- | --- |
| Background-task core: `registry`, `common`, `extension-api`, `durable-fs`, `task-durable`, `shell-policy`, `windows-taskkill`, `ui/background-tasks-manager` | **Kept, simplified** |
| `reload-shell-owner` (lease/nonce handoff protocol for reload survival) | **Removed** — replaced by the detached-spawn design below |
| Fusion workflows (`src/core/fusion/*` + `fusion-extension.ts` + `fusion-child-extension.ts` + `ui/fusion-model-selector.ts`) | **Removed** (~15k lines) |
| Delegate (`src/core/delegate/*` + `delegate-extension.ts` + `delegate-child-extension.ts`) | **Removed** (~5k lines) |
| Claude/Anthropic impersonation (`anthropic-attribution*.ts`) | **Removed** (~3.7k lines) |
| Attested Pi runs (`attested-pi-*.ts`) | **Removed** (~1k lines) |
| Context projection & budgeting (`src/core/context/*`) | **Removed** (~1.6k lines) |
| Pi-agent telemetry (`isAgent` end-to-end) | **Removed** |
| Dead EventBus request layer | **Removed** |
| Update check + footer update hint (`update-check.ts`) | **Removed** |
| TUI footer + seen/unread task state | **Removed** |
| `/bg-tasks` alias | **Removed** |
| `pi-launch.ts`, `canonical-json.ts`, `BACKGROUND-TASKS-INSTRUCTIONS.md` | **Removed** |

## What the fork adds / changes

- **Single detached task path, survival without flags** — every task spawns fully detached: on POSIX in its own process group (no pipes, no in-process ownership); on Windows as an outer process created **by the WMI service** (`Win32_Process.Create`), because direct children of the Pi process — no matter how detached — die together with it through job/console-session teardown (reproduced on a real Windows 11 VM with `taskkill /F` on the Pi process; WMI-created processes survive it). Ownership facts (pid, pgid, wrapper-written `<id>.exit` marker) live in the on-disk metadata and the extension holds no output file descriptors: the spawned command itself redirects output and the wrapper records the exit code. Each activation adopts still-running records from disk; a same-process `/reload` or a full Pi restart never kills a running task, and a Pi session shutdown kills it deliberately. Upstream's `reload-shell-owner` lease/handoff protocol (`--survive-reload`) was removed along with its ~1.5k lines: there is exactly one launch path and nothing to negotiate per task.

- **One Windows kill: `taskkill /T /F`** — the old two-phase ladder (graceful `taskkill /T` window-close termination, then `/F` escalation after a grace timer) is gone: console applications do not honor window-close termination, so the graceful phase could neither stop anything on Windows nor leave time to escalate during a session shutdown (the Pi process would exit first and the un-ref'd escalation timer would die with it). One forced tree kill, outcome checked once. Cap/timeout notices are appended after the tree is terminated because the child's own `1>` redirection holds the output file locked until then.

- **Platform test suite** (`npm test`) — `tests/registry.test.ts` runs the registry against real processes on the platform it is executed on, with the node:test runner through tsx (no new dependencies): completion/exit markers, quoting, timeout and cap kills, detachment across a genuine parent exit, adoption of a dead activation's records, kill of adopted tasks with notification, and no-adoption of terminal records. The two launch races it found — reaping a task while its WMI spawn is still in flight, and flood bytes overwriting cap/timeout notices — had product fixes (see the git history). All tests pass on Linux (8 run, 1 windows-only skip) and on a real Windows 11 VM (8 run, 1 posix-only skip).

- **`/clean` command + `bg_clean` tool** — delete finished tasks (`session` / `all` / `<id>`). New file `src/core/task-cleanup.ts`; empty run directories are removed after cleanup (tasks live under `~/.pi/agent/tasks`).
- **Task runtime moved to `~/.pi/agent/tasks`** with the PI extension-config pattern (`pi-background-tasks.json`, `tasksDir`).
- **KISS packaging** — single entry point `src/extension.ts`, no `dist/`, no docs tree; one `node:test` platform suite under `tests/` (`npm test`, not shipped to npm); fork identity in `package.json`.
- **Task manager UI** — opens top-right as a fixed 96-column modal (96 % width left the box stuck left on wide terminals); `d` deletes the selected task; both shortcuts registered (Shift↓ / Ctrl+Alt+B); footer options contextual to the selected task; empty-state footer shows only sensible actions; task detail adapts to terminal height (modal title dropped); **f** toggles fullscreen (gated on terminal size), **w** toggles output wrap.
- **`--agent` flag** removed from `/bg` (stale).
- **Lazy module loader simplified.**
- **Dependencies** — pi `^1.3.0`, TypeScript `^7.0.2`, `@types/node ^26.6.5`, tsx `^4.23.15`, typebox `^1.4.2`; peer ranges broadened to `|| ^1.0.0` (installs on pi 1.x, still accepts 0.81.1–0.84.0).
- **biome** lint/format + `tsconfig.json` for `tsc --noEmit`.

## Upstream since the fork base (2.6.9 → 2.6.10)

Checked 2026-10-17. All 4 commits are about one new subsystem, **host-api**: an optional EventBus API (request / response / changed channels, leases, cursors, `~1.8k` lines of code plus docs and tests) for **native front ends** (desktop or mobile job panels). Its own docs state it does **not** change the TUI, the registered tools/commands, the dock, notifications or wake-up behavior.

**Not adopted** — it targets a surface this fork does not ship, and its size/complexity contradict the KISS design.

| Commit | What it is | Adopted |
| --- | --- | --- |
| `7781fe3` | land host-api: `host-api.ts`, `host-protocol.ts`, `host-results.ts`, docs, tests | No |
| `1857b3c` | test(host-api): freeze background UI contract and terminal guard | No |
| `9923a95` | test(host-api): correct passing group count label | No |
| `799182f` | chore(release): bump version to 2.6.10 | n/a (this fork uses its own 0.x versioning) |

## Re-checking the divergence

```bash
# inside this repo — everything this fork changed since the import:
git diff --stat 990d60a7f0db3b61af80daf9d35607ff90009d75..HEAD

# from any clone of ismailsaleekh/pi-background-tasks — what upstream
# has done since the fork base (4aceb55):
git log --oneline 4aceb55..main
git diff --stat 4aceb55 main
```
