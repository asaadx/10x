/**
 * Reject, end to end with the cloud faked: a ticket in In Review is sent back to In Progress,
 * the reason goes into the same session as a follow-up message, and the agent's next `done`
 * brings it back to review. Nothing is destroyed — the session, its context and the branch
 * all carry on.
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

test("reject sends a reviewed ticket back to work in the same session, and it returns to review", async () => {
  await createProject(board, "rjct", repoPath);
  const id = await createTicket(board, "rjct", "Probe reject", "");
  const run = await spawnTicket(board, id);
  await waitForTicket(board, id, "moved to review", (t) => t["status"] === "in_review");

  const res = await api(board, "POST", `/tickets/${id}/reject`, { reason: "please add a test" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body["status"]).toBe("in_progress");
  expect(res.body["agentState"]).toBe("working");
  expect(res.body["finished"]).toBe(false);
  // The same session: its context is the whole point of Reject over a fresh Start.
  expect(storedTicket(board, id).sessionId).toBe(run.sessionId);

  await waitForTicket(board, id, "returned to review", (t) => t["status"] === "in_review");
});

test("reject without a reason is rejected with 400", async () => {
  await createProject(board, "rjnr", repoPath);
  const id = await createTicket(board, "rjnr", "No reason", "");
  await spawnTicket(board, id);
  await waitForTicket(board, id, "moved to review", (t) => t["status"] === "in_review");

  const res = await api(board, "POST", `/tickets/${id}/reject`, { reason: "" });
  expect(res.status).toBe(400);
  expect(res.body["error"]).toBe("reason_required");
  expect(storedTicket(board, id).status).toBe("in_review");
});
