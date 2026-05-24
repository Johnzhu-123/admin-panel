export type AnalyzeOutputMode = "structured-json" | "markdown-summary";
export type OpenAiCompatibleTokenLimitParam =
  | "max_tokens"
  | "max_completion_tokens";

export const ANALYZE_DEFAULT_MAX_OUTPUT_TOKENS = 8192;
export const ANALYZE_MAX_OUTPUT_TOKENS_CAP = 16000;

export function resolveAnalyzeOutputMode(raw: unknown): AnalyzeOutputMode {
  return raw === "markdown-summary" ? "markdown-summary" : "structured-json";
}

export function resolveAnalyzeMaxOutputTokens(
  raw: unknown,
  fallback = ANALYZE_DEFAULT_MAX_OUTPUT_TOKENS
): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(
    ANALYZE_MAX_OUTPUT_TOKENS_CAP,
    Math.max(512, Math.floor(value))
  );
}

export function isReasoningLikeModelId(model: string): boolean {
  const id = String(model || "").toLowerCase();
  if (!id) return false;
  if (/gpt-?5/i.test(id)) return true;
  if (/(?:^|[^a-z0-9])o[134](?:-mini|-preview|-pro)?(?:[^a-z0-9]|$)/i.test(id)) {
    return true;
  }
  if (/reasoning|thinking|think/i.test(id)) return true;
  if (/deepseek-?r1|qwq|qwen-?[\d.]+-?r1|glm-zero|kimi-?k1/i.test(id)) {
    return true;
  }
  if (/gemini-?3(?:\.|$|[^0-9])/i.test(id)) return true;
  return false;
}

export function getOpenAiCompatibleTokenLimitParamOrder(
  model: string
): OpenAiCompatibleTokenLimitParam[] {
  return isReasoningLikeModelId(model)
    ? ["max_completion_tokens", "max_tokens"]
    : ["max_tokens"];
}

const STRUCTURED_ANALYZE_SYSTEM_INSTRUCTION =
  "你是一位多模态内容分析专家。请根据用户提供的素材生成结构化的 JSON 分析报告。严格返回一个 JSON 对象，不要输出 Markdown 围栏、解释文字或思考过程。";

const MARKDOWN_ANALYZE_SYSTEM_INSTRUCTION =
  "你是一位文本内容分析专家。请根据用户提供的 MinerU / 素材解析文本生成可直接使用的中文 Markdown 总结文档。直接输出 Markdown 正文，不要 JSON、不要代码围栏、不要解释你的处理过程。";

export function getAnalyzeSystemInstruction(
  outputMode: AnalyzeOutputMode | string
): string {
  return outputMode === "markdown-summary"
    ? MARKDOWN_ANALYZE_SYSTEM_INSTRUCTION
    : STRUCTURED_ANALYZE_SYSTEM_INSTRUCTION;
}
