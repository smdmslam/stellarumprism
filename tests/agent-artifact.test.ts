import test from "node:test";
import assert from "node:assert/strict";

import { extractWriteArtifactDiff } from "../src/agent-write-artifacts.ts";

test("extractWriteArtifactDiff: returns artifact diff when present", () => {
  const payload = JSON.stringify({
    created: false,
    artifact: {
      kind: "write",
      operation: "overwrite",
      diff: "--- old\n+++ new\n-old\n+new\n",
    },
  });
  assert.equal(
    extractWriteArtifactDiff(payload),
    "--- old\n+++ new\n-old\n+new\n",
  );
});

test("extractWriteArtifactDiff: returns null when artifact is absent", () => {
  const payload = JSON.stringify({ created: true });
  assert.equal(extractWriteArtifactDiff(payload), null);
});

test("extractWriteArtifactDiff: returns null for blank diff", () => {
  const payload = JSON.stringify({
    created: false,
    artifact: { diff: "   " },
  });
  assert.equal(extractWriteArtifactDiff(payload), null);
});

test("extractWriteArtifactDiff: returns null for malformed payload", () => {
  assert.equal(extractWriteArtifactDiff("{not json"), null);
});
