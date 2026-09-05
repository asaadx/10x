/**
 * Agent-free coverage for the screenshot capture surface: upload, render in the sheet, and
 * enlarge on click. The capture itself is the visual-diff skill's job (skills/visual-diff/
 * SKILL.md), which needs a real agent to run — this spec drives the two ends of it a real
 * capture would, straight over HTTP, and proves the board renders what lands there.
 */
import { expect, test } from "@playwright/test";
import { cleanupAll, makeRepo, requireHerdr, startBoard, type Board } from "./fixtures.ts";

const PROJECT_ID = "shot";
const PROJECT_NAME = "Screenshot Project";
const TITLE = "Ticket with captured screenshots";

/**
 * A real, minimal, decodable 1x1 transparent PNG — small enough to inline, real enough that
 * the sheet's <img> actually decodes it instead of showing a broken-image icon, which is what
 * "renders" needs to mean for this spec to be worth anything.
 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let board: Board;
let ticketId: string;

/** `fetch`, not the `request` fixture: unavailable in `beforeAll` (see board.spec.ts). */
async function postJson(path: string, data: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${board.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  const body: unknown = await res.json();
  if (res.status >= 300) throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body as Record<string, unknown>;
}

async function uploadScreenshot(side: "before" | "after"): Promise<void> {
  const res = await fetch(`${board.baseUrl}/tickets/${ticketId}/screenshots/${side}`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: PNG,
  });
  if (res.status !== 200) throw new Error(`upload ${side} → ${res.status}: ${await res.text()}`);
}

test.beforeAll(async () => {
  requireHerdr();
  board = await startBoard();

  await postJson("/projects", {
    id: PROJECT_ID,
    name: PROJECT_NAME,
    repoPath: await makeRepo(),
    baseBranch: "dev",
  });
  const ticket = await postJson("/tickets", { projectId: PROJECT_ID, title: TITLE, description: "" });
  ticketId = ticket["id"] as string;

  // Both sides, exactly as the skill would upload them, before the page ever loads — the
  // sheet's Before/After block only renders once at least one side is non-null.
  await uploadScreenshot("before");
  await uploadScreenshot("after");
});

test.afterAll(async () => {
  await cleanupAll();
});

test("renders both captured screenshots, and enlarging one leaves the sheet open behind it", async ({ page }) => {
  await page.goto(board.baseUrl);

  const picker = page.getByRole("banner").getByRole("combobox", { name: "Project" });
  await picker.selectOption({ label: PROJECT_NAME });

  await page.getByRole("article", { name: ticketId }).getByRole("button", { name: TITLE }).click();

  // SheetTitle renders the ticket id once a real ticket (not the composer) is open. Located
  // by `data-slot`, not `role=dialog`: Radix marks background content `aria-hidden` while the
  // enlarge dialog below is open, which is correct a11y and would make a role-based locator
  // report the sheet as gone even though it is still on screen.
  const sheet = page.locator('[data-slot="sheet-content"]');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(ticketId);

  const before = sheet.getByRole("img", { name: "Before" });
  const after = sheet.getByRole("img", { name: "After" });
  await expect(before).toBeVisible();
  await expect(after).toBeVisible();
  // Both point at the served route, not a data URL or a placeholder icon.
  await expect(before).toHaveAttribute("src", `/screenshots/${ticketId}-before.png`);
  await expect(after).toHaveAttribute("src", `/screenshots/${ticketId}-after.png`);
  // Real decodable bytes, not a broken image: naturalWidth is 0 on a failed decode.
  await expect(before).toHaveJSProperty("naturalWidth", 1);

  // Enlarging: the thumbnail is a button, not the <img> itself (frontend/src/components/
  // TicketSheet.tsx), so it is keyboard-reachable and carries its own accessible name.
  await sheet.getByRole("button", { name: "Enlarge Before screenshot" }).click();

  const enlarged = page.getByRole("dialog", { name: "Before screenshot, enlarged" });
  await expect(enlarged).toBeVisible();
  // Still on screen underneath — nesting one Radix Dialog inside another must not have
  // closed it, even though it is now `aria-hidden` (see the locator note above).
  await expect(sheet).toBeVisible();

  // Escape closes the topmost dialog only.
  await page.keyboard.press("Escape");
  await expect(enlarged).toBeHidden();
  await expect(sheet).toBeVisible();
});
