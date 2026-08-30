import { expect, test } from "@playwright/test";
import { cleanupAll, makeRepo, requireHerdr, startBoard, type Board } from "./fixtures.ts";

const PROJECT_ID = "brd";
const PROJECT_NAME = "Board Project";
const SEEDED_TITLE = "Seeded before the page loaded";
const POLLED_TITLE = "Created after the page loaded";

let board: Board;

/** `fetch`, not the `request` fixture: that fixture is test-scoped and unavailable here. */
async function post(path: string, data: unknown): Promise<void> {
  const res = await fetch(`${board.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  if (res.status !== 201) throw new Error(`POST ${path} → ${res.status}: ${text}`);
}

test.beforeAll(async () => {
  requireHerdr();
  board = await startBoard();

  await post("/projects", {
    id: PROJECT_ID,
    name: PROJECT_NAME,
    repoPath: await makeRepo(),
    baseBranch: "dev",
  });
  await post("/tickets", {
    projectId: PROJECT_ID,
    title: SEEDED_TITLE,
    description: "seeded by the fixture",
  });
});

test.afterAll(async () => {
  await cleanupAll();
});

test("shows the project and its backlog ticket", async ({ page }) => {
  await page.goto(board.baseUrl);

  // The header is the `banner` landmark; the composer carries a second "Project" combobox,
  // so scoping by landmark is what keeps this unambiguous without naming a class.
  const picker = page.getByRole("banner").getByRole("combobox", { name: "Project" });
  await expect(picker.getByRole("option", { name: PROJECT_NAME })).toHaveCount(1);

  await expect(page.getByText(SEEDED_TITLE)).toBeVisible();

  // The column headings carry their live count in their accessible name, which is the only
  // semantic way to say "this ticket is in Backlog, not In Progress".
  await expect(page.getByRole("heading", { name: "Backlog 1" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "In Progress 0" })).toBeVisible();

  // `Start` is the backlog-only affordance; an in-progress card offers Cancel instead.
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
});

test("picks up a ticket created after load without a reload", async ({ page, request }) => {
  await page.goto(board.baseUrl);
  await expect(page.getByText(SEEDED_TITLE)).toBeVisible();

  const created = await request.post(`${board.baseUrl}/tickets`, {
    data: { projectId: PROJECT_ID, title: POLLED_TITLE, description: "arrives via the poll" },
  });
  expect(created.status()).toBe(201);

  // No page.reload(): the board polls GET /tickets every second.
  await expect(page.getByText(POLLED_TITLE)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Backlog 2" })).toBeVisible();
});
