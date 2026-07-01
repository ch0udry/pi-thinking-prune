import test from "node:test";
import assert from "node:assert/strict";
import { captureUnindexedThinkingBatchesFromSession } from "../src/thinking-capture.js";
import { pruneMessages } from "../src/pruner.js";
import { ThinkingIndexer } from "../src/indexer.js";
import { DEFAULT_CONFIG } from "../src/types.js";

test("captures assistant thinking blocks from session branch", () => {
  const branch = [
    { type: "message", id: "u1", message: { role: "user", content: "hi" } },
    {
      type: "message",
      id: "a1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        provider: "p",
        model: "m",
        timestamp: 1,
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "visible answer" },
        ],
      },
    },
  ];
  const indexer = { isSummarizedPruneKey: () => false };
  const batches = captureUnindexedThinkingBatchesFromSession(branch, indexer, DEFAULT_CONFIG);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].thinkingBlocks.length, 1);
  assert.equal(batches[0].thinkingBlocks[0].thinking, "private reasoning");
  assert.equal(batches[0].assistantText, "visible answer");
});

test("prunes indexed thinking blocks but keeps visible text and tool calls", () => {
  const message = {
    role: "assistant",
    provider: "p",
    model: "m",
    timestamp: 1,
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "toolCall", id: "call1", name: "read", arguments: { path: "x" } },
      { type: "text", text: "visible answer" },
    ],
  };
  const branch = [{ type: "message", id: "a1", timestamp: "2026-01-01T00:00:00.000Z", message }];
  const indexer = new ThinkingIndexer();
  const batches = captureUnindexedThinkingBatchesFromSession(branch, indexer, DEFAULT_CONFIG);
  indexer.persistBatch(batches[0], () => undefined);

  const pruned = pruneMessages([message], indexer);
  assert.notEqual(pruned, [message]);
  assert.equal(pruned.length, 1);
  assert.deepEqual(pruned[0].content.map((b: any) => b.type), ["toolCall", "text"]);
});

test("drops assistant message when only indexed thinking remains", () => {
  const message = {
    role: "assistant",
    provider: "p",
    model: "m",
    timestamp: 1,
    content: [{ type: "thinking", thinking: "only thinking" }],
  };
  const branch = [{ type: "message", id: "a2", timestamp: "2026-01-01T00:00:01.000Z", message }];
  const indexer = new ThinkingIndexer();
  const batches = captureUnindexedThinkingBatchesFromSession(branch, indexer, DEFAULT_CONFIG);
  indexer.persistBatch(batches[0], () => undefined);

  const pruned = pruneMessages([message], indexer);
  assert.equal(pruned.length, 0);
});
