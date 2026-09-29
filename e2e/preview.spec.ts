/**
 * Preview through the board UI: the agent's branch is on the upstream (pushed the way a cloud
 * agent pushes it), the card's Preview button checks it out locally and runs the project's dev
 * command on its port block, and the card then links to the running server. Stopping it leaves
 * nothing listening.
 */
import { expect, test } from "@playwright/test";
import {
  api,
  cleanupAll,
  createProject,
  createTicket,
  makeRepo,
  PREVIEW_PORT_BASE,
  pushAgentBranch,
  spawnTicket,
  startBoard,
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

async function answers(url: string): Promise<string | null> {
  try {
    return await (await fetch(url)).text();
  } catch {
    return null;
  }
}

test("Preview runs the agent's pushed branch locally, and stopping it frees the port", async ({ page }) => {
  // Serves the file the agent committed, so the answer proves which tree is running.
  const devCommand = `node -e "require('http').createServer((q,s)=>s.end(require('fs').readFileSync('PROBE.txt','utf8'))).listen(process.env.PORT)"`;
  await createProject(board, "prvw", repoPath, devCommand);
  const id = await createTicket(board, "prvw", "Preview me", "");
  await spawnTicket(board, id);
  const row = await waitForTicket(board, id, "moved to review", (t) => t["status"] === "in_review");
  await pushAgentBranch(repoPath, String(row["branch"]), "PROBE.txt", "from the agent's branch");

  await page.goto(board.baseUrl);
  const card = page.getByRole("article", { name: id });
  await card.getByRole("button", { name: "Preview", exact: true }).click();

  const url = `http://localhost:${PREVIEW_PORT_BASE}`;
  await expect(card.getByTitle(`Open ${url}`)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => answers(url), { timeout: 10_000 }).toBe("from the agent's branch");

  const stopped = await api(board, "DELETE", `/tickets/${id}/preview`);
  expect(stopped.status).toBe(200);
  expect(stopped.body["stopped"]).toBe(true);
  await expect.poll(() => answers(url), { timeout: 10_000 }).toBeNull();
});
