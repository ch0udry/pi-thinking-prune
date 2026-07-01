import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import type { CapturedThinkingBatch, FlushOptions, SummarizerStats, ThinkingPruneConfig } from "./types.js";
import { BATCHING_MODES, CUSTOM_TYPE_SUMMARY, PROGRESS_WIDGET_ID, PRUNE_ON_MODES, STATUS_WIDGET_ID, SUMMARIZER_THINKING_LEVELS } from "./types.js";
import { saveConfig, SETTINGS_PATH } from "./config.js";
import { formatCharProgress, formatCost, formatTokens } from "./stats.js";
import type { ThinkingIndexer } from "./indexer.js";
import { normalizeSummaryThinkingRefs } from "./summary-refs.js";

class SettingsOverlay extends Container {
  constructor(
    title: string,
    private readonly settingsList: SettingsList,
  ) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Text(title, 0, 0));
    this.addChild(settingsList);
    this.addChild(new DynamicBorder());
  }

  handleInput(data: string) {
    this.settingsList.handleInput(data);
  }

  invalidate() {
    this.settingsList.invalidate();
  }
}

const SUBCOMMANDS = [
  { value: "settings", label: "settings  — interactive settings overlay" },
  { value: "on", label: "on        — enable thinking pruning" },
  { value: "off", label: "off       — disable thinking pruning" },
  { value: "status", label: "status    — show status, model, thinking, trigger, batching, and stats" },
  { value: "model", label: "model     — show or set the summarizer model" },
  { value: "thinking", label: "thinking  — show or set the summarizer thinking level" },
  { value: "prune-on", label: "prune-on  — show or set the trigger mode" },
  { value: "batching", label: "batching  — show or set the batching mode" },
  { value: "stats", label: "stats     — show cumulative summarizer token/cost stats" },
  { value: "tree", label: "tree      — browse pruned thinking blocks" },
  { value: "now", label: "now       — flush pending thinking blocks immediately" },
  { value: "help", label: "help      — show this help" },
 ] as const;

const THINKING_MODE_GUIDANCE: Record<ThinkingPruneConfig["pruneOn"], string> = {
  "every-turn": "Debugging only. Summarizes after every assistant message and can churn provider prompt caches.",
  "on-demand": "Maximum manual control. Nothing is pruned until /thinking-pruner now runs.",
  "agent-message": "Recommended default. Batches thinking until the final text reply, then prunes once for future turns.",
};

function pruneModeLabel(mode: ThinkingPruneConfig["pruneOn"]): string {
  return PRUNE_ON_MODES.find((entry) => entry.value === mode)?.label ?? mode;
}

function batchingModeLabel(mode: ThinkingPruneConfig["batchingMode"]): string {
  return BATCHING_MODES.find((entry) => entry.value === mode)?.label ?? mode;
}

function summarizerThinkingLabel(level: ThinkingPruneConfig["summarizerThinking"]): string {
  return SUMMARIZER_THINKING_LEVELS.find((entry) => entry.value === level)?.label ?? level;
}

function summarizerThinkingDescription(level: ThinkingPruneConfig["summarizerThinking"]): string {
  if (level === "default") return "Send no explicit thinking option for summarizer calls.";
  if (level === "off") return "Request no summarizer reasoning where the provider adapter supports it.";
  return `Request ${level} thinking/reasoning for summarizer calls where supported.`;
}

function parseModelAndThinkingArg(value: string): { model: string; thinking?: ThinkingPruneConfig["summarizerThinking"]; error?: string } {
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex === -1) return { model: value };
  const model = value.slice(0, separatorIndex);
  const suffix = value.slice(separatorIndex + 1);
  const thinking = SUMMARIZER_THINKING_LEVELS.find((level) => level.value === suffix)?.value;
  if (!model || !thinking) {
    return {
      model: value,
      error: `Invalid model thinking suffix: ${suffix}. Use one of: ${SUMMARIZER_THINKING_LEVELS.map((level) => level.value).join(", ")}.`,
    };
  }
  return { model, thinking };
}

