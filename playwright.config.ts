import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Every spec binds one TCP port (4310) and one Preview port range. A second worker would
  // race both, so this is a correctness setting, not a speed knob.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  globalTimeout: 600_000,
  // The html reporter writes its output to playwright-report/, which is gitignored, so it
  // won't pollute `git status` or get committed.
  reporter: "html",
  // Deliberately no `webServer`: fixtures start the backend themselves so each spec owns its
  // own throwaway state dir instead of sharing one long-lived server.
  //
  // Two projects, not one filtered run. "fast" is an explicit ALLOW-LIST of the specs known
  // NOT to start a real coding agent — today that is every spec, because the board runs with
  // `CLOUD_DRIVER=fake` (e2e/fixtures.ts). It stays an allow-list rather than "everything" so
  // that a spec added later which needs a real cloud session cannot run (and spend) under the
  // default `pnpm e2e` unless someone deliberately lists it here.
  projects: [
    {
      name: "fast",
      testMatch: [
        "projects.spec.ts",
        "tickets.spec.ts",
        "board.spec.ts",
        "spawn.spec.ts",
        "reject.spec.ts",
        "preview.spec.ts",
      ],
    },
    {
      name: "full",
      testMatch: /.*\.spec\.ts/,
    },
  ],
});
