import assert from "node:assert/strict";
import test from "node:test";
import { parseAppearancePreference, resolveAppearance } from "../src/appearance.ts";

test("accepts supported appearance preferences and defaults invalid values to system", () => {
  assert.equal(parseAppearancePreference("system"), "system");
  assert.equal(parseAppearancePreference("light"), "light");
  assert.equal(parseAppearancePreference("dark"), "dark");
  assert.equal(parseAppearancePreference("sepia"), "system");
  assert.equal(parseAppearancePreference(null), "system");
});

test("resolves system appearance while preserving explicit light and dark choices", () => {
  assert.equal(resolveAppearance("system", "light"), "light");
  assert.equal(resolveAppearance("system", "dark"), "dark");
  assert.equal(resolveAppearance("light", "dark"), "light");
  assert.equal(resolveAppearance("dark", "light"), "dark");
});
