import type { ThinkingIndexer } from "./indexer.js";
import { isThinkingBlock, makePruneKey } from "./hash.js";

export function pruneMessages(messages: any[], indexer: Pick<ThinkingIndexer, "isSummarizedPruneKey">): any[] {
  let changed = false;
  const out: any[] = [];

  for (const msg of messages) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    let messageChanged = false;
    const kept = msg.content.filter((block: any) => {
      if (!isThinkingBlock(block)) return true;
      const pruneKey = makePruneKey(msg, block);
      if (indexer.isSummarizedPruneKey(pruneKey)) {
        messageChanged = true;
        changed = true;
        return false;
      }
      return true;
    });

    if (!messageChanged) {
      out.push(msg);
    } else if (kept.length > 0) {
      out.push({ ...msg, content: kept });
    }
  }

  return changed ? out : messages;
}
