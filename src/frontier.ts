import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingPruneFrontier } from "./types.js";
import { CUSTOM_TYPE_FRONTIER } from "./types.js";

/** Tracks the most recent completed thinking-prune attempt boundary. */
export class ThinkingPruneFrontierTracker {
  private frontier: ThinkingPruneFrontier | null = null;

  reset(): void {
    this.frontier = null;
  }

  get(): ThinkingPruneFrontier | null {
    return this.frontier ? { ...this.frontier } : null;
  }

  fromJSON(data: ThinkingPruneFrontier): void {
    if (!data?.lastAttemptedThinkingId) return;
    this.frontier = {
      lastAttemptedThinkingId: data.lastAttemptedThinkingId,
      lastAttemptedMessageEntryId: data.lastAttemptedMessageEntryId ?? "unknown",
      lastAttemptedBlockIndex: data.lastAttemptedBlockIndex ?? 0,
      lastAttemptedTurnIndex: data.lastAttemptedTurnIndex ?? 0,
      lastAttemptedTimestamp: data.lastAttemptedTimestamp ?? 0,
      attemptedBatchCount: data.attemptedBatchCount ?? 0,
      attemptedThinkingBlockCount: data.attemptedThinkingBlockCount ?? 0,
      rawCharCount: data.rawCharCount ?? 0,
      summaryCharCount: data.summaryCharCount ?? 0,
      outcome: data.outcome ?? "summarized",
    };
  }

  reconstructFromSession(ctx: ExtensionContext): void {
    this.reset();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE_FRONTIER) {
        const data = (entry as any).data as ThinkingPruneFrontier;
        if (data) this.fromJSON(data);
      }
    }
  }

  advance(frontier: ThinkingPruneFrontier): void {
    this.frontier = { ...frontier };
  }

  persist(pi: ExtensionAPI): void {
    if (!this.frontier) return;
    pi.appendEntry(CUSTOM_TYPE_FRONTIER, this.frontier);
  }
}
