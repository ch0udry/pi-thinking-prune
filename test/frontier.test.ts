import test from "node:test";
import assert from "node:assert/strict";
import { ThinkingPruneFrontierTracker } from "../src/frontier.js";
import { CUSTOM_TYPE_FRONTIER, type ThinkingPruneFrontier } from "../src/types.js";

const snapshot: ThinkingPruneFrontier = {
  lastAttemptedThinkingId: "think:a1:0:abcd",
  lastAttemptedMessageEntryId: "a1",
  lastAttemptedBlockIndex: 0,
  lastAttemptedTurnIndex: 7,
  lastAttemptedTimestamp: 1700000000000,
  attemptedBatchCount: 1,
  attemptedThinkingBlockCount: 1,
  rawCharCount: 100,
  summaryCharCount: 150,
  outcome: "skipped-oversized",
};

test("frontier reconstructs skipped oversized attempts from session custom entries", () => {
  const tracker = new ThinkingPruneFrontierTracker();
  tracker.reconstructFromSession({
    sessionManager: {
      getBranch: () => [
        { type: "custom", customType: CUSTOM_TYPE_FRONTIER, data: snapshot },
      ],
    },
  } as any);

  assert.deepEqual(tracker.get(), snapshot);
});

test("frontier persist writes thinking-prune-frontier custom entry", () => {
  const tracker = new ThinkingPruneFrontierTracker();
  tracker.advance(snapshot);
  let written: any;
  tracker.persist({
    appendEntry: (customType: string, data: unknown) => {
      written = { customType, data };
    },
  } as any);

  assert.equal(written.customType, CUSTOM_TYPE_FRONTIER);
  assert.deepEqual(written.data, snapshot);
});
