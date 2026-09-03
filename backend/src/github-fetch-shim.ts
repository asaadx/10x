/**
 * Test-only fetch redirect, loaded into `server.ts`'s child process via `node --import` from
 * `server.test.ts`. Rewrites `https://api.github.com/...` to the local fake GitHub HTTP server
 * at `GITHUB_FETCH_SHIM_TARGET`, so `github.ts`'s hardcoded API base needs no test-mode branch
 * of its own — the fake is a real HTTP server, the same "real socket, not a stubbed module"
 * approach `spawn.test.ts` and `plan.test.ts` already use for Herdr. A no-op when the env var is
 * unset, so importing this file outside a test run has zero effect.
 */
const target = process.env.GITHUB_FETCH_SHIM_TARGET;
if (target) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.github.com/")) {
      return real(target + url.slice("https://api.github.com".length), init);
    }
    return real(input, init);
  }) as typeof fetch;
}
export {};
