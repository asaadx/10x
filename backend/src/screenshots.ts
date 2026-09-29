/**
 * Storage for the before/after screenshot pair a ticket's own implementation agent captures
 * (`skills/visual-diff/SKILL.md`). Files live under `STATE_DIR`, a sibling of `sessions/` and
 * `prompts/` (runner.ts) — never inside a project's worktree, so nothing an agent captures can
 * end up in its own diff or the pull request it opens.
 *
 * The stored column value (db.ts `screenshot_before`/`screenshot_after`) is the SERVED path,
 * not a filesystem path: `/screenshots/<file>`, which server.ts maps back to a file under
 * `SCREENSHOTS_DIR` the same way it maps `frontend/dist` for the static asset route. A
 * ticket's id already contains no `/` (`<projectId>-<number>`), so the filename embeds it
 * directly with no further escaping.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setScreenshot, STATE_DIR } from "./db.ts";
import type { ScreenshotSide } from "./types.ts";

export const SCREENSHOTS_DIR = join(STATE_DIR, "screenshots");

const SIDES = ["before", "after"] as const satisfies readonly ScreenshotSide[];

const fileFor = (id: string, side: ScreenshotSide): string => `${id}-${side}.png`;

/** Where a ticket's screenshot for one side would be found on disk, whether or not it exists. */
export const screenshotFile = (id: string, side: ScreenshotSide): string =>
  join(SCREENSHOTS_DIR, fileFor(id, side));

/** Write the bytes, then point the ticket's column at the route that serves them back. */
export async function saveScreenshot(id: string, side: ScreenshotSide, data: Uint8Array): Promise<string> {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  const name = fileFor(id, side);
  await writeFile(join(SCREENSHOTS_DIR, name), data);
  const servedPath = `/screenshots/${name}`;
  await setScreenshot(id, side, servedPath);
  return servedPath;
}

/**
 * Reclaim both files unconditionally. 10x's own bookkeeping, not the user's work (memory/
 * architecture.md, port pool) — deleting a ticket takes its screenshots with it, the same
 * automatic-reclaim treatment a port slot already gets, unlike a worktree or a branch, which
 * memory/teardown.md never removes without an explicit user action.
 *
 * A missing file is normal — a ticket that never captured, or only ever had one side — and is
 * not reported; `force: true` is exactly `rm -f`.
 */
export async function deleteScreenshots(id: string): Promise<void> {
  await Promise.all(SIDES.map((side) => rm(screenshotFile(id, side), { force: true })));
}
