/**
 * Tests for the pure project-identity helpers in lifecycle.ts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveProjectSlug, PROJECT_SLUG_RE, validateProjectSlug } from "./lifecycle.ts";

describe("validateProjectSlug", () => {
  // A LEADING DIGIT IS LEGAL: `10x`, this project's own name, must pass.
  const accepted = ["10x", "target", "a", "my-app", "9lives", "a".repeat(20)];

  for (const slug of accepted) {
    test(`accepts ${JSON.stringify(slug)}`, () => {
      assert.deepEqual(validateProjectSlug(slug), { ok: true });
    });
  }

  const rejected: Array<[string, string]> = [
    ["", "empty is not a slug"],
    ["a".repeat(21), "21 chars overruns the 20-char budget"],
    ["My-App", "uppercase is refused"],
    ["my.app", "dot excluded to keep a single separator"],
    ["my_app", "underscore excluded to keep a single separator"],
    ["-x", "leading hyphen"],
  ];

  for (const [slug, why] of rejected) {
    test(`rejects ${JSON.stringify(slug)} — ${why}`, () => {
      const result = validateProjectSlug(slug);
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.message.length > 0, "rejection must explain itself");
    });
  }
});

describe("deriveProjectSlug", () => {
  // The rule that makes the derived name usable rather than merely legal: a machine-sliced
  // `hearth-home-automati` reads like a typo, so the user retypes the field on every project
  // and the derivation has bought nothing. Whole trailing words go instead.
  const cases: Array<[string, string]> = [
    ["hearth-home-automation", "hearth-home"],
    ["some-org-internal-platform-service", "some-org-internal"],
    ["10x", "10x"],
    ["My.App", "my-app"],
    // Separator runs collapse to one and the ends are trimmed, or the result would start
    // with a `-` and PROJECT_SLUG_RE would refuse the name we just suggested.
    ["  __my  app__  ", "my-app"],
    ["-hearth-", "hearth"],
    // No separator to cut on, so this one really does get sliced mid-word — the fallback,
    // not the rule.
    ["extraordinarilylongreponame", "extraordinarilylongr"],
    // Nothing to derive from at all. Deliberately empty rather than a placeholder: the
    // dialog shows a field the user must fill, and validateProjectSlug refuses it.
    ["...", ""],
    ["!!", ""],
  ];

  for (const [name, expected] of cases) {
    test(`${JSON.stringify(name)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(deriveProjectSlug(name), expected);
    });
  }

  // Cutting on a word boundary must still respect the cap the whole exercise is about.
  test("a name at the cap survives whole; one character more loses a word", () => {
    assert.equal(deriveProjectSlug("a".repeat(20)), "a".repeat(20));
    assert.equal(deriveProjectSlug("aaaaaaaaaaaaaaaaaaaa-b"), "a".repeat(20));
    assert.equal(deriveProjectSlug("hearth-home-autom"), "hearth-home-autom");
  });

  // The contract with the validator: anything with a usable character in it derives a slug
  // the caller can accept without editing. A derivation that produced names 10x then rejects
  // would be worse than no derivation at all.
  test("every realistic repo name derives a slug that passes validation", () => {
    const names = [
      "10x",
      "hearth-home-automation",
      "some-org-internal-platform-service",
      "My.App",
      "next.js",
      "awesome_python_tools",
      "Design System (v2)",
      "dotfiles",
      "a",
      "9lives",
      "CAPS-LOCK-REPO-NAME-THAT-IS-LONG",
      "repo.with.many.dots.everywhere",
      "trailing-separators---",
      "extraordinarilylongreponame",
    ];
    for (const name of names) {
      const slug = deriveProjectSlug(name);
      assert.ok(PROJECT_SLUG_RE.test(slug), `${name} -> ${JSON.stringify(slug)}`);
      assert.deepEqual(validateProjectSlug(slug), { ok: true }, name);
    }
  });
});
