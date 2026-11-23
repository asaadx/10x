# 10x

A Kanban board for engineering tickets (React + Vite frontend, zero-dependency Node backend, SQLite).
Moving a ticket to In Progress spawns an OMP coding agent in its own Herdr pane, git worktree and port block; Accept pushes the branch and opens a PR on GitHub.

## Quickstart

Prerequisites:

- Node `>=24`
- pnpm, via corepack (the version is pinned in `package.json`)
- [Herdr](https://herdr.dev) running, with OMP available to it (socket defaults to `~/.config/herdr/herdr.sock`)
- A fine-grained GitHub token: Contents + Pull requests write, Metadata read

```bash
corepack enable
cp .env.example .env    # set GITHUB_TOKEN; every other variable has a default
pnpm install
```

Run it:

```bash
pnpm dev     # API on :4010, Vite dev server on http://localhost:5173
pnpm start   # builds the frontend, then serves the board on http://localhost:4010
```

`PORT` (default `4010`), `STATE_DIR` (default `~/.10x`) and `HERDR_SOCKET_PATH` are optional overrides in `.env`.

Checks: `pnpm typecheck && pnpm test`. `pnpm e2e` is agent-free but needs a live Herdr socket and port 4310; never run `pnpm e2e:full` casually, it spawns real agents.
