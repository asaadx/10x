/**
 * Minimal test harness for the Backlog <-> In Progress transition.
 *
 * Three endpoints (memory/herdr-omp-lifecycle.md §7):
 *   POST /tickets/:id/spawn   Backlog -> In Progress: claim, then the four spawn calls
 *   POST /tickets/:id/cancel  In Progress -> Backlog: teardown
 *   GET  /tickets             board state + race diagnostics
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "./herdr.ts";
import { branchFor, spawn, teardown } from "./runner.ts";
import { claim, findTicket, freshDiagnostics, tickets } from "./tickets.ts";

const PORT = Number(process.env.PORT ?? 4010);
/**
 * NEVER point this at the 10x repo itself: an agent committing here would restart
 * the backend mid-flight and strand tickets (§9). Override with TARGET_REPO.
 */
const REPO = process.env.TARGET_REPO ?? join(process.env.HOME ?? "", "scratch", "10x-target");
const UI = join(import.meta.dirname, "..", "public", "index.html");

/** Ticket ids currently mid-operation. Rejecting beats queuing: the conflict stays visible. */
const inFlight = new Set<string>();

const json = (body: unknown, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function handle(method: string, path: string) {
  if (method === "GET" && path === "/tickets") {
    const worktrees = await request<{ worktrees: { branch: string | null; path: string }[] }>(
      "worktree.list",
      { cwd: REPO },
    ).catch(() => ({ worktrees: [] }));

    return json({
      repo: REPO,
      tickets: tickets.map((t) => ({
        id: `${t.project}-${t.number}`,
        title: t.title,
        status: t.status,
        agentStatus: t.agentStatus,
        finished: t.finished,
        error: t.error,
        branch: t.branch,
        worktreePath: t.worktreePath,
        paneId: t.paneId,
        busy: inFlight.has(`${t.project}-${t.number}`),
        /* Derived from Herdr, not from our own store — the read model in §5.2. */
        hasWorktree: worktrees.worktrees.some((w) => w.branch === branchFor(t)),
        diagnostics: t.diagnostics,
      })),
    });
  }

  const spawnMatch = /^\/tickets\/([^/]+)\/spawn$/.exec(path);
  const cancelMatch = /^\/tickets\/([^/]+)\/cancel$/.exec(path);
  const id = spawnMatch?.[1] ?? cancelMatch?.[1];
  if (method !== "POST" || !id) return json({ error: "not_found" }, 404);

  const ticket = findTicket(id);
  if (!ticket) return json({ error: "no_such_ticket", id }, 404);
  if (inFlight.has(id)) return json({ error: "operation_in_flight", id }, 409);

  if (spawnMatch) {
    // Claim first, work second. No `await` between the check and the write (§9).
    if (!claim(ticket, "backlog", "in_progress")) {
      return json({ error: "not_in_backlog", status: ticket.status }, 409);
    }
    inFlight.add(id);
    ticket.diagnostics = freshDiagnostics();
    ticket.error = null;
    ticket.finished = false;
    ticket.agentStatus = null;

    try {
      // §4.1: the FIRST `idle` arrives before the prompt, so it is not completion.
      // Only honour idle/done once a `working` turn has actually been observed.
      let sawWorking = false;
      const res = await spawn(ticket, REPO, (status) => {
        ticket.agentStatus = status;
        if (status === "working") {
          sawWorking = true;
          ticket.finished = false;
        } else if (sawWorking && (status === "idle" || status === "done")) {
          ticket.finished = true;
        }
      });
      ticket.branch = res.branch;
      ticket.worktreePath = res.worktreePath;
      ticket.paneId = res.paneId;
      ticket.workspaceId = res.workspaceId;
      return json({ ok: true, ...res, diagnostics: ticket.diagnostics });
    } catch (err) {
      ticket.status = "backlog"; // release the claim; any worktree shows up in /tickets
      ticket.error = err instanceof Error ? err.message : String(err);
      return json({ error: ticket.error, diagnostics: ticket.diagnostics }, 500);
    } finally {
      inFlight.delete(id);
    }
  }

  if (!claim(ticket, "in_progress", "backlog")) {
    return json({ error: "not_in_progress", status: ticket.status }, 409);
  }
  inFlight.add(id);
  try {
    // Cancel is deliberately destructive: discard the worktree and the branch (§5.0).
    await teardown(ticket, REPO, true);
    ticket.agentStatus = null;
    ticket.finished = false;
    ticket.branch = null;
    ticket.worktreePath = null;
    ticket.paneId = null;
    ticket.workspaceId = null;
    return json({ ok: true });
  } catch (err) {
    ticket.error = err instanceof Error ? err.message : String(err);
    return json({ error: ticket.error }, 500);
  } finally {
    inFlight.delete(id);
  }
}

createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(await readFile(UI, "utf8"));
    return;
  }

  try {
    const out = await handle(req.method ?? "GET", path);
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}).listen(PORT, () => {
  console.log(`10x harness → http://localhost:${PORT}`);
  console.log(`target repo  → ${REPO}`);
});
