/**
 * The spawn lifecycle, end to end through the real server and the real board UI, with the
 * cloud faked: Start opens a cloud session, the (fake) agent reports `working` then `done`
 * into the database, and the poller moves the card to In Review by itself. Cancel takes it
 * back to To Do and clears the session.
 *
 * Agent-free: `CLOUD_DRIVER=fake` (fixtures.ts), so nothing here costs money or needs network.
 */
import { expect, test } from "@playwright/test";
import {
  api,
  cleanupAll,
  createProject,
  createTicket,
  makeRepo,
  spawnTicket,
  startBoard,
  storedTicket,
  waitForTicket,
  type Board,
} from "./fixtures.ts";

let board: Board;
let repoPath: string;

test.beforeAll(async () => {
  board = await startBoard();
  repoPath = await makeRepo();
});

test.afterAll(async () => {
  await cleanupAll();
});

test("Start opens a cloud session, and the agent's own report moves the card to In Review", async ({ page }) => {
  await createProject(board, "spwn", repoPath);
  const id = await createTicket(board, "spwn", "Spawn lifecycle", "Add a probe file.");

  const run = await spawnTicket(board, id);
  expect(run.sessionUrl).toBe(`https://claude.ai/code/${run.sessionId}`);
  expect(storedTicket(board, id)).toMatchObject({ status: "in_progress", sessionId: run.sessionId });

  await page.goto(board.baseUrl);
  const card = page.getByRole("article", { name: id });
  // The steer affordance is a link to the session, opened in a new tab.
  await expect(card.getByRole("link", { name: "Open session" })).toHaveAttribute("href", run.sessionUrl);

  // No click: the fake agent writes `done`, the poller claims in_progress → in_review.
  const row = await waitForTicket(board, id, "moved to review", (t) => t["status"] === "in_review");
  expect(row["agentState"]).toBe("done");
  expect(row["branch"]).toBe(`claude/10x-${id}`);
  expect(row["finished"]).toBe(true);

  const inReview = page.getByRole("region", { name: /^In Review/ }).getByRole("article", { name: id });
  await expect(inReview).toBeVisible();
  await expect(inReview.getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(inReview.getByRole("button", { name: "Reject" })).toBeVisible();
});

test("a second Start on a running ticket is refused", async () => {
  await createProject(board, "twice", repoPath);
  const id = await createTicket(board, "twice", "Double click", "");
  await spawnTicket(board, id);
  const again = await api(board, "POST", `/tickets/${id}/spawn`);
  expect(again.status).toBe(409);
  expect(again.body["error"]).toBe("not_in_todo");
});

test("cancel returns the ticket to To Do and clears the session", async () => {
  await createProject(board, "cncl", repoPath);
  const id = await createTicket(board, "cncl", "Cancelled attempt", "");
  await spawnTicket(board, id);

  const res = await api(board, "POST", `/tickets/${id}/cancel`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body["messaged"]).toBe(true);

  // To Do, not Backlog: cancel discards the attempt, not the plan that made it startable.
  expect(storedTicket(board, id)).toEqual({ status: "todo", branch: null, sessionId: null, agentState: null });
});
