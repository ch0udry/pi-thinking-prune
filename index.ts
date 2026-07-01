import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { captureUnindexedThinkingBatchesFromSession, groupBatchesByMode } from "./src/thinking-capture.js";
import { summarizeBatches } from "./src/summarizer.js";
import { ThinkingIndexer } from "./src/indexer.js";
import { pruneMessages } from "./src/pruner.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands, setThinkingPruneStatusWidget } from "./src/commands.js";
import { formatSummaryThinkingRefs, makeSummaryDetails } from "./src/summary-refs.js";
import type { CapturedThinkingBatch, FlushOptions, ThinkingPruneConfig, ThinkingPruneFrontier } from "./src/types.js";
import { CUSTOM_TYPE_FRONTIER, CUSTOM_TYPE_STATS, CUSTOM_TYPE_SUMMARY, DEFAULT_CONFIG } from "./src/types.js";
import { StatsAccumulator } from "./src/stats.js";
import { ThinkingPruneFrontierTracker } from "./src/frontier.js";

export default function (pi: ExtensionAPI) {
  const currentConfig: { value: ThinkingPruneConfig } = { value: { ...DEFAULT_CONFIG } };
  const indexer = new ThinkingIndexer();
  const statsAccum = new StatsAccumulator();
  const frontier = new ThinkingPruneFrontierTracker();
  let isFlushing = false;

  type FlushResult =
    | { ok: true; reason: "flushed" | "skipped-oversized"; batchCount: number; blockCount: number; rawCharCount: number; summaryCharCount: number }
    | { ok: false; reason: "empty" | "already-flushing" | "summarizer-failed" | "failed" | "aborted"; error?: string };

  type SessionAppender = {
    appendCustomEntry(customType: string, data?: unknown): string;
    appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
  };

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const assistantMessageHasToolCalls = (message: any) =>
    message?.role === "assistant" && Array.isArray(message.content) && message.content.some((block: any) => block?.type === "toolCall");

  const isFinalAssistantMessage = (message: any) => message?.role === "assistant" && !assistantMessageHasToolCalls(message);

  const trimBatchToPendingRange = (batch: CapturedThinkingBatch): CapturedThinkingBatch | null => {
    const currentFrontier = frontier.get();
    let thinkingBlocks = batch.thinkingBlocks.filter((block) => !indexer.isSummarizedPruneKey(block.pruneKey));
    if (thinkingBlocks.length === 0) return null;

    // The indexer covers successfully summarized blocks. The frontier also covers
    // completed attempts skipped as oversized, matching pi-context-prune behavior.
    if (!currentFrontier) return { ...batch, thinkingBlocks };
    if (batch.turnIndex < currentFrontier.lastAttemptedTurnIndex) return null;
    if (batch.turnIndex > currentFrontier.lastAttemptedTurnIndex) return { ...batch, thinkingBlocks };

    const lastIndex = thinkingBlocks.findIndex((block) => block.thinkingId === currentFrontier.lastAttemptedThinkingId);
    if (lastIndex < 0) return { ...batch, thinkingBlocks };

    thinkingBlocks = thinkingBlocks.slice(lastIndex + 1);
    if (thinkingBlocks.length === 0) return null;
    return { ...batch, thinkingBlocks };
  };

  const capturePendingBatches = (ctx: any): CapturedThinkingBatch[] => {
    const branch = ctx.sessionManager.getBranch();
    const batches = captureUnindexedThinkingBatchesFromSession(branch, indexer, currentConfig.value)
      .map((batch) => trimBatchToPendingRange(batch))
      .filter((batch): batch is CapturedThinkingBatch => batch !== null);
    return groupBatchesByMode(batches, currentConfig.value.batchingMode);
  };

  const flushPending = async (ctx: any, options: FlushOptions = {}): Promise<FlushResult> => {
    if (isFlushing) return { ok: false, reason: "already-flushing" };

    const batches = options.previewedBatches ?? capturePendingBatches(ctx);
    if (batches.length === 0) return { ok: false, reason: "empty" };
    if (options.signal?.aborted) return { ok: false, reason: "aborted" };

    isFlushing = true;
    try {
      setThinkingPruneStatusWidget(ctx, currentConfig.value, "summarizing…");
      const results = await summarizeBatches(batches, currentConfig.value, ctx, { signal: options.signal });
      const sessionManager = ctx.sessionManager as SessionAppender;

      let persistedBatches = 0;
      let skippedOversized = 0;
      let totalRawCharCount = 0;
      let totalSummaryCharCount = 0;
      let totalBlockCount = 0;
      const attemptedBatches: CapturedThinkingBatch[] = [];

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const result = results[i];
        if (!result) break;

        const rawCharCount = batch.thinkingBlocks.reduce((sum, block) => sum + block.charCount, 0);
        const refs = indexer.allocateSummaryRefs(batch);
        const summaryText = result.summaryText + formatSummaryThinkingRefs(refs);
        const shouldSkipOversized = currentConfig.value.skipOversizedSummary && summaryText.length > rawCharCount;

        statsAccum.add(result.usage);
        totalRawCharCount += rawCharCount;
        totalSummaryCharCount += summaryText.length;
        totalBlockCount += batch.thinkingBlocks.length;
        attemptedBatches.push(batch);

        if (shouldSkipOversized) {
          skippedOversized++;
          continue;
        }

        const details = makeSummaryDetails(batch, refs);
        sessionManager.appendCustomMessageEntry(CUSTOM_TYPE_SUMMARY, summaryText, false, details);
        indexer.registerSummaryRefs(refs);
        indexer.persistBatch(batch, (customType, data) => sessionManager.appendCustomEntry(customType, data), new Map());
        persistedBatches++;
      }

      if (attemptedBatches.length === 0) return { ok: false, reason: "summarizer-failed" };

      const lastBatch = attemptedBatches[attemptedBatches.length - 1];
      const lastBlock = lastBatch.thinkingBlocks[lastBatch.thinkingBlocks.length - 1];
      const allOversized = skippedOversized === attemptedBatches.length;
      const frontierSnapshot: ThinkingPruneFrontier = {
        lastAttemptedThinkingId: lastBlock.thinkingId,
        lastAttemptedMessageEntryId: lastBlock.messageEntryId,
        lastAttemptedBlockIndex: lastBlock.blockIndex,
        lastAttemptedTurnIndex: lastBatch.turnIndex,
        lastAttemptedTimestamp: lastBatch.timestamp,
        attemptedBatchCount: attemptedBatches.length,
        attemptedThinkingBlockCount: totalBlockCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
        outcome: allOversized ? "skipped-oversized" : "summarized",
      };

      frontier.advance(frontierSnapshot);
      sessionManager.appendCustomEntry(CUSTOM_TYPE_FRONTIER, frontierSnapshot);
      try {
        sessionManager.appendCustomEntry(CUSTOM_TYPE_STATS, statsAccum.getStats());
      } catch {
        // Stats are not part of pruning correctness.
      }

      if (skippedOversized > 0) {
        try {
          ctx.ui.notify(
            `thinking-pruner: skipped ${skippedOversized} oversized summary batch${skippedOversized === 1 ? "" : "es"}; frontier advanced`,
            "warning",
          );
        } catch {
          // UI may be unavailable.
        }
      }

      setThinkingPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
      return {
        ok: true,
        reason: allOversized ? "skipped-oversized" : "flushed",
        batchCount: attemptedBatches.length,
        blockCount: totalBlockCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
      };
    } catch (err) {
      if (options.signal?.aborted) return { ok: false, reason: "aborted" };
      try {
        ctx.ui.notify(`thinking-pruner: summarization failed: ${errorMessage(err)}`, "error");
      } catch {
        // Ignore UI failure.
      }
      return { ok: false, reason: "failed", error: errorMessage(err) };
    } finally {
      isFlushing = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    currentConfig.value = await loadConfig();
    indexer.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);
    frontier.reconstructFromSession(ctx);
    setThinkingPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
    try {
      ctx.ui.notify(
        `thinking-pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
        "info",
      );
    } catch {
      // UI may be unavailable.
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    indexer.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);
    frontier.reconstructFromSession(ctx);
    setThinkingPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
  });

  pi.on("message_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (event.message?.role !== "assistant") return;

    if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx);
      return;
    }

    if (currentConfig.value.pruneOn === "agent-message" && isFinalAssistantMessage(event.message)) {
      await flushPending(ctx);
    }
  });

  pi.on("context", async (event, _ctx) => {
    if (!currentConfig.value.enabled) return undefined;
    if (indexer.getIndex().size === 0) return undefined;
    const pruned = pruneMessages(event.messages, indexer);
    return pruned === event.messages ? undefined : { messages: pruned };
  });

  registerQueryTool(pi, indexer);
  registerCommands(pi, currentConfig, flushPending, capturePendingBatches, () => statsAccum.getStats(), indexer);
}

export { captureUnindexedThinkingBatchesFromSession, groupBatchesByMode } from "./src/thinking-capture.js";
export { pruneMessages } from "./src/pruner.js";
export { ThinkingIndexer } from "./src/indexer.js";
export { ThinkingPruneFrontierTracker } from "./src/frontier.js";
export { CUSTOM_TYPE_FRONTIER, CUSTOM_TYPE_INDEX, CUSTOM_TYPE_SUMMARY } from "./src/types.js";
