/**
 * Loads the repo-root `.env` into `process.env`. Zero dependencies — `process.loadEnvFile`
 * is built into Node 24.
 *
 * **This is a bare side-effect import, not a function, and that is deliberate.** A
 * `loadEnv()` someone calls would run *after* the import block, which is already too late:
 * `db.ts` reads `STATE_DIR` and `DB_PATH` at module load and opens the database there, and
 * `ports.ts` reads its pool configuration at load too. ESM evaluates every imported module
 * before the first statement of the importer, so only an import can get in front of them.
 *
 * The path is resolved from `import.meta.dirname`, exactly as `server.ts` resolves
 * `frontend/dist` and `prompts.ts` resolves the prompt files. **Never `process.cwd()`**: the
 * server is started from the repo root (e2e, every real run), from `backend/` (`pnpm
 * dev:api`), and a cwd-relative path would silently read a different file, or none.
 *
 * A missing `.env` is normal — a fresh clone and CI both have none — so that one case is
 * swallowed. Everything else throws: booting with half the configuration is how you get a
 * token-less process whose only symptom is Accept failing later, at the click.
 *
 * `loadEnvFile` does NOT override a variable already in the environment, which is what keeps
 * `STATE_DIR`, `DB_PATH` and `PORT` passed by the test suite and `e2e/fixtures.ts` winning
 * over whatever the file says *(verified on Node v24.19.0)*.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const ENV_FILE = join(import.meta.dirname, "..", "..", ".env");

try {
  process.loadEnvFile(ENV_FILE);
} catch (err) {
  // `loadEnvFile` reports EVERY failed open as `ENOENT`, including a file it may not read
  // (verified on v24.19.0: mode 000 throws `ENOENT`, where `readFileSync` throws `EACCES`).
  // So the code alone cannot tell "no `.env`" from "a `.env` we are not allowed to open" —
  // `existsSync` decides. Absent is fine; present-but-unopenable is a real misconfiguration
  // and must be loud, with a message that does not repeat Node's misleading "no such file".
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  if (existsSync(ENV_FILE)) {
    throw new Error(`${ENV_FILE} exists but could not be opened — check its permissions`, {
      cause: err,
    });
  }
}
