/**
 * @jest-environment node
 */

import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { POST } from "../route";
import { injectBuiltInCategoryConfig } from "@/lib/built-in-api-service/apply-cloud-config";
import { serverFetchWithRetry } from "@/lib/network/server-fetch-with-retry";

jest.mock("@/lib/built-in-api-service/apply-cloud-config", () => ({
  injectBuiltInCategoryConfig: jest.fn(async (body: Record<string, unknown>, category: string) => ({
    body: {
      ...body,
      apiKey: "sk-admin",
      openAiBaseUrl: "https://upstream.example/v1",
      baseUrl: "https://upstream.example/v1",
    },
    applied: true,
    config: {
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-admin",
      model: "catalog-default",
      subtaskId: "default",
      category,
    },
  })),
}));

jest.mock("@/lib/auth/service-principal", () => ({
  requireClaimedServicePrincipal: jest.fn(async () => ({
    userId: "user_verified",
    email: "verified@example.com",
    source: "clerk-bearer",
  })),
  ServicePrincipalError: class ServicePrincipalError extends Error {
    status = 401;
  },
}));

jest.mock("@/lib/api-compatibility/integration", () => ({
  enhanceOpenAICompatibility: jest.fn(async (config: any) => config),
}));

jest.mock("@/lib/diagnostics", () => ({
  recordFailureLog: jest.fn(),
}));

jest.mock("@/lib/network/server-fetch-with-retry", () => ({
  serverFetchWithRetry: jest.fn(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "# ok" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  ),
  serverRequestTextWithRetry: jest.fn(),
  serverReadErrorMessage: jest.fn(async (response: Response) => response.text()),
}));

const makeRequest = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/ai/analyze-materials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/ai/analyze-materials built-in routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("injects the text catalog for desktop material text analysis", async () => {
    const response = await POST(
      makeRequest({
        provider: "openai",
        useBuiltInService: true,
        builtInCategory: "text",
        forceTextOnly: true,
        analysisMode: "material-text",
        openAiTextModel: "gpt-4o-mini",
        prompt: "材料正文",
      })
    );

    expect(response.status).toBe(200);
    expect(injectBuiltInCategoryConfig).toHaveBeenCalledWith(
      expect.any(Object),
      "text"
    );
  });

  it("uses max_completion_tokens and markdown system instruction for reasoning markdown summaries", async () => {
    await POST(
      makeRequest({
        provider: "openai",
        useBuiltInService: true,
        builtInCategory: "text",
        forceTextOnly: true,
        analysisMode: "material-text",
        analysisOutputMode: "markdown-summary",
        openAiTextModel: "gpt-5.5",
        maxTokens: 12000,
        prompt: "长文档正文",
      })
    );

    const call = (serverFetchWithRetry as jest.Mock).mock.calls[0];
    const init = call[1] as RequestInit;
    const upstreamBody = JSON.parse(String(init.body));

    expect(upstreamBody.model).toBe("gpt-5.5");
    expect(upstreamBody.max_completion_tokens).toBe(12000);
    expect(upstreamBody.max_tokens).toBeUndefined();
    expect(upstreamBody.temperature).toBeUndefined();
    expect(upstreamBody.messages[0].content).toContain("Markdown");
  });

  it("inlines documentAttachments into OpenAI-compatible prompts for structured long-document analysis", async () => {
    const fullDocument = [
      "# 第4章 实证结果",
      "4.4.3 DID 基准回归，主规格系数 0.00631。",
      "4.5 稳健性检验与安慰剂检验。",
      "# 第5章 机制与异质性",
      "5.2 异质性分析。",
      "# 第6章 结论与建议",
    ].join("\n");

    await POST(
      makeRequest({
        provider: "openai",
        useBuiltInService: true,
        builtInCategory: "text",
        forceTextOnly: true,
        analysisMode: "material-text",
        analysisOutputMode: "structured-json",
        openAiTextModel: "mimo-v2.5-pro",
        maxTokens: 12000,
        prompt: "请基于附件生成结构化 JSON 报告。",
        documentAttachments: [
          {
            mimeType: "text/plain",
            data: Buffer.from(fullDocument, "utf8").toString("base64"),
            name: "素材论文.mineru.md",
          },
        ],
      })
    );

    const call = (serverFetchWithRetry as jest.Mock).mock.calls[0];
    const init = call[1] as RequestInit;
    const upstreamBody = JSON.parse(String(init.body));
    const userContent = upstreamBody.messages[1].content;

    expect(userContent).toContain("<attachment");
    expect(userContent).toContain("素材论文.mineru.md");
    expect(userContent).toContain("4.4.3 DID 基准回归");
    expect(userContent).toContain("0.00631");
    expect(userContent).toContain("第6章 结论与建议");
  });
});
