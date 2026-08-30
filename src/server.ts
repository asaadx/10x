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
import { spawn, teardown } from "./runner.ts";
import { branchFor } from "./lifecycle.ts";
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

type ListedWorktree = { branch: string | null; path: string; is_linked_worktree?: boolean };

async function handle(method: string, path: string) {
  if (method === "GET" && path === "/tickets") {
    const listed = await request<{ worktrees: ListedWorktree[] }>("worktree.list", {
      cwd: REPO,
    }).catch(() => ({ worktrees: [] }));

    const ours = new Set(tickets.map((t) => branchFor(t.project, t.number)));

    return json({
      repo: REPO,
      tickets: tickets.map((t) => ({
        id: `${t.project}-${t.number}`,
        title: t.title,
        status: t.status,
        agentStatus: t.agentStatus,
        finished: t.finished,
        died: t.died,
        error: t.error,
        branch: t.branch,
        worktreePath: t.worktreePath,
        paneId: t.paneId,
        busy: inFlight.has(`${t.project}-${t.number}`),
        /* Derived from Herdr, not from our own store — the read model in §5.2. */
        hasWorktree: listed.worktrees.some((w) => w.branch === branchFor(t.project, t.number)),
        diagnostics: t.diagnostics,
      })),
      /**
       * Linked worktrees Herdr knows about that no ticket claims. Reported only —
       * reconciliation never deletes (§5.2). Non-ticket branches are excluded entirely
       * rather than listed, so a hand-made worktree is never even a candidate.
       */
      unowned: listed.worktrees
        .filter((w) => w.is_linked_worktree !== false)
        .filter((w) => w.branch?.startsWith("ticket/") && !ours.has(w.branch))
        .map((w) => ({ branch: w.branch, path: w.path })),
    });
  }

  const spawnMatch = /^\/tickets\/([^/]+)\/spawn$/.exec(path);
  const cancelMatch = /^\/tickets\/([^/]+)\/cancel$/.exec(path);
  const dropWorktreeMatch = /^\/tickets\/([^/]+)\/worktree$/.exec(path);
  const id = spawnMatch?.[1] ?? cancelMatch?.[1] ?? dropWorktreeMatch?.[1];
  const isDrop = dropWorktreeMatch !== null && method === "DELETE";
  if (!id || (method !== "POST" && !isDrop)) return json({ error: "not_found" }, 404);

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
    ticket.died = false;
    ticket.agentStatus = null;

    try {
      // §4.1: the FIRST `idle` arrives before the prompt, so it is not completion.
      // Only honour idle/done once a `working` turn has actually been observed.
      let sawWorking = false;
      const res = await spawn(
        ticket,
        REPO,
        (status) => {
          ticket.agentStatus = status;
          if (status === "working") {
            sawWorking = true;
            ticket.finished = false;
          } else if (sawWorking && (status === "idle" || status === "done")) {
            ticket.finished = true;
          }
        },
        () => {
          // §5.0 rule 3: a dead pane is NOT a finished ticket. Keep the worktree and the
          // transcript so the failure can be inspected; surface it instead of tearing down.
          ticket.died = true;
          ticket.finished = false;
          ticket.agentStatus = null;
          console.warn(`[${id}] pane exited — run is dead, worktree kept for inspection`);
        },
      );
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

  if (isDrop) {
    // §5.0 "Manual remove worktree": the escape hatch for a crashed or abandoned run
    // whose commits matter. Reclaims the disk, KEEPS the branch, so nothing is lost.
    inFlight.add(id);
    try {
      await teardown(ticket, REPO, false);
      ticket.status = "backlog";
      ticket.died = false;
      ticket.finished = false;
      ticket.agentStatus = null;
      ticket.worktreePath = null;
      ticket.paneId = null;
      ticket.workspaceId = null;
      return json({ ok: true, branchKept: ticket.branch });
    } catch (err) {
      ticket.error = err instanceof Error ? err.message : String(err);
      return json({ error: ticket.error }, 500);
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
    ticket.died = false;
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
