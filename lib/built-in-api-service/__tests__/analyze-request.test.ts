import {
  getAnalyzeSystemInstruction,
  getOpenAiCompatibleTokenLimitParamOrder,
  resolveAnalyzeMaxOutputTokens,
} from "../analyze-request";

describe("analyze OpenAI-compatible request helpers", () => {
  it("uses max_completion_tokens first for reasoning model ids", () => {
    expect(getOpenAiCompatibleTokenLimitParamOrder("gpt-5.5")).toEqual([
      "max_completion_tokens",
      "max_tokens",
    ]);
    expect(getOpenAiCompatibleTokenLimitParamOrder("gemini-3.1-pro-preview")).toEqual([
      "max_completion_tokens",
      "max_tokens",
    ]);
  });

  it("keeps max_tokens for ordinary chat models", () => {
    expect(getOpenAiCompatibleTokenLimitParamOrder("gpt-4o-mini")).toEqual([
      "max_tokens",
    ]);
  });

  it("honors caller max token request within the analyze cap", () => {
    expect(resolveAnalyzeMaxOutputTokens(12000)).toBe(12000);
    expect(resolveAnalyzeMaxOutputTokens(999999)).toBe(16000);
    expect(resolveAnalyzeMaxOutputTokens("bad")).toBe(8192);
  });

  it("switches the system instruction for markdown summary output", () => {
    expect(getAnalyzeSystemInstruction("markdown-summary")).toContain("Markdown");
    expect(getAnalyzeSystemInstruction("markdown-summary")).not.toContain("严格返回一个 JSON 对象");
    expect(getAnalyzeSystemInstruction("structured-json")).toContain("严格返回一个 JSON 对象");
  });
});
