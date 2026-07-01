import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { captureUnindexedThinkingBatchesFromSession, groupBatchesByMode } from "./src/thinking-capture.js";
import { summarizeBatch, summarizeBatches } from "./src/summarizer.js";
import { ThinkingIndexer } from "./src/indexer.js";
import { pruneMessages } from "./src/pruner.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands, setThinkingPruneStatusWidget } from "./src/commands.js";
import { formatSummaryThinkingRefs, makeSummaryDetails } from "./src/summary-refs.js";
import type { CapturedThinkingBatch, FlushOptions, IndexEntryData, ThinkingPruneConfig, ThinkingPruneFrontier, ThinkingBlockRecord } from "./src/types.js";
import { CUSTOM_TYPE_FRONTIER, CUSTOM_TYPE_INDEX, CUSTOM_TYPE_STATS, CUSTOM_TYPE_SUMMARY, DEFAULT_CONFIG } from "./src/types.js";
import { StatsAccumulator } from "./src/stats.js";
import { ThinkingPruneFrontierTracker } from "./src/frontier.js";

export default function (pi: ExtensionAPI) {
  const currentConfig: { value: ThinkingPruneConfig } = { value: { ...DEFAULT_CONFIG } };
  const indexer = new ThinkingIndexer();
  const statsAccum = new StatsAccumulator();
  const frontier = new ThinkingPruneFrontierTracker();
  const pendingBatches: CapturedThinkingBatch[] = [];
  let isFlushing = false;

  type FlushResult =
    | { ok: true; reason: "flushed" | "skipped-oversized"; batchCount: number; blockCount: number; rawCharCount: number; summaryCharCount: number }
    | { ok: false; reason: "empty" | "already-flushing" | "summarizer-failed" | "stale-context" | "failed" | "aborted"; error?: string };

  type SessionAppender = {
    appendCustomEntry(customType: string, data?: unknown): string;
    appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
  };

  const isStaleContextError = (err: unknown) => err instanceof Error && err.message.includes("This extension ctx is stale");
  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const safeNotify = (ctx: any, message: string, type: "info" | "warning" | "error" = "info") => {
    try {
      ctx.ui.notify(message, type);
    } catch (err) {
      if (!isStaleContextError(err)) throw err;
    }
  };

  const assistantMessageHasToolCalls = (message: any) =>
    message?.role === "assistant" && Array.isArray(message.content) && message.content.some((block: any) => block?.type === "toolCall");
  const isFinalAssistantMessage = (message: any) => message?.role === "assistant" && !assistantMessageHasToolCalls(message);

  const trimBatchToPendingRange = (batch: CapturedThinkingBatch): CapturedThinkingBatch | null => {
    const currentFrontier = frontier.get();
    let thinkingBlocks = batch.thinkingBlocks.filter((block) => !indexer.isSummarizedPruneKey(block.pruneKey));
    if (thinkingBlocks.length === 0) return null;
    if (!currentFrontier) return { ...batch, thinkingBlocks };
    if (batch.turnIndex < currentFrontier.lastAttemptedTurnIndex) return null;
    if (batch.turnIndex > currentFrontier.lastAttemptedTurnIndex) return { ...batch, thinkingBlocks };
    const lastIndex = thinkingBlocks.findIndex((block) => block.thinkingId === currentFrontier.lastAttemptedThinkingId);
    if (lastIndex < 0) return { ...batch, thinkingBlocks };
    thinkingBlocks = thinkingBlocks.slice(lastIndex + 1);
    if (thinkingBlocks.length === 0) return null;
    return { ...batch, thinkingBlocks };
  };

  const restoreBatches = (batches: CapturedThinkingBatch[]) => {
    pendingBatches.unshift(...batches);
  };

  const persistBatchIndex = (batch: CapturedThinkingBatch, appendEntry: (customType: string, data?: unknown) => void) => {
    const records: ThinkingBlockRecord[] = batch.thinkingBlocks.map((block) => ({ ...block }));
    for (const record of records) indexer.addRecord(record);
    appendEntry(CUSTOM_TYPE_INDEX, { thinkingBlocks: records } as IndexEntryData);
  };

  const capturePendingBatches = (ctx: any): CapturedThinkingBatch[] => {
    let batches: CapturedThinkingBatch[] = [];
    try {
      const branch = ctx.sessionManager.getBranch();
      batches = captureUnindexedThinkingBatchesFromSession(branch, indexer, currentConfig.value);
    } catch {
      batches = pendingBatches.slice();
    }
    batches = batches
      .map((batch) => trimBatchToPendingRange(batch))
      .filter((batch): batch is CapturedThinkingBatch => batch !== null);
    return groupBatchesByMode(batches, currentConfig.value.batchingMode);
  };

  const flushPending = async (ctx: any, options: FlushOptions = {}): Promise<FlushResult> => {
    if (isFlushing) return { ok: false, reason: "already-flushing" };
    const batches = options.previewedBatches ?? capturePendingBatches(ctx);
    if (batches.length === 0) return { ok: false, reason: "empty" };
    if (options.signal?.aborted) return { ok: false, reason: "aborted" };

    pendingBatches.length = 0;
    isFlushing = true;

    const delivery = options.delivery ?? "runtime";
    let sessionManager: SessionAppender | undefined;
    if (delivery === "session") {
      try {
        sessionManager = ctx.sessionManager as unknown as SessionAppender;
      } catch (err) {
        restoreBatches(batches);
        isFlushing = false;
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }
    }

    const appendEntry = (customType: string, data?: unknown) => sessionManager!.appendCustomEntry(customType, data);
    const appendSummaryMessage = (content: string, details: unknown) =>
      sessionManager!.appendCustomMessageEntry(CUSTOM_TYPE_SUMMARY, content, false, details);

    try {
      setThinkingPruneStatusWidget(ctx, currentConfig.value, "think-prune: summarizing…");

      let results: Array<import("./src/types.js").SummarizeResult | null>;
      if (options.onProgress) {
        results = [];
        for (let i = 0; i < batches.length; i++) {
          options.onProgress(i, batches.length, batches[i], "start");
          const result = await summarizeBatch(batches[i], currentConfig.value, ctx, {
            signal: options.signal,
            onTextProgress: (receivedChars) => options.onBatchTextProgress?.(i, batches.length, batches[i], receivedChars),
          });
          results.push(result);
          options.onProgress(i, batches.length, batches[i], result ? "done" : "skipped");
        }
      } else {
        results = await summarizeBatches(batches, currentConfig.value, ctx, {
          signal: options.signal,
          onBatchTextProgress: options.onBatchTextProgress,
        });
      }

      const processedBatches: CapturedThinkingBatch[] = [];
      const oversizedBatches: CapturedThinkingBatch[] = [];
      let firstFailureIndex = -1;
      let totalRawCharCount = 0;
      let totalSummaryCharCount = 0;
      let totalBlockCount = 0;

      for (let i = 0; i < batches.length; i++) {
        const result = results[i];
        if (!result) {
          firstFailureIndex = i;
          break;
        }

        const batch = batches[i];
        const rawCharCount = batch.thinkingBlocks.reduce((sum, block) => sum + block.charCount, 0);
        const refs = indexer.allocateSummaryRefs(batch);
        const summaryText = result.summaryText + formatSummaryThinkingRefs(refs);
        const shouldSkipOversized = currentConfig.value.skipOversizedSummary && summaryText.length > rawCharCount;
        const details = makeSummaryDetails(batch, refs);

        statsAccum.add(result.usage);
        totalRawCharCount += rawCharCount;
        totalSummaryCharCount += summaryText.length;
        totalBlockCount += batch.thinkingBlocks.length;

        try {
          if (!shouldSkipOversized) {
            if (delivery === "runtime") {
              pi.sendMessage(
                { customType: CUSTOM_TYPE_SUMMARY, content: summaryText, display: false, details },
                { deliverAs: "steer" },
              );
              indexer.registerSummaryRefs(refs);
              indexer.addBatch(batch, pi);
            } else {
              appendSummaryMessage(summaryText, details);
              indexer.registerSummaryRefs(refs);
              persistBatchIndex(batch, appendEntry);
            }
          } else {
            oversizedBatches.push(batch);
          }
        } catch (err) {
          if (isStaleContextError(err)) {
            restoreBatches(batches.slice(i));
            break;
          }
          throw err;
        }

        processedBatches.push(batch);
      }

      if (firstFailureIndex >= 0) restoreBatches(batches.slice(firstFailureIndex));

      if (processedBatches.length === 0) {
        setThinkingPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
        return { ok: false, reason: "summarizer-failed" };
      }

      const lastBatch = processedBatches[processedBatches.length - 1];
      const lastBlock = lastBatch.thinkingBlocks[lastBatch.thinkingBlocks.length - 1];
      const allOversized = oversizedBatches.length === processedBatches.length;
      const frontierSnapshot: ThinkingPruneFrontier = {
        lastAttemptedThinkingId: lastBlock.thinkingId,
        lastAttemptedMessageEntryId: lastBlock.messageEntryId,
        lastAttemptedBlockIndex: lastBlock.blockIndex,
        lastAttemptedTurnIndex: lastBatch.turnIndex,
        lastAttemptedTimestamp: lastBatch.timestamp,
        attemptedBatchCount: processedBatches.length,
        attemptedThinkingBlockCount: totalBlockCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
        outcome: allOversized ? "skipped-oversized" : "summarized",
      };

      try {
        frontier.advance(frontierSnapshot);
        if (delivery === "runtime") {
          frontier.persist(pi);
          statsAccum.persist(pi);
        } else {
          appendEntry(CUSTOM_TYPE_FRONTIER, frontierSnapshot);
          try { appendEntry(CUSTOM_TYPE_STATS, statsAccum.getStats()); } catch { /* stats are non-critical */ }
        }
      } catch (err) {
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }

      setThinkingPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
      for (const batch of oversizedBatches) {
        const batchRaw = batch.thinkingBlocks.reduce((sum, block) => sum + block.charCount, 0);
        const result = results[batches.indexOf(batch)];
        const summaryLen = result?.summaryText.length ?? 0;
        safeNotify(ctx, `thinking-pruner: skipped pruning turn ${batch.turnIndex} (${batch.thinkingBlocks.length} thinking block${batch.thinkingBlocks.length === 1 ? "" : "s"}) — summary was ${summaryLen} chars vs ${batchRaw} raw chars; frontier advanced past this range`, "warning");
      }

      return {
        ok: true,
        reason: allOversized ? "skipped-oversized" : "flushed",
        batchCount: processedBatches.length,
        blockCount: totalBlockCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
      };
    } catch (err) {
      restoreBatches(batches);
      if (options.signal?.aborted) {
        setThinkingPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
        return { ok: false, reason: "aborted" };
      }
      if (isStaleContextError(err)) return { ok: false, reason: "stale-context", error: errorMessage(err) };
      safeNotify(ctx, `thinking-pruner: summarization failed: ${errorMessage(err)}`, "error");
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
    pendingBatches.length = 0;
    setThinkingPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
    safeNotify(ctx, `thinking-pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`, "info");
  });

  pi.on("session_tree", async (_event, ctx) => {
    indexer.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);
    frontier.reconstructFromSession(ctx);
    pendingBatches.length = 0;
    setThinkingPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
  });

  pi.on("message_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (event.message?.role !== "assistant") return;

    const discovered = capturePendingBatches(ctx);
    for (const batch of discovered) {
      if (!pendingBatches.some((pending) => pending.turnIndex === batch.turnIndex && pending.timestamp === batch.timestamp)) {
        pendingBatches.push(batch);
      }
    }

    if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx, { delivery: "session" });
      return;
    }

    if (currentConfig.value.pruneOn === "agent-message" && isFinalAssistantMessage(event.message)) {
      await flushPending(ctx, { delivery: "session" });
      return;
    }

    if (pendingBatches.length > 0 && currentConfig.value.showStatusLine) {
      setThinkingPruneStatusWidget(ctx, currentConfig.value, `think-prune: ${pendingBatches.length} pending`);
      safeNotify(ctx, `thinking-pruner: ${pendingBatches.length} turn${pendingBatches.length === 1 ? "" : "s"} queued — will summarize on /thinking-pruner now`, "info");
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (pendingBatches.length === 0) return;
    setThinkingPruneStatusWidget(ctx, currentConfig.value, `think-prune: ${pendingBatches.length} pending`);
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
