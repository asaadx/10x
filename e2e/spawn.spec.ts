/**
 * The spawn lifecycle against a REAL agent: spawn, completion, cancel.
 *
 * Every test here creates a git worktree and runs an OMP agent, so every test tears its own
 * spawn down before it ends and `cleanupAll` is the backstop for the ones that fail.
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  api,
  branchExists,
  cleanupAll,
  createProject,
  createTicket,
  expectZeroResidue,
  liveAgentNames,
  liveWorktreeBranches,
  makeRepo,
  PROBE_CONTENT,
  PROBE_DESCRIPTION,
  PROBE_FILE,
  requireHerdr,
  spawnTicket,
  startBoard,
  storedTicket,
  stringField,
  ticketRow,
  waitForTicket,
  type Board,
} from "./fixtures.ts";

/** A spawn costs ~4s (memory/spawn.md) but the readiness guard alone may wait 60s. */
const SPAWN_MS = 120_000;
/** Plus one real model turn on the probe ticket. */
const COMPLETION_MS = 180_000;

let board: Board;
let repoPath: string;

test.beforeAll(async () => {
  requireHerdr();
  board = await startBoard();
  // One throwaway repo for the file: branches are namespaced per project, so tests cannot
  // collide inside it, and one repo makes the residue audit a single `git branch`.
  repoPath = await makeRepo();
});

test.afterAll(async () => {
  await cleanupAll();
});

test("spawns a worktree, a branch and an agent, and persists the run", async ({ page }) => {
  test.setTimeout(SPAWN_MS);
  await createProject(board, "spwn", repoPath);
  const id = await createTicket(board, "spwn", "Spawn lifecycle", PROBE_DESCRIPTION);

  const run = await spawnTicket(board, repoPath, id);

  expect(run.branch).toBe("ticket/spwn/1");
  expect(run.agentName).toBe("ticket-spwn-1");
  expect(existsSync(run.worktreePath)).toBe(true);
  expect(await branchExists(repoPath, run.branch)).toBe(true);
  expect(await liveWorktreeBranches(repoPath)).toContain(run.branch);
  expect(await liveAgentNames()).toContain(run.agentName);
  // The pane the agent actually occupies, so a spawn that created a worktree but never
  // reached `agent.start` cannot pass this test.
  expect(run.paneId.startsWith(run.workspaceId)).toBe(true);

  // Persisted, not derived. The board reports a branch for every ticket whether or not one
  // was ever created, so only the stored row proves the spawn wrote these.
  expect(storedTicket(board, id)).toMatchObject({
    status: "in_progress",
    branch: run.branch,
    agentName: run.agentName,
  });

  await page.goto(board.baseUrl);
  await expect(page.getByRole("heading", { name: "In Progress 1" })).toBeVisible();
  await expect(page.locator(`#in-progress-cards [data-id="${id}"]`)).toContainText("ticket/spwn/1");

  // Not an assertion — this test owns a live agent and must not hand it to the next test.
  // DELETE rather than cancel because it is status-agnostic: if this agent's turn settles
  // before the test ends, the ticket has already moved itself to In Review and cancel, which
  // claims `in_progress → todo`, would answer 409 and leave the agent running.
  expect((await api(board, "DELETE", `/tickets/${id}`)).status).toBe(200);
});

/**
 * The automatic transition, end to end against a real agent: the turn finishing is what moves
 * the ticket, so nothing but a real completion can prove it. The agent is deliberately left
 * alive in review — a later Reject has to be able to re-prompt it with its full context — and
 * the ticket keeps its port block for a Preview to bind.
 */
test("a finished turn moves the ticket to In Review by itself", async ({ page }) => {
  test.setTimeout(COMPLETION_MS);
  await createProject(board, "cmpl", repoPath);
  const id = await createTicket(board, "cmpl", "Probe completion", PROBE_DESCRIPTION);

  const run = await spawnTicket(board, repoPath, id);
  // Waiting on the STATUS, not on `finished`: the column is the contract under test, and the
  // flag alone would pass even if the claim never fired.
  const row = await waitForTicket(
    board,
    id,
    "moved to review",
    (t) => t["status"] === "in_review",
    150_000,
  );

  // `finished` stays set alongside the move — it is the record that the turn completed, which
  // is what the checkmark renders and what Accept will read. A dead pane is not a finished
  // ticket (memory/teardown.md rule 3), and `finished` is only set after a `working`
  // transition was observed, so the first `idle` cannot fake this.
  expect(row["finished"]).toBe(true);
  expect(row["died"]).toBe(false);
  expect(storedTicket(board, id)).toMatchObject({ status: "in_review", branch: run.branch });

  const probe = join(run.worktreePath, PROBE_FILE);
  expect(existsSync(probe), `the agent never created ${probe}`).toBe(true);
  // Trimmed: the ticket asked for the content, and a text file ending in a newline is the
  // POSIX norm rather than a deviation from it.
  expect((await readFile(probe, "utf8")).trim()).toBe(PROBE_CONTENT);

  await page.goto(board.baseUrl);
  // A column is a `region` whose accessible name carries its live count and a card is an
  // `article` named by its ticket id, so "the card is in In Review" is assertable without
  // reaching through the DOM.
  const card = page.getByRole("region", { name: /^In Review/ }).getByRole("article", { name: id });
  await expect(card.getByTitle("finished")).toBeVisible();
  // The worktree indicator is read live from Herdr, not from our store (memory/reconciliation.md).
  await expect(card.getByTitle("worktree exists")).toBeVisible();
  await expect(page.getByRole("heading", { name: "In Review 1" })).toBeVisible();
  // Cancel is `in_progress`-only, so review offers no run action until Accept and Reject exist.
  await expect(card.getByRole("button", { name: /Cancel/ })).toHaveCount(0);

  // DELETE, not cancel: cancel claims `in_progress → todo` and answers 409 from review.
  expect((await api(board, "DELETE", `/tickets/${id}`)).status).toBe(200);
});

test("cancel leaves zero residue and returns the ticket to To Do", async () => {
  test.setTimeout(SPAWN_MS);
  await createProject(board, "cncl", repoPath);
  const id = await createTicket(board, "cncl", "Cancelled attempt", PROBE_DESCRIPTION);

  const run = await spawnTicket(board, repoPath, id);
  // Captured while the agent is alive, and asserted to exist first: the transcript lives
  // outside the worktree, so a teardown that forgot it would leave no other trace.
  const sessionDir = stringField(await ticketRow(board, id), "sessionDir");
  expect(existsSync(sessionDir)).toBe(true);

  expect((await api(board, "POST", `/tickets/${id}/cancel`)).status).toBe(200);

  await expectZeroResidue(repoPath, run, sessionDir);
  expect(storedTicket(board, id)).toEqual({
    // To Do, not Backlog: cancel discards the attempt, not the plan that made the ticket
    // startable, so the card lands back on the column Start works from.
    status: "todo",
    branch: null,
    agentName: null,
    sessionDir: null,
  });
});
