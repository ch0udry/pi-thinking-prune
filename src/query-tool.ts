import { Type } from "@sinclair/typebox";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingIndexer } from "./indexer.js";

export function registerQueryTool(pi: ExtensionAPI, indexer: ThinkingIndexer): void {
  pi.registerTool({
    name: "thinking_tree_query",
    label: "Query Original Thinking History",
    description:
      "Retrieve original assistant thinking blocks that have been summarized and pruned from active context. Pass the short refs from a thinking-prune-summary message.",
    promptSnippet: "Retrieve original pruned assistant thinking blocks by short ref",
    promptGuidelines: [
      "When you need an original assistant thinking block that was summarized and pruned from context, use thinking_tree_query with the short refs listed in the relevant thinking-prune-summary message.",
    ],
    parameters: Type.Object({
      thinkingIds: Type.Array(Type.String({ description: "One or more short refs or thinking IDs to retrieve" }), {
        description: "List of short refs or thinking IDs to look up",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const foundRecords: Record<string, any> = {};
      const blocks: string[] = [];

      for (const id of params.thinkingIds) {
        const record = indexer.getRecord(id);
        if (!record) {
          blocks.push(`## thinkingRef: ${id}\n(not found in index — may not have been summarized yet)`);
          continue;
        }

        foundRecords[id] = record;
        const header = [
          `## thinkingRef: ${id}`,
          `Thinking ID: ${record.thinkingId}`,
          `Assistant message entry: ${record.messageEntryId}`,
          `Block index: ${record.blockIndex}`,
          `Provider/model: ${record.provider ?? "unknown"}/${record.model ?? "unknown"}`,
          `Turn: ${record.timestamp}`,
          record.redacted ? "Redacted: true" : "Redacted: false",
          "",
        ].join("\n");

        const t = truncateHead(record.thinking, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let body = t.content;
        if (t.truncated) body += `\n[Output truncated: ${t.outputLines}/${t.totalLines} lines shown]`;
        blocks.push(`${header}\n${body}`);
      }

      return {
        content: [{ type: "text", text: blocks.join("\n\n---\n\n") }],
        details: { results: foundRecords },
      };
    },
  });
}
