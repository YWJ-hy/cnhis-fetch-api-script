import test from "node:test";
import assert from "node:assert/strict";
import { releaseDecision } from "../scripts/release.mjs";

test("release versions: initial, changed, unchanged, pending retry and registry ahead", () => {
  assert.deepEqual(releaseDecision("1.0.0", null, true), { version: "1.0.0", publish: true });
  assert.deepEqual(releaseDecision("1.0.0", "1.0.0", true), { version: "1.0.1", publish: true });
  assert.deepEqual(releaseDecision("1.0.0", "1.0.0", false), { version: "1.0.0", publish: false });
  assert.deepEqual(releaseDecision("1.0.1", "1.0.0", true), { version: "1.0.1", publish: true });
  assert.deepEqual(releaseDecision("1.0.0", "1.0.5", true), { version: "1.0.6", publish: true });
});
