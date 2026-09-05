import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Every spec drives one Herdr session, one TCP port and one SQLite state dir. A second
  // worker would race all three, so this is a correctness setting, not a speed knob.
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
  // NOT to spawn a real coding agent. It is deliberately not "everything except a deny-list
  // of spawning specs": a deny-list defaults new files to included, so a spec added later
  // that spawns an agent would silently run (and spawn) under the default `npm run e2e`
  // unless someone remembered to add it to the deny-list. An allow-list fails safe instead —
  // a forgotten new spec just runs slower under `e2e:full`, it never spawns unexpectedly.
  projects: [
    {
      name: "fast",
      testMatch: ["projects.spec.ts", "tickets.spec.ts", "board.spec.ts", "screenshots.spec.ts"],
    },
    {
      name: "full",
      testMatch: /.*\.spec\.ts/,
    },
  ],
});
