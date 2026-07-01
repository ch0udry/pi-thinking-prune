import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CapturedThinkingBatch, FlushOptions, SummarizerStats, ThinkingPruneConfig } from "./types.js";
import { BATCHING_MODES, PRUNE_ON_MODES, STATUS_WIDGET_ID, SUMMARIZER_THINKING_LEVELS } from "./types.js";
import { saveConfig, SETTINGS_PATH } from "./config.js";
import type { ThinkingIndexer } from "./indexer.js";

export function setThinkingPruneStatusWidget(ctx: any, config: ThinkingPruneConfig, detail?: string | SummarizerStats): void {
  try {
    if (!config.showStatusLine) {
      ctx.ui.setStatus(STATUS_WIDGET_ID, undefined);
      return;
    }
    let suffix = "";
    if (typeof detail === "string") suffix = ` · ${detail}`;
    else if (detail) suffix = ` · ${detail.callCount} calls · $${detail.totalCost.toFixed(4)}`;
    ctx.ui.setStatus(STATUS_WIDGET_ID, `think-prune: ${config.enabled ? "on" : "off"} · ${config.pruneOn}${suffix}`);
  } catch {
    // UI may be unavailable in print/json mode.
  }
}

function helpText(): string {
  return [
    "pi-thinking-prune commands:",
    "  /thinking-pruner status",
    "  /thinking-pruner on | off",
    "  /thinking-pruner now",
    "  /thinking-pruner model [default|provider/model-id]",
    "  /thinking-pruner thinking [default|off|minimal|low|medium|high|xhigh]",
    "  /thinking-pruner prune-on [every-turn|on-demand|agent-message]",
    "  /thinking-pruner batching [turn|agent-message]",
    "  /thinking-pruner stats",
    "  /thinking-pruner help",
    `settings: ${SETTINGS_PATH}`,
  ].join("\n");
}

export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ThinkingPruneConfig },
  flushPending: (ctx: any, options?: FlushOptions) => Promise<any>,
  capturePendingBatches: (ctx: any) => CapturedThinkingBatch[],
  getStats: () => SummarizerStats,
  indexer: ThinkingIndexer,
): void {
  pi.registerCommand("thinking-pruner", {
    description: "Configure and run assistant thinking pruning",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";

      const persist = async () => {
        await saveConfig(currentConfig.value);
        setThinkingPruneStatusWidget(ctx, currentConfig.value, getStats());
      };

      if (sub === "help") {
        ctx.ui.notify(helpText(), "info");
        return;
      }

      if (sub === "on" || sub === "off") {
        currentConfig.value.enabled = sub === "on";
        await persist();
        ctx.ui.notify(`thinking-pruner: ${currentConfig.value.enabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      if (sub === "status") {
        const pending = capturePendingBatches(ctx).reduce((sum, b) => sum + b.thinkingBlocks.length, 0);
        const stats = getStats();
        ctx.ui.notify(
          [
            `thinking-pruner: ${currentConfig.value.enabled ? "ON" : "OFF"}`,
            `model: ${currentConfig.value.summarizerModel}`,
            `thinking: ${currentConfig.value.summarizerThinking}`,
            `pruneOn: ${currentConfig.value.pruneOn}`,
            `batching: ${currentConfig.value.batchingMode}`,
            `indexed blocks: ${indexer.getIndex().size}`,
            `pending blocks: ${pending}`,
            `summarizer calls: ${stats.callCount}, cost: $${stats.totalCost.toFixed(4)}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "now") {
        const result = await flushPending(ctx);
        ctx.ui.notify(`thinking-pruner: ${result.ok ? "flushed" : result.reason}`, result.ok ? "info" : "warning");
        return;
      }

      if (sub === "stats") {
        const stats = getStats();
        ctx.ui.notify(JSON.stringify(stats, null, 2), "info");
        return;
      }

      if (sub === "model") {
        const model = parts[1];
        if (!model) {
          ctx.ui.notify(`thinking-pruner model: ${currentConfig.value.summarizerModel}`, "info");
          return;
        }
        currentConfig.value.summarizerModel = model;
        await persist();
        ctx.ui.notify(`thinking-pruner model set: ${model}`, "info");
        return;
      }

      if (sub === "thinking") {
        const level = parts[1];
        if (!level) {
          ctx.ui.notify(`thinking-pruner thinking: ${currentConfig.value.summarizerThinking}`, "info");
          return;
        }
        if (!SUMMARIZER_THINKING_LEVELS.some((x) => x.value === level)) {
          ctx.ui.notify(`Invalid thinking level: ${level}`, "error");
          return;
        }
        currentConfig.value.summarizerThinking = level as any;
        await persist();
        ctx.ui.notify(`thinking-pruner thinking set: ${level}`, "info");
        return;
      }

      if (sub === "prune-on") {
        const mode = parts[1];
        if (!mode) {
          ctx.ui.notify(`thinking-pruner prune-on: ${currentConfig.value.pruneOn}`, "info");
          return;
        }
        if (!PRUNE_ON_MODES.some((x) => x.value === mode)) {
          ctx.ui.notify(`Invalid prune-on mode: ${mode}`, "error");
          return;
        }
        currentConfig.value.pruneOn = mode as any;
        await persist();
        ctx.ui.notify(`thinking-pruner prune-on set: ${mode}`, "info");
        return;
      }

      if (sub === "batching") {
        const mode = parts[1];
        if (!mode) {
          ctx.ui.notify(`thinking-pruner batching: ${currentConfig.value.batchingMode}`, "info");
          return;
        }
        if (!BATCHING_MODES.some((x) => x.value === mode)) {
          ctx.ui.notify(`Invalid batching mode: ${mode}`, "error");
          return;
        }
        currentConfig.value.batchingMode = mode as any;
        await persist();
        ctx.ui.notify(`thinking-pruner batching set: ${mode}`, "info");
        return;
      }

      ctx.ui.notify(helpText(), "warning");
    },
  });
}
