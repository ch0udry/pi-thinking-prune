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
