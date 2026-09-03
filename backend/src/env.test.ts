/**
 * Guards the one property of `env.ts` that running the server cannot check: WHERE its import
 * sits in `server.ts`.
 *
 * `env.ts` loads the repo-root `.env`, and ESM evaluates imports in order, so it only works
 * from first position — `db.ts` reads `STATE_DIR` and `DB_PATH` at module load and opens the
 * database there. An import moved below it opens the wrong database with no error at all, and
 * a missing `GITHUB_TOKEN` surfaces only later, at a click. A silent failure mode has to break
 * CI rather than production, which is what this file is for.
 *
 * Source text and not behaviour on purpose: the ordering is a property of the file, and the
 * only thing that can break it is a human tidying the imports.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER_TS = join(import.meta.dirname, "server.ts");
const LINES = readFileSync(SERVER_TS, "utf8").split("\n");

describe("the env import in server.ts", () => {
  test("is the very first import in the file, bare and side-effect only", () => {
    // Exact-match, so this also pins the bare form: a `import { load } from "./env.ts"`
    // would need a call after the import block, which is already too late.
    const first = LINES.find((line) => line.startsWith("import"));
    assert.equal(
      first,
      'import "./env.ts";',
      'server.ts must import "./env.ts" before every other import: env.ts loads .env, and ' +
        "db.ts reads STATE_DIR and DB_PATH at module load, so a later import silently opens " +
        "the default database instead of the configured one.",
    );
  });
});
