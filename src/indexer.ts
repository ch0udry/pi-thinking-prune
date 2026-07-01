import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedThinkingBatch, IndexEntryData, SummaryThinkingRef, ThinkingBlockRecord } from "./types.js";
import { CUSTOM_TYPE_INDEX, CUSTOM_TYPE_SUMMARY } from "./types.js";
import { buildShortThinkingRefs, normalizeSummaryThinkingRefs } from "./summary-refs.js";

export class ThinkingIndexer {
  private index = new Map<string, ThinkingBlockRecord>();
  private pruneKeys = new Set<string>();
  private aliasToThinkingId = new Map<string, string>();
  private nextShortAliasNumber = 1;

  reconstructFromSession(ctx: ExtensionContext): void {
    this.index.clear();
    this.pruneKeys.clear();
    this.aliasToThinkingId.clear();
    this.nextShortAliasNumber = 1;

    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE_INDEX) {
        const data = (entry as any).data as IndexEntryData;
        if (data && Array.isArray(data.thinkingBlocks)) {
          for (const block of data.thinkingBlocks) this.addRecord(block);
        }
        continue;
      }

      if (entry.type === "custom_message" && (entry as any).customType === CUSTOM_TYPE_SUMMARY) {
        this.registerSummaryRefs(normalizeSummaryThinkingRefs((entry as any).details));
      }
    }
  }

  addRecord(record: ThinkingBlockRecord): void {
    this.index.set(record.thinkingId, record);
    this.pruneKeys.add(record.pruneKey);
  }

  addBatch(batch: CapturedThinkingBatch, pi: ExtensionAPI, summaries?: Map<string, string>): void {
    const records: ThinkingBlockRecord[] = batch.thinkingBlocks.map((block) => ({
      ...block,
      summary: summaries?.get(block.thinkingId),
    }));
    for (const record of records) this.addRecord(record);
    pi.appendEntry(CUSTOM_TYPE_INDEX, { thinkingBlocks: records } as IndexEntryData);
  }

  persistBatch(batch: CapturedThinkingBatch, appendEntry: (customType: string, data?: unknown) => void, summaries?: Map<string, string>): void {
    const records: ThinkingBlockRecord[] = batch.thinkingBlocks.map((block) => ({
      ...block,
      summary: summaries?.get(block.thinkingId),
    }));
    for (const record of records) this.addRecord(record);
    appendEntry(CUSTOM_TYPE_INDEX, { thinkingBlocks: records } as IndexEntryData);
  }

  isSummarized(thinkingId: string): boolean {
    return this.index.has(thinkingId);
  }

  isSummarizedPruneKey(pruneKey: string): boolean {
    return this.pruneKeys.has(pruneKey);
  }

  getIndex(): Map<string, ThinkingBlockRecord> {
    return this.index;
  }

  registerSummaryRefs(refs: SummaryThinkingRef[]): void {
    for (const ref of refs) {
      if (!ref.shortId || !ref.thinkingId) continue;
      if (ref.shortId !== ref.thinkingId) this.aliasToThinkingId.set(ref.shortId, ref.thinkingId);
      const match = /^th(\d+)$/.exec(ref.shortId);
      if (match) this.nextShortAliasNumber = Math.max(this.nextShortAliasNumber, Number(match[1]) + 1);
    }
  }

  allocateSummaryRefs(batch: CapturedThinkingBatch): SummaryThinkingRef[] {
    const ids = batch.thinkingBlocks.map((block) => block.thinkingId);
    const { refs, nextIndex } = buildShortThinkingRefs(ids, this.nextShortAliasNumber);
    this.nextShortAliasNumber = nextIndex;
    return refs;
  }

  resolveThinkingId(thinkingIdOrAlias: string): string | undefined {
    if (this.index.has(thinkingIdOrAlias)) return thinkingIdOrAlias;
    return this.aliasToThinkingId.get(thinkingIdOrAlias);
  }

  getRecord(thinkingIdOrAlias: string): ThinkingBlockRecord | undefined {
    const resolved = this.resolveThinkingId(thinkingIdOrAlias);
    return resolved ? this.index.get(resolved) : undefined;
  }

  lookup(ids: string[]): ThinkingBlockRecord[] {
    const out: ThinkingBlockRecord[] = [];
    for (const id of ids) {
      const record = this.getRecord(id);
      if (record) out.push(record);
    }
    return out;
  }
}
