import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Every spec drives one Herdr session, one TCP port and one SQLite state dir. A second
  // worker would race all three, so this is a correctness setting, not a speed knob.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  globalTimeout: 600_000,
  // "list" keeps the run to stdout; the html reporter would write a playwright-report/ tree
  // nobody reads locally.
  reporter: "list",
  // Deliberately no `webServer`: fixtures start the backend themselves so each spec owns its
  // own throwaway state dir instead of sharing one long-lived server.
});
