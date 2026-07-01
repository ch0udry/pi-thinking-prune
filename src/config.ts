import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { BatchingMode, PruneOn, SummarizerThinking, ThinkingPruneConfig } from "./types.js";
import { BATCHING_MODES, DEFAULT_CONFIG, PRUNE_ON_MODES, SUMMARIZER_THINKING_LEVELS } from "./types.js";

export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "thinking-prune", "settings.json");

function isPruneOn(value: unknown): value is PruneOn {
  return typeof value === "string" && PRUNE_ON_MODES.some((mode) => mode.value === value);
}

function isBatchingMode(value: unknown): value is BatchingMode {
  return typeof value === "string" && BATCHING_MODES.some((mode) => mode.value === value);
}

function isSummarizerThinking(value: unknown): value is SummarizerThinking {
  return typeof value === "string" && SUMMARIZER_THINKING_LEVELS.some((level) => level.value === value);
}

export async function loadConfig(): Promise<ThinkingPruneConfig> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const existing = JSON.parse(raw);
    const merged = { ...DEFAULT_CONFIG, ...existing };
    return {
      ...merged,
      enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CONFIG.enabled,
      showStatusLine: typeof merged.showStatusLine === "boolean" ? merged.showStatusLine : DEFAULT_CONFIG.showStatusLine,
      summarizerModel: typeof merged.summarizerModel === "string" ? merged.summarizerModel : DEFAULT_CONFIG.summarizerModel,
      summarizerThinking: isSummarizerThinking(merged.summarizerThinking) ? merged.summarizerThinking : DEFAULT_CONFIG.summarizerThinking,
      pruneOn: isPruneOn(merged.pruneOn) ? merged.pruneOn : DEFAULT_CONFIG.pruneOn,
      batchingMode: isBatchingMode(merged.batchingMode) ? merged.batchingMode : DEFAULT_CONFIG.batchingMode,
      minRawCharsToPrune: Number.isFinite(merged.minRawCharsToPrune) && merged.minRawCharsToPrune >= 0 ? merged.minRawCharsToPrune : DEFAULT_CONFIG.minRawCharsToPrune,
      skipOversizedSummary: typeof merged.skipOversizedSummary === "boolean" ? merged.skipOversizedSummary : DEFAULT_CONFIG.skipOversizedSummary,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: ThinkingPruneConfig): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(config, null, 2));
}
