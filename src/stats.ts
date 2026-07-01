import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SummarizerStats } from "./types.js";
import { CUSTOM_TYPE_STATS } from "./types.js";

export class StatsAccumulator {
  private stats: SummarizerStats = { totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0, callCount: 0 };

  add(usage: any): void {
    if (!usage) return;
    this.stats.totalInputTokens += Number(usage.input ?? 0);
    this.stats.totalOutputTokens += Number(usage.output ?? 0);
    this.stats.totalCost += Number(usage.cost?.total ?? 0);
    this.stats.callCount += 1;
  }

  getStats(): SummarizerStats {
    return { ...this.stats };
  }

  persist(pi: ExtensionAPI): void {
    pi.appendEntry(CUSTOM_TYPE_STATS, this.getStats());
  }

  reset(): void {
    this.stats = { totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0, callCount: 0 };
  }

  reconstructFromSession(ctx: ExtensionContext): void {
    this.stats = { totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0, callCount: 0 };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || (entry as any).customType !== CUSTOM_TYPE_STATS) continue;
      const data = (entry as any).data;
      if (!data || typeof data !== "object") continue;
      this.stats = {
        totalInputTokens: Number(data.totalInputTokens ?? 0),
        totalOutputTokens: Number(data.totalOutputTokens ?? 0),
        totalCost: Number(data.totalCost ?? 0),
        callCount: Number(data.callCount ?? 0),
      };
    }
  }
}

export function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatTokens(n: number): string {
  return formatCompactCount(n);
}

export function formatCharProgress(receivedChars: number, rawChars?: number): string {
  const receivedLabel = `${formatCompactCount(receivedChars)} summary char${receivedChars === 1 ? "" : "s"}`;
  if (rawChars == null) return receivedLabel;
  return `${receivedLabel} / ${formatCompactCount(rawChars)} raw char${rawChars === 1 ? "" : "s"}`;
}

export function formatCost(n: number): string {
  if (n < 0.001 && n > 0) return "<$0.001";
  return `$${n.toFixed(3)}`;
}
