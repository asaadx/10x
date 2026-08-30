/**
 * Resilience and concurrency: a backend restart, the compare-and-swap that makes status the
 * lock, and two agents running at the same time (gap G3 in memory/gotchas.md).
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  api,
  cleanupAll,
  closePane,
  createProject,
  createTicket,
  liveAgentNames,
  liveWorktreeBranches,
  makeRepo,
  postSpawn,
  PROBE_CONTENT,
  PROBE_DESCRIPTION,
  PROBE_FILE,
  requireHerdr,
  restartBoard,
  spawnTicket,
  startBoard,
  storedTicket,
  ticketRow,
  waitForTicket,
  type Board,
} from "./fixtures.ts";

const SPAWN_MS = 120_000;
const COMPLETION_MS = 180_000;
/** Leaves the rest of the per-test budget for spawning and teardown. */
const FINISH_MS = 120_000;

let board: Board;
let repoPath: string;

test.beforeAll(async () => {
  requireHerdr();
  board = await startBoard();
  repoPath = await makeRepo();
});

test.afterAll(async () => {
  await cleanupAll();
});

test("a finished ticket survives a backend restart on the same state dir", async ({ page }) => {
  test.setTimeout(COMPLETION_MS);
  await createProject(board, "rstr", repoPath);
  const id = await createTicket(board, "rstr", "Survives a restart", PROBE_DESCRIPTION);

  const run = await spawnTicket(board, repoPath, id);
  await waitForTicket(board, id, "reported finished", (t) => t["finished"] === true, FINISH_MS);

  // Herdr keeps the pane and the agent; only our process goes away and comes back.
  board = await restartBoard(board);

  // `finished` is a column, not per-run memory, so it has to come back with the row. A
  // finished agent triggers nothing at all — no teardown, no column change (memory/teardown.md
  // rule 2) — so the ticket must still be In Progress and still marked finished.
  expect(storedTicket(board, id)).toMatchObject({ status: "in_progress", branch: run.branch });
  const row = await ticketRow(board, id);
  expect(row).toMatchObject({ status: "in_progress", finished: true, died: false });

  // Read live from Herdr by the NEW process, which is the actual re-attach evidence: a
  // re-attached agent reports `done` rather than `idle`, and both mean the turn ended
  // (memory/agent-status.md). Accepting only `idle` is what broke this path once.
  expect(["idle", "done"]).toContain(row["agentStatus"]);
  expect(row["hasWorktree"]).toBe(true);
  expect(existsSync(join(run.worktreePath, PROBE_FILE))).toBe(true);

  await page.goto(board.baseUrl);
  const card = page.locator(`#in-progress-cards [data-id="${id}"]`);
  await expect(card).toContainText(run.branch);
  await expect(card.getByTitle("finished")).toBeVisible();

  // The claim survived with the row, so pressing Start again is rejected rather than
  // re-attaching. memory/teardown.md's re-dispatch route — "a backend restart resets every
  // ticket to Backlog" — belongs to the in-memory store and is gone.
  const again = await api(board, "POST", `/tickets/${id}/spawn`);
  expect(again.status).toBe(409);
  expect(again.body["error"]).toBe("not_in_backlog");

  expect((await api(board, "POST", `/tickets/${id}/cancel`)).status).toBe(200);
});

/*
 * Regression: a pane exit used to write `finished: false` unconditionally, which is right for an
 * agent killed mid-turn and wrong for a pane that goes away long after the turn ended. Closing a
 * tab, restarting Herdr or rebooting all erased a completion that had been correctly observed.
 */
