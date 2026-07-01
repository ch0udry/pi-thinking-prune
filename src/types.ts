export const CUSTOM_TYPE_SUMMARY = "thinking-prune-summary";
export const CUSTOM_TYPE_INDEX = "thinking-prune-index";
export const CUSTOM_TYPE_STATS = "thinking-prune-stats";
export const STATUS_WIDGET_ID = "thinking-prune";

export type PruneOn = "every-turn" | "on-demand" | "agent-message";
export type BatchingMode = "turn" | "agent-message";
export type SummarizerThinking = "default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const PRUNE_ON_MODES: { value: PruneOn; label: string }[] = [
  { value: "every-turn", label: "Every assistant message" },
  { value: "on-demand", label: "On demand" },
  { value: "agent-message", label: "On final agent message" },
];

export const BATCHING_MODES: { value: BatchingMode; label: string }[] = [
  { value: "turn", label: "Per assistant message" },
  { value: "agent-message", label: "Per user→agent span" },
];

export const SUMMARIZER_THINKING_LEVELS: { value: SummarizerThinking; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

export interface ThinkingPruneConfig {
  enabled: boolean;
  showStatusLine: boolean;
  summarizerModel: string;
  summarizerThinking: SummarizerThinking;
  pruneOn: PruneOn;
  batchingMode: BatchingMode;
  minRawCharsToPrune: number;
  skipOversizedSummary: boolean;
}

export const DEFAULT_CONFIG: ThinkingPruneConfig = {
  enabled: false,
  showStatusLine: true,
  summarizerModel: "default",
  summarizerThinking: "off",
  pruneOn: "agent-message",
  batchingMode: "turn",
  minRawCharsToPrune: 0,
  skipOversizedSummary: false,
};

export interface CapturedThinkingBlock {
  thinkingId: string;
  pruneKey: string;
  messageEntryId: string;
  blockIndex: number;
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
  provider?: string;
  model?: string;
  api?: string;
  timestamp: number;
  assistantText: string;
  charCount: number;
}

export interface CapturedThinkingBatch {
  turnIndex: number;
  timestamp: number;
  assistantText: string;
  thinkingBlocks: CapturedThinkingBlock[];
  userTurnGroup?: number;
}

export interface ThinkingBlockRecord extends CapturedThinkingBlock {
  summary?: string;
}

export interface IndexEntryData {
  thinkingBlocks: ThinkingBlockRecord[];
}

export interface SummaryThinkingRef {
  shortId: string;
  thinkingId: string;
}

export interface SummaryMessageDetails {
  thinkingRefs: SummaryThinkingRef[];
  thinkingIds: string[];
  turnIndex: number;
  timestamp: number;
  rawCharCount: number;
}

export interface SummarizerStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  callCount: number;
}

export interface SummarizeResult {
  summaryText: string;
  usage?: any;
}

export interface SummarizeBatchOptions {
  signal?: AbortSignal;
  onTextProgress?: (receivedChars: number) => void;
}

export interface SummarizeBatchesOptions {
  signal?: AbortSignal;
  onBatchTextProgress?: (index: number, total: number, batch: CapturedThinkingBatch, receivedChars: number) => void;
}

export interface FlushOptions {
  signal?: AbortSignal;
  previewedBatches?: CapturedThinkingBatch[];
}
