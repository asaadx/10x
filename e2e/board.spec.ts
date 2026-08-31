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

/**
 * In Review is reached only by an agent finishing a turn, so on a fresh board it must exist
 * and be empty. Agent-free on purpose: what is asserted is that the column is on the page and
 * carries its accessible name, not that anything transitions into it.
 */
test("renders an empty In Review column", async ({ page }) => {
  await page.goto(board.baseUrl);

  // The column is a `region` labelled by its own heading, so its accessible name carries the
  // live count — "In Review 0" is both "the column is there" and "it holds nothing", with no
  // duplicated string to drift. Cards are `article`s, so counting them proves the emptiness
  // rather than trusting the number in the heading.
  const column = page.getByRole("region", { name: "In Review 0" });
  await expect(column).toBeVisible();
  await expect(column.getByRole("heading", { name: "In Review 0" })).toBeVisible();
  await expect(column.getByRole("article")).toHaveCount(0);
});

/**
 * Done is reached only via Accept, which this suite deliberately never triggers (memory/
 * parking-lot.md warns Accept pushes real branches and opens real PRs). So on a fresh board
 * it must exist and be empty, exactly like In Review above.
 */
test("renders an empty Done column", async ({ page }) => {
  await page.goto(board.baseUrl);

  const column = page.getByRole("region", { name: "Done 0" });
  await expect(column).toBeVisible();
  await expect(column.getByRole("heading", { name: "Done 0" })).toBeVisible();
  await expect(column.getByRole("article")).toHaveCount(0);
});

/**
 * The four columns are named regions; asserting their accessible names in DOM order is the
 * only way to pin "Done comes after In Review" without reaching into DOM structure.
 */
test("shows all four columns in order", async ({ page }) => {
  await page.goto(board.baseUrl);

  // Wait for the first poll to land before reading the snapshot below: a bare `evaluateAll`
  // has no retry and can otherwise run against the pre-poll, ticket-less DOM.
  await expect(page.getByRole("heading", { name: "Backlog 1" })).toBeVisible();

  const names = await page.getByRole("region").evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent?.trim()),
  );
  expect(names).toEqual(["Backlog 1", "In Progress 0", "In Review 0", "Done 0"]);
});

/**
 * Accept is In-Review-only. A backlog card offers Start instead, and must never grow an
 * Accept button of its own.
 */
test("a backlog card shows no Accept button", async ({ page }) => {
  await page.goto(board.baseUrl);

  const backlog = page.getByRole("region", { name: "Backlog 1" });
  await expect(backlog.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(backlog.getByRole("button", { name: "Accept" })).toHaveCount(0);
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

/**
 * The frontend is a stylesheet plus five ES modules, so the static route is load-bearing:
 * if it silently reverts to 404 the board renders unstyled and dead, and nothing else in
 * this suite would notice. This pins both halves — the assets are served with usable
 * content types, and the route stays a narrow allow-list rather than a filesystem probe.
 */
test("serves the frontend's assets, and refuses everything else", async ({ request }) => {
  const assets = [
    ["/styles.css", "text/css"],
    ["/js/app.js", "text/javascript"],
    ["/js/render.js", "text/javascript"],
    ["/js/state.js", "text/javascript"],
    ["/js/api.js", "text/javascript"],
    ["/js/icons.js", "text/javascript"],
    ["/", "text/html"],
    ["/index.html", "text/html"],
  ];
  for (const [path, type] of assets) {
    const res = await request.get(`${board.baseUrl}${path}`);
    expect(res.status(), path).toBe(200);
    expect(res.headers()["content-type"], path).toContain(type);
  }

  const refused = [
    "/src/server.ts", // extension outside the allow-list
    "/package.json", // ditto, and outside public/
    "/js", // a directory: there are no listings
    "/nope.css", // allow-listed extension, no such file
    // Percent-encoded so the URL keeps its `..` instead of being normalised away. An
    // allow-listed extension on a real file outside public/, so this is the containment
    // check and not the extension check.
    "/..%2fnode_modules%2ftypescript%2flib%2ftypescript.js",
  ];
  for (const path of refused) {
    const res = await request.get(`${board.baseUrl}${path}`);
    expect(res.status(), path).toBe(404);
    expect(res.headers()["content-type"], path).toContain("application/json");
  }

  // A wrong path under an API prefix keeps the API's own envelope: static resolution runs
  // only after the router has already declined, so it can never shadow a route.
  const underApi = await request.get(`${board.baseUrl}/projects/nope.css`);
  expect(underApi.status()).toBe(404);
  expect(await underApi.json()).toMatchObject({ error: "not_found", path: "/projects/nope.css" });

  // POST is not a way in, even to a file that exists.
  const posted = await request.post(`${board.baseUrl}/styles.css`, { data: {} });
  expect(posted.status()).toBe(404);
  expect(posted.headers()["content-type"]).toContain("application/json");
});