function pruneStatusText(config: ThinkingPruneConfig, stats?: SummarizerStats): string {
  let text = `think-prune: ${config.enabled ? "ON" : "OFF"} (${pruneModeLabel(config.pruneOn)})`;
  if (stats && stats.callCount > 0) {
    text += ` │ ↑${formatTokens(stats.totalInputTokens)} ↓${formatTokens(stats.totalOutputTokens)} ${formatCost(stats.totalCost)}`;
  }
  return text;
}

export function setThinkingPruneStatusWidget(ctx: any, config: ThinkingPruneConfig, detail?: string | SummarizerStats): void {
  try {
    if (!config.showStatusLine) {
      ctx.ui.setStatus(STATUS_WIDGET_ID, undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_WIDGET_ID, typeof detail === "string" ? detail : pruneStatusText(config, detail));
  } catch {
    // UI may be unavailable in print/json mode.
  }
}

function helpText(): string {
  return `thinking-pruner — summarizes assistant thinking blocks and prunes raw thinking from future context.

Usage:
  /thinking-pruner settings                         Interactive settings overlay
  /thinking-pruner on                               Enable thinking pruning
  /thinking-pruner off                              Disable thinking pruning
  /thinking-pruner status                           Show status, model, trigger, batching, and stats
  /thinking-pruner model                            Show current summarizer model
  /thinking-pruner model <id>                       Set summarizer model, e.g. anthropic/claude-haiku-3-5
  /thinking-pruner model <id>:<thinking>            Set model and thinking together, e.g. openai/gpt-5-mini:low
  /thinking-pruner thinking <level>                 Set summarizer thinking: default, off, minimal, low, medium, high, xhigh
  /thinking-pruner prune-on                         Show or interactively pick trigger
  /thinking-pruner prune-on every-turn              Summarize after every assistant message
  /thinking-pruner prune-on on-demand               Only summarize when /thinking-pruner now runs
  /thinking-pruner prune-on agent-message           Summarize after final text reply
  /thinking-pruner batching                         Show or interactively pick batching granularity
  /thinking-pruner batching turn                    One summary per assistant message
  /thinking-pruner batching agent-message           One summary per user→final-agent-message span
  /thinking-pruner stats                            Show cumulative summarizer token/cost stats
  /thinking-pruner tree                             Browse pruned thinking blocks
  /thinking-pruner now                              Flush pending thinking blocks with live progress
  /thinking-pruner help                             Show this help

Settings are saved to ${SETTINGS_PATH}`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;
type RowStatus = "pending" | "running" | "done" | "skipped";

function startThinkingPrunerWidget(ctx: ExtensionCommandContext, batches: CapturedThinkingBatch[]) {
  const rows = batches.map((batch, index) => ({
    label: `Batch ${index + 1}/${batches.length}`,
    blockCount: batch.thinkingBlocks.length,
    rawChars: batch.thinkingBlocks.reduce((sum, block) => sum + block.charCount, 0),
    status: "pending" as RowStatus,
    receivedChars: 0,
  }));
  let requestRender: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const hasRunningRows = () => rows.some((row) => row.status === "running");
  const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
  const sync = () => {
    if (!timer && requestRender && hasRunningRows()) {
      timer = setInterval(() => {
        if (!hasRunningRows()) { stop(); return; }
        requestRender?.();
      }, SPINNER_INTERVAL_MS);
      timer.unref?.();
    }
    if (!hasRunningRows()) stop();
    requestRender?.();
  };

  ctx.ui.setWidget(
    PROGRESS_WIDGET_ID,
    (tui) => {
      requestRender = () => tui.requestRender();
      sync();
      return {
        invalidate() {},
        render() {
          return rows.map((row) => {
            const count = `${row.blockCount} thinking block${row.blockCount === 1 ? "" : "s"}`;
            if (row.status === "running") {
              const frame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
              const chars = row.receivedChars > 0 ? ` · ${formatCharProgress(row.receivedChars, row.rawChars)}` : "";
              return `${frame} ${row.label} · ${count}${chars}`;
            }
            if (row.status === "done") return `✓ ${row.label} · ${count} · ${formatCharProgress(row.receivedChars, row.rawChars)}`;
            if (row.status === "skipped") return `⚠ ${row.label} · ${count} · skipped`;
            return `○ ${row.label} · ${count} · pending`;
          });
        },
      };
    },
    { placement: "aboveEditor" },
  );

  return {
    updateRow(index: number, status: RowStatus, chars?: number) {
      if (index < 0 || index >= rows.length) return;
      rows[index].status = status;
      if (chars !== undefined) rows[index].receivedChars = chars;
      sync();
    },
    clearWidget() {
      stop();
      requestRender = undefined;
      ctx.ui.setWidget(PROGRESS_WIDGET_ID, undefined);
    },
  };
}

function buildTreeText(indexer: ThinkingIndexer): string {
  const records = [...indexer.getIndex().values()];
  if (records.length === 0) return "No pruned thinking blocks found in this session.";
  return records
    .map((record, index) => {
      const preview = record.thinking.replace(/\s+/g, " ").slice(0, 120);
      return `${index + 1}. ${record.thinkingId}\n   message: ${record.messageEntryId} block: ${record.blockIndex} model: ${record.provider ?? "unknown"}/${record.model ?? "unknown"}\n   ${preview}${record.thinking.length > 120 ? "…" : ""}`;
    })
    .join("\n\n");
}

export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ThinkingPruneConfig },
  flushPending: (ctx: ExtensionCommandContext, options?: FlushOptions) => Promise<
    | { ok: true; reason: "flushed" | "skipped-oversized"; batchCount: number; blockCount: number; rawCharCount: number; summaryCharCount: number }
    | { ok: false; reason: string; error?: string }
  >,
  capturePendingBatches: (ctx: ExtensionCommandContext) => CapturedThinkingBatch[],
  getStats: () => SummarizerStats,
  indexer: ThinkingIndexer,
 ): void {
  pi.registerCommand("thinking-pruner", {
    description: "Thinking-prune settings and commands",
    getArgumentCompletions(prefix: string) {
      return SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      let subcommand = parts[0];
      const subArgs = parts.slice(1);

      const persist = async () => {
        await saveConfig(currentConfig.value);
        setThinkingPruneStatusWidget(ctx, currentConfig.value, getStats());
      };

      if (!subcommand) {
        const choice = await ctx.ui.select("thinking-pruner — choose a subcommand", SUBCOMMANDS.map((s) => s.label));
        if (!choice) return;
        subcommand = choice.split(/\s+/)[0];
      }

      switch (subcommand) {
        case "settings": {
          const config = currentConfig.value;
          const availableModels = ctx.modelRegistry?.getAvailable() ?? [];
          const items: SettingItem[] = [
            { id: "enabled", label: "Enabled", values: ["true", "false"], currentValue: String(config.enabled), description: "Enable or disable thinking pruning" },
            { id: "showStatusLine", label: "Status line", values: ["true", "false"], currentValue: String(config.showStatusLine), description: "Show the thinking-prune footer status line" },
            { id: "pruneOn", label: "Prune trigger", values: PRUNE_ON_MODES.map((m) => m.value), currentValue: config.pruneOn, description: THINKING_MODE_GUIDANCE[config.pruneOn] },
            {
              id: "summarizerModel",
              label: "Summarizer model",
              values: [config.summarizerModel],
              currentValue: config.summarizerModel,
              description: "Model used for summarizing thinking blocks — press Enter to browse models",
              submenu: (currentValue: string, done: (newValue?: string) => void) => {
                const modelItems: SettingItem[] = [
                  { id: "default", label: "default (active model)", values: ["default"], currentValue: currentValue === "default" ? "default" : "", description: "Use the currently active model for summarization" },
                  ...availableModels.map((m: any) => {
                    const displayId = `${m.provider}/${m.id}`;
                    return { id: displayId, label: displayId, values: [displayId], currentValue: currentValue === displayId ? displayId : "", description: m.name || displayId };
                  }),
                ];
                return new SettingsList(modelItems, 15, getSettingsListTheme(), (_id: string, newValue: string) => done(newValue), () => done(undefined), { enableSearch: true });
              },
            },
            { id: "summarizerThinking", label: "Summarizer thinking", values: SUMMARIZER_THINKING_LEVELS.map((level) => level.value), currentValue: config.summarizerThinking, description: summarizerThinkingDescription(config.summarizerThinking) },
            { id: "batchingMode", label: "Batching mode", values: BATCHING_MODES.map((m) => m.value), currentValue: config.batchingMode, description: "Choose summary granularity" },
            { id: "minRawCharsToPrune", label: "Minimum raw chars", values: [String(config.minRawCharsToPrune)], currentValue: String(config.minRawCharsToPrune), description: "Minimum thinking block length to summarize/prune" },
            { id: "skipOversizedSummary", label: "Skip oversized summaries", values: ["true", "false"], currentValue: String(config.skipOversizedSummary), description: "Match context-prune behavior: skip if summary is bigger than raw thinking" },
          ];

          let settingsList: SettingsList;
          let close = () => {};
          const onChange = (id: string, newValue: string) => {
            const next = { ...currentConfig.value };
            if (id === "enabled") next.enabled = newValue === "true";
            else if (id === "showStatusLine") next.showStatusLine = newValue === "true";
            else if (id === "pruneOn") next.pruneOn = newValue as ThinkingPruneConfig["pruneOn"];
            else if (id === "summarizerModel") next.summarizerModel = newValue;
            else if (id === "summarizerThinking") next.summarizerThinking = newValue as ThinkingPruneConfig["summarizerThinking"];
            else if (id === "batchingMode") next.batchingMode = newValue as ThinkingPruneConfig["batchingMode"];
            else if (id === "minRawCharsToPrune") next.minRawCharsToPrune = Math.max(0, Number(newValue) || 0);
            else if (id === "skipOversizedSummary") next.skipOversizedSummary = newValue === "true";
            currentConfig.value = next;
            saveConfig(next);
            setThinkingPruneStatusWidget(ctx, next, getStats());
            settingsList?.invalidate();
          };

          settingsList = new SettingsList(items, 10, getSettingsListTheme(), onChange, () => close(), { enableSearch: false });
          await ctx.ui.custom((_tui, _theme, _keybindings, done) => {
            close = () => done(undefined);
            return new SettingsOverlay("thinking-pruner settings", settingsList);
          }, { overlay: true, overlayOptions: { width: 64 } });
          break;
        }

        case "on":
          currentConfig.value = { ...currentConfig.value, enabled: true };
          await persist();
          ctx.ui.notify("Thinking pruning enabled.");
          break;

        case "off":
          currentConfig.value = { ...currentConfig.value, enabled: false };
          await persist();
          ctx.ui.notify("Thinking pruning disabled.");
          break;

        case "status": {
          const cfg = currentConfig.value;
          const s = getStats();
          const pending = capturePendingBatches(ctx).reduce((sum, b) => sum + b.thinkingBlocks.length, 0);
          const statsLine = s.callCount > 0 ? `\n  --- summarizer ---\n  calls:       ${s.callCount}\n  input:       ${formatTokens(s.totalInputTokens)} tokens\n  output:      ${formatTokens(s.totalOutputTokens)} tokens\n  cost:        ${formatCost(s.totalCost)}` : "\n  (no summarizer calls yet)";
          ctx.ui.notify(`thinking-pruner status:\n  enabled:  ${cfg.enabled}\n  model:    ${cfg.summarizerModel}\n  thinking: ${summarizerThinkingLabel(cfg.summarizerThinking)} (${cfg.summarizerThinking})\n  trigger:  ${pruneModeLabel(cfg.pruneOn)} (${cfg.pruneOn})\n  batching: ${batchingModeLabel(cfg.batchingMode)} (${cfg.batchingMode})\n  status:   ${cfg.showStatusLine ? "on" : "off"}\n  indexed:  ${indexer.getIndex().size}\n  pending:  ${pending}${statsLine}`);
          break;
        }

        case "tree": {
          await ctx.ui.custom((_tui, _theme, _keybindings, done) => {
            const text = new Text(buildTreeText(indexer), 0, 0);
            return {
              handleInput(data: string) { if (data === "\u001b" || data === "q") done(undefined); },
              render(width: number) { return text.render(width); },
              invalidate() {},
            };
          }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "70%", anchor: "center" } });
          break;
        }

        case "stats": {
          const s = getStats();
          if (s.callCount === 0) ctx.ui.notify("thinking-pruner stats: no summarizer calls yet.");
          else ctx.ui.notify(`thinking-pruner stats:\n  calls:       ${s.callCount}\n  input:       ${formatTokens(s.totalInputTokens)} tokens\n  output:      ${formatTokens(s.totalOutputTokens)} tokens\n  cost:        ${formatCost(s.totalCost)}`);
          break;
        }

        case "model": {
          const modelArg = subArgs[0];
          if (!modelArg) {
            ctx.ui.notify(`Current summarizer model: ${currentConfig.value.summarizerModel}\nCurrent summarizer thinking: ${summarizerThinkingLabel(currentConfig.value.summarizerThinking)} (${currentConfig.value.summarizerThinking})`);
          } else {
            const parsed = parseModelAndThinkingArg(modelArg);
            if (parsed.error) { ctx.ui.notify(parsed.error, "warning"); return; }
            currentConfig.value = { ...currentConfig.value, summarizerModel: parsed.model, summarizerThinking: parsed.thinking ?? currentConfig.value.summarizerThinking };
            await persist();
            ctx.ui.notify(`Summarizer model set to: ${parsed.model}${parsed.thinking ? ` with thinking ${parsed.thinking}` : ""}`);
          }
          break;
        }

        case "thinking": {
          const thinkingArg = subArgs[0];
          if (!thinkingArg) {
            ctx.ui.notify(`Current summarizer thinking: ${summarizerThinkingLabel(currentConfig.value.summarizerThinking)} (${currentConfig.value.summarizerThinking})`);
            return;
          }
          if (!SUMMARIZER_THINKING_LEVELS.some((level) => level.value === thinkingArg)) {
            ctx.ui.notify(`Invalid summarizer thinking level: ${thinkingArg}. Use one of: ${SUMMARIZER_THINKING_LEVELS.map((level) => level.value).join(", ")}.`, "warning");
            return;
          }
          currentConfig.value = { ...currentConfig.value, summarizerThinking: thinkingArg as ThinkingPruneConfig["summarizerThinking"] };
          await persist();
          ctx.ui.notify(`Summarizer thinking set to: ${currentConfig.value.summarizerThinking}`);
          break;
        }

        case "prune-on": {
          const modeArg = subArgs[0];
          if (!modeArg) {
            const choice = await ctx.ui.select("thinking-pruner — choose when to trigger summarization", PRUNE_ON_MODES.map((m) => `${m.value} — ${m.label}`));
            if (!choice) return;
            currentConfig.value = { ...currentConfig.value, pruneOn: choice.split(/\s+/)[0] as ThinkingPruneConfig["pruneOn"] };
          } else {
            if (!PRUNE_ON_MODES.some((m) => m.value === modeArg)) { ctx.ui.notify(`Invalid prune-on mode: ${modeArg}`, "warning"); return; }
            currentConfig.value = { ...currentConfig.value, pruneOn: modeArg as ThinkingPruneConfig["pruneOn"] };
          }
          await persist();
          break;
        }

        case "batching": {
          const batchArg = subArgs[0];
          if (!batchArg) {
            const choice = await ctx.ui.select("thinking-pruner — choose batching granularity", BATCHING_MODES.map((m) => `${m.value} — ${m.label}`));
            if (!choice) return;
            currentConfig.value = { ...currentConfig.value, batchingMode: choice.split(/\s+/)[0] as ThinkingPruneConfig["batchingMode"] };
          } else {
            if (!BATCHING_MODES.some((m) => m.value === batchArg)) { ctx.ui.notify(`Invalid batching mode: ${batchArg}`, "warning"); return; }
            currentConfig.value = { ...currentConfig.value, batchingMode: batchArg as ThinkingPruneConfig["batchingMode"] };
          }
          await persist();
          ctx.ui.notify(`Batching mode set to: ${batchingModeLabel(currentConfig.value.batchingMode)}`);
          break;
        }

        case "now": {
          if (!currentConfig.value.enabled) { ctx.ui.notify("Thinking pruning is disabled. Run /thinking-pruner on first.", "warning"); return; }
          const batches = capturePendingBatches(ctx);
          if (batches.length === 0) { ctx.ui.notify("thinking-pruner: nothing pending — no batches to summarize", "info"); break; }
          const { updateRow, clearWidget } = startThinkingPrunerWidget(ctx, batches);
          const result = await flushPending(ctx, {
            previewedBatches: batches,
            onProgress: (index, _total, _batch, stage) => updateRow(index, stage === "start" ? "running" : stage === "done" ? "done" : "skipped"),
            onBatchTextProgress: (index, _total, _batch, receivedChars) => updateRow(index, "running", receivedChars),
          });
          clearWidget();
          setThinkingPruneStatusWidget(ctx, currentConfig.value, getStats());
          if (!result.ok) {
            const suffix = "error" in result && result.error ? ` (${result.error})` : "";
            ctx.ui.notify(`thinking-pruner: nothing flushed — ${result.reason}${suffix}`, result.reason === "empty" ? "info" : "warning");
            break;
          }
          if (result.reason === "skipped-oversized") {
            ctx.ui.notify(`thinking-pruner: skipped pruning ${result.blockCount} thinking block${result.blockCount === 1 ? "" : "s"} — summary was ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars; frontier advanced past this range`, "warning");
            break;
          }
          ctx.ui.notify(`thinking-pruner: pruned ${result.blockCount} thinking block${result.blockCount === 1 ? "" : "s"} from ${result.batchCount} batch${result.batchCount === 1 ? "" : "es"} — summary ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars`, "info");
          break;
        }

        case "help":
          ctx.ui.notify(helpText());
          break;

        default:
          ctx.ui.notify(`Unknown subcommand: "${subcommand}". Run /thinking-pruner help for usage.`);
      }
    },
  });

  pi.registerMessageRenderer(CUSTOM_TYPE_SUMMARY, (message, { expanded }, theme) => {
    const details = message.details as { thinkingRefs?: { shortId: string; thinkingId: string }[]; thinkingIds?: string[]; turnIndex?: number };
    const turnIndex = details?.turnIndex ?? "?";
    const thinkingCount = normalizeSummaryThinkingRefs(details).length;
    const header = theme.fg("accent", `[thinking-pruner] Turn ${turnIndex} summary (${thinkingCount} thinking block${thinkingCount === 1 ? "" : "s"})`);
    if (expanded) return new Text(header + "\n" + message.content, 0, 0);
    return new Text(header, 0, 0);
  });
}
