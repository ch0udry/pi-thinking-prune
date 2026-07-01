import type { BatchingMode, CapturedThinkingBatch, CapturedThinkingBlock, ThinkingPruneConfig } from "./types.js";
import { getThinkingSignature, getThinkingText, isThinkingBlock, makePruneKey, sha256Short } from "./hash.js";

function assistantTextFromContent(content: any[]): string {
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

export function captureThinkingFromAssistantEntry(
  entry: any,
  turnIndex: number,
  config: Pick<ThinkingPruneConfig, "minRawCharsToPrune">,
  indexer: { isSummarizedPruneKey(pruneKey: string): boolean },
  userTurnGroup?: number,
): CapturedThinkingBatch | null {
  if (!entry || entry.type !== "message") return null;
  const message = entry.message;
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return null;

  const assistantText = assistantTextFromContent(message.content);
  const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : (message.timestamp ?? Date.now());
  const messageEntryId = typeof entry.id === "string" ? entry.id : sha256Short({ timestamp, content: message.content }, 8);

  const thinkingBlocks: CapturedThinkingBlock[] = [];
  message.content.forEach((block: any, blockIndex: number) => {
    if (!isThinkingBlock(block)) return;
    const thinking = getThinkingText(block);
    if (thinking.length < config.minRawCharsToPrune) return;
    const pruneKey = makePruneKey(message, block);
    if (indexer.isSummarizedPruneKey(pruneKey)) return;

    const blockHash = sha256Short({ thinking, signature: getThinkingSignature(block), type: block.type }, 8);
    thinkingBlocks.push({
      thinkingId: `think:${messageEntryId}:${blockIndex}:${blockHash}`,
      pruneKey,
      messageEntryId,
      blockIndex,
      thinking,
      thinkingSignature: getThinkingSignature(block),
      redacted: Boolean(block.redacted || block.type === "redacted_thinking"),
      provider: typeof message.provider === "string" ? message.provider : undefined,
      model: typeof message.model === "string" ? message.model : undefined,
      api: typeof message.api === "string" ? message.api : undefined,
      timestamp,
      assistantText,
      charCount: thinking.length,
    });
  });

  if (thinkingBlocks.length === 0) return null;
  return { turnIndex, timestamp, assistantText, thinkingBlocks, userTurnGroup };
}

export function captureUnindexedThinkingBatchesFromSession(
  branch: any[],
  indexer: { isSummarizedPruneKey(pruneKey: string): boolean },
  config: Pick<ThinkingPruneConfig, "minRawCharsToPrune">,
): CapturedThinkingBatch[] {
  const batches: CapturedThinkingBatch[] = [];
  let turnCounter = 0;
  let userTurnGroup = 0;

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (message?.role === "user") {
      userTurnGroup++;
      continue;
    }

    if (message?.role !== "assistant") continue;
    const currentTurnIndex = turnCounter++;
    const batch = captureThinkingFromAssistantEntry(entry, currentTurnIndex, config, indexer, userTurnGroup);
    if (batch) batches.push(batch);
  }

  return batches;
}

export function serializeBatchForSummarizer(batch: CapturedThinkingBatch): string {
  const parts: string[] = [];
  if (batch.assistantText) parts.push(`Visible assistant response:\n${batch.assistantText}\n`);

  const blockParts = batch.thinkingBlocks.map((block, index) => {
    let thinking = block.thinking;
    const MAX_CHARS = 2000;
    if (thinking.length > MAX_CHARS) {
      const remaining = thinking.length - MAX_CHARS;
      thinking = thinking.slice(0, MAX_CHARS) + ` ...[${remaining} chars truncated]`;
    }
    const meta = [
      `Thinking block ${index + 1}`,
      `ID: ${block.thinkingId}`,
      `Provider/model: ${block.provider ?? "unknown"}/${block.model ?? "unknown"}`,
      block.redacted ? "Redacted: true" : "Redacted: false",
    ].join("\n");
    return `${meta}\nContent:\n${thinking}`;
  });

  parts.push(blockParts.join("\n---\n"));
  return parts.join("\n");
}

export function serializeBatchesForSummarizer(batches: CapturedThinkingBatch[]): string {
  return batches
    .map((batch, i) => `=== Assistant turn ${batch.turnIndex}${i > 0 ? ` (batch ${i + 1})` : ""} ===\n${serializeBatchForSummarizer(batch)}`)
    .join("\n\n");
}

export function groupBatchesByMode(batches: CapturedThinkingBatch[], mode: BatchingMode): CapturedThinkingBatch[] {
  if (mode !== "agent-message") return batches;

  const out: CapturedThinkingBatch[] = [];
  let current: (CapturedThinkingBatch & { userTurnGroup: number }) | null = null;

  for (const batch of batches) {
    if (batch.userTurnGroup === undefined) {
      current = null;
      out.push(batch);
      continue;
    }

    if (current && current.userTurnGroup === batch.userTurnGroup) {
      current.assistantText = [current.assistantText, batch.assistantText].filter(Boolean).join("\n\n");
      current.thinkingBlocks = current.thinkingBlocks.concat(batch.thinkingBlocks);
      current.turnIndex = batch.turnIndex;
      current.timestamp = batch.timestamp;
    } else {
      current = { ...batch, userTurnGroup: batch.userTurnGroup };
      out.push(current);
    }
  }

  return out;
}
