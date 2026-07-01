import { createHash } from "node:crypto";

export function sha256Short(value: unknown, chars = 16): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(text).digest("hex").slice(0, chars);
}

export function getThinkingText(block: any): string {
  if (!block || typeof block !== "object") return "";
  if (typeof block.thinking === "string") return block.thinking;
  if (typeof block.text === "string" && typeof block.type === "string" && block.type.includes("thinking")) return block.text;
  if (typeof block.data === "string" && typeof block.type === "string" && block.type.includes("thinking")) return block.data;
  return "";
}

export function getThinkingSignature(block: any): string | undefined {
  if (!block || typeof block !== "object") return undefined;
  for (const key of ["thinkingSignature", "signature", "data"]) {
    const value = block[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function isThinkingBlock(block: any): boolean {
  if (!block || typeof block !== "object") return false;
  if (block.type === "thinking" || block.type === "redacted_thinking") return getThinkingText(block).length > 0;
  return typeof block.type === "string" && block.type.includes("thinking") && getThinkingText(block).length > 0;
}

export function makePruneKey(message: any, block: any): string {
  return sha256Short({
    role: message?.role,
    provider: message?.provider,
    model: message?.model,
    api: message?.api,
    timestamp: message?.timestamp,
    type: block?.type,
    thinking: getThinkingText(block),
    signature: getThinkingSignature(block),
    redacted: Boolean(block?.redacted || block?.type === "redacted_thinking"),
  }, 32);
}
