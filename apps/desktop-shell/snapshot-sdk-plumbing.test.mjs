import assert from "node:assert/strict";
import test from "node:test";

test("SDK snapshot forwards viewport flags and maxResultLength and exposes truncation marker", async () => {
  let received;
  const previousEgo = globalThis.ego;
  globalThis.ego = {
    async snapshot(options) {
      received = options;
      return {
        content: "- button \"Visible\" [@1]\n[snapshot truncated: 4 of 5 lines omitted]",
        refs: [{ backendNodeId: 1, role: "button", name: "Visible" }],
        truncation: {
          reasons: ["max_result_length"],
          maxResultLength: 128,
          totalLines: 5,
          includedLines: 1,
          omittedLines: 4,
        },
      };
    },
  };
  try {
    const { snapshot, snapshotRaw } = await import("../../vendor/ego-browser/src/driver/observe.js");
    const raw = await snapshotRaw({
      scope: "viewport",
      includeActionMarks: false,
      includeStableLocator: false,
      maxResultLength: 128,
    });
    assert.equal(raw.truncation.omittedLines, 4);
    assert.deepEqual(received, {
      scope: "viewport",
      includeActionMarks: false,
      includeStableLocator: false,
      maxResultLength: 128,
    });

    const text = await snapshot({ scope: "viewport", maxResultLength: 128 });
    assert.match(text, /snapshot truncated: 4 of 5 lines omitted/);
    assert.deepEqual(received, {
      scope: "viewport",
      includeActionMarks: true,
      includeStableLocator: true,
      maxResultLength: 128,
    });
  } finally {
    if (previousEgo === undefined) delete globalThis.ego;
    else globalThis.ego = previousEgo;
  }
});
