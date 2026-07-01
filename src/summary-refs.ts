import type { CapturedThinkingBatch, SummaryThinkingRef } from "./types.js";

const SHORT_ID_PREFIX = "th";

export function buildShortThinkingRefs(thinkingIds: string[], startIndex: number): { refs: SummaryThinkingRef[]; nextIndex: number } {
  const refs = thinkingIds.map((thinkingId, offset) => ({
    shortId: `${SHORT_ID_PREFIX}${startIndex + offset}`,
    thinkingId,
  }));
  return { refs, nextIndex: startIndex + refs.length };
}

export function normalizeSummaryThinkingRefs(details: unknown): SummaryThinkingRef[] {
  if (!details || typeof details !== "object") return [];
  const raw = details as { thinkingRefs?: unknown; thinkingIds?: unknown };
  if (Array.isArray(raw.thinkingRefs)) {
    return raw.thinkingRefs
      .filter((ref): ref is SummaryThinkingRef => {
        return !!ref && typeof (ref as any).shortId === "string" && typeof (ref as any).thinkingId === "string";
      })
      .map((ref) => ({ shortId: ref.shortId, thinkingId: ref.thinkingId }));
  }
  if (Array.isArray(raw.thinkingIds)) {
    return raw.thinkingIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => ({ shortId: id, thinkingId: id }));
  }
  return [];
}

export function formatSummaryThinkingRefs(refs: SummaryThinkingRef[]): string {
  const refList = refs.map((ref) => `\`${ref.shortId}\``).join(", ");
  return (
    `\n\n---\n**Summarized thinking refs**: ${refList}\n` +
    "Use `thinking_tree_query` with these refs to retrieve the original full thinking blocks."
  );
}

export function makeSummaryDetails(batch: CapturedThinkingBatch, refs: SummaryThinkingRef[]) {
  return {
    thinkingRefs: refs,
    thinkingIds: batch.thinkingBlocks.map((block) => block.thinkingId),
    turnIndex: batch.turnIndex,
    timestamp: batch.timestamp,
    rawCharCount: batch.thinkingBlocks.reduce((sum, block) => sum + block.charCount, 0),
  };
}