test("closing the pane after the turn finished keeps the ticket finished", async ({ page }) => {
  test.setTimeout(COMPLETION_MS);
  await createProject(board, "pncl", repoPath);
  const id = await createTicket(board, "pncl", "Finished, then closed", PROBE_DESCRIPTION);

  const run = await spawnTicket(board, repoPath, id);
  await waitForTicket(board, id, "reported finished", (t) => t["finished"] === true, FINISH_MS);

  await closePane(run.paneId);

  // `died` is honest — the pane really is gone — and it is what proves the event landed rather
  // than the test having simply not waited long enough. `finished` must survive alongside it.
  const row = await waitForTicket(board, id, "reported died", (t) => t["died"] === true, 30_000);
  expect(row["finished"]).toBe(true);

  await page.goto(board.baseUrl);
  const card = page.locator(`#in-progress-cards [data-id="${id}"]`);
  // The user's rule: finished-then-closed looks finished. Badge `title`s are the only accessible
  // handle a card has, and memory/architecture.md forbids widening these assertions to classes or
  // text layout because a redesign is planned. The cross is a sufficient proxy for the whole death
  // presentation: it, the "This is NOT a finished ticket" note and the red border are all rendered
  // off the same `died && !finished`.
  await expect(card.getByTitle("finished")).toBeVisible();
  await expect(card.getByTitle("run died")).toHaveCount(0);

  expect((await api(board, "POST", `/tickets/${id}/cancel`)).status).toBe(200);
});

test("two concurrent spawns of one ticket: exactly one claim wins", async () => {
  test.setTimeout(SPAWN_MS);
  await createProject(board, "cas", repoPath);
  const id = await createTicket(board, "cas", "Claimed once", PROBE_DESCRIPTION);

  // Concurrent, not sequential: sequential requests would pass even with the check-then-act
  // race the conditional UPDATE exists to close.
  const [first, second] = await Promise.all([
    postSpawn(board, repoPath, id),
    postSpawn(board, repoPath, id),
  ]);

  expect([first.status, second.status].sort()).toEqual([200, 409]);
  const loser = first.status === 409 ? first : second;
  /*
   * Both codes are correct rejections of the same race, and which one appears depends on
   * whether the winner had reached its in-flight guard yet: `not_in_backlog` means the
   * conditional UPDATE matched no row, `operation_in_flight` means the per-ticket guard
   * caught it first. What matters is that the loser is REJECTED rather than queued
   * (memory/operations.md).
   */
  expect(["not_in_backlog", "operation_in_flight"]).toContain(loser.body["error"]);

  // Claim-then-work is the invariant: one claim means one worktree and one agent.
  const branches = await liveWorktreeBranches(repoPath);
  expect(branches.filter((b) => b.startsWith("ticket/cas/"))).toEqual(["ticket/cas/1"]);
  const agents = await liveAgentNames();
  expect(agents.filter((n) => n.startsWith("ticket-cas-"))).toEqual(["ticket-cas-1"]);

  expect((await api(board, "DELETE", `/tickets/${id}`)).status).toBe(200);
});

test("two different tickets spawn side by side and both agents do the work", async () => {
  test.setTimeout(COMPLETION_MS);
  await createProject(board, "conc", repoPath);
  const one = await createTicket(board, "conc", "First concurrent", PROBE_DESCRIPTION);
  const two = await createTicket(board, "conc", "Second concurrent", PROBE_DESCRIPTION);

  const [a, b] = await Promise.all([
    spawnTicket(board, repoPath, one),
    spawnTicket(board, repoPath, two),
  ]);

  // Distinct on every identifier that has a different scope (memory/naming.md): branch per
  // repo, agent name per Herdr session, pane per workspace.
  expect(a.branch).not.toBe(b.branch);
  expect(a.worktreePath).not.toBe(b.worktreePath);
  expect(a.agentName).not.toBe(b.agentName);
  expect(a.paneId).not.toBe(b.paneId);

  const branches = await liveWorktreeBranches(repoPath);
  expect(branches).toEqual(expect.arrayContaining([a.branch, b.branch]));
  const agents = await liveAgentNames();
  expect(agents).toEqual(expect.arrayContaining([a.agentName, b.agentName]));

  // G3 is about two agents never having actually RUN at once, so this waits for both turns
  // rather than settling for "the spawn returned".
  for (const run of [a, b]) {
    const row = await waitForTicket(
      board,
      run.ticketId,
      "reported finished",
      (t) => t["finished"] === true,
      FINISH_MS,
    );
    expect(row).toMatchObject({ status: "in_progress", died: false });
    const probe = join(run.worktreePath, PROBE_FILE);
    expect(existsSync(probe), `the agent never created ${probe}`).toBe(true);
    expect((await readFile(probe, "utf8")).trim()).toBe(PROBE_CONTENT);
  }
});
