import { stream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CapturedThinkingBatch,
  SummarizeBatchOptions,
  SummarizeBatchesOptions,
  SummarizeResult,
  SummarizerThinking,
  ThinkingPruneConfig,
} from "./types.js";
import { serializeBatchForSummarizer } from "./thinking-capture.js";

const SYSTEM_PROMPT = `You summarize assistant thinking blocks for future context.

Do NOT reproduce private chain-of-thought step-by-step. Extract only operational value:
- decisions made
- assumptions or constraints
- files, APIs, commands, or facts that matter later
- risks, failed paths, or next-step relevance

For each thinking block, write 1-3 concise bullets. Avoid phrases like "the assistant thought". Keep summaries compact.`;

export function summarizerThinkingOptions(config: ThinkingPruneConfig): Record<string, unknown> {
  const level: SummarizerThinking = config.summarizerThinking;
  if (level === "default") return {};
  return { reasoningEffort: level === "off" ? undefined : level };
}

export function resolveModel(config: ThinkingPruneConfig, ctx: ExtensionContext): any {
  if (config.summarizerModel === "default") return ctx.model;

  const slashIndex = config.summarizerModel.indexOf("/");
  if (slashIndex === -1) {
    ctx.ui.notify(`thinking-pruner: invalid summarizerModel "${config.summarizerModel}"; expected "provider/model-id". Using active model.`, "warning");
    return ctx.model;
  }

  const provider = config.summarizerModel.slice(0, slashIndex);
  const modelId = config.summarizerModel.slice(slashIndex + 1);
  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(`thinking-pruner: model "${config.summarizerModel}" not found. Using active model.`, "warning");
    return ctx.model;
  }
  return found;
}

function receivedTextChars(message: AssistantMessage): number {
  return message.content.reduce((sum, content) => content.type === "text" ? sum + content.text.length : sum, 0);
}

export async function summarizeBatch(
  batch: CapturedThinkingBatch,
  config: ThinkingPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {},
): Promise<SummarizeResult | null> {
  if (options.signal?.aborted) throw new Error("summarizeBatch: aborted before start");

  try {
    const model = resolveModel(config, ctx);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      ctx.ui.notify(`thinking-pruner: summarization failed: ${authMessage}`, "error");
      return null;
    }

    const serialized = serializeBatchForSummarizer(batch);
    const userMessage = `${SYSTEM_PROMPT}\n\n<thinking-block-batch>\n${serialized}\n</thinking-block-batch>`;

    const responseStream = stream(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers, signal: options.signal, ...summarizerThinkingOptions(config) },
    );

    let lastReportedChars = -1;
    options.onTextProgress?.(0);
    const report = (message: AssistantMessage) => {
      const chars = receivedTextChars(message);
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        options.onTextProgress?.(chars);
      }
    };

    for await (const event of responseStream) {
      if (options.signal?.aborted) break;
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") report(event.partial);
    }

    if (options.signal?.aborted) throw new Error("summarizeBatch: aborted during stream");
    const response = await responseStream.result();
    report(response);
    if (response.stopReason === "aborted") throw new Error("summarizeBatch: stream stopped with reason aborted");
    if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Summarizer stopped with reason: error");

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();

    return { summaryText: llmText, usage: response.usage };
  } catch (err: any) {
    if (options.signal?.aborted) throw err;
    ctx.ui.notify(`thinking-pruner: summarization failed: ${err.message}`, "error");
    return null;
  }
}

export async function summarizeBatches(
  batches: CapturedThinkingBatch[],
  config: ThinkingPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {},
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];
  if (batches.length === 1) {
    return [
      await summarizeBatch(batches[0], config, ctx, {
        signal: options.signal,
        onTextProgress: (chars) => options.onBatchTextProgress?.(0, 1, batches[0], chars),
      }),
    ];
  }

  return Promise.all(
    batches.map((batch, index) =>
      summarizeBatch(batch, config, ctx, {
        signal: options.signal,
        onTextProgress: (chars) => options.onBatchTextProgress?.(index, batches.length, batch, chars),
      }),
    ),
  );
}
