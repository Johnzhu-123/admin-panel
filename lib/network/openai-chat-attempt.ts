/**
 * 🔧 FIX (2026-06-11 S-2/BUG-D1): OpenAI 兼容 chat/completions 的 reasoning 模型防护执行器。
 *
 * 背景（审计 BUG-C1/D1）：plan/summary 路由长期硬编码 `temperature: 0.6`、不传输出上限、
 * 非流式、裸 fetch。gpt-5.x / o 系列 / gemini-3.x 等推理模型会因此：
 *   1) 400 Unsupported parameter: 'max_tokens'（必须用 max_completion_tokens）
 *   2) 400 Unsupported value: 'temperature'（仅支持默认温度）
 *   3) 推理超 100 秒 → Cloudflare 524（必须流式让网关持续看到字节）
 *
 * 本执行器统一三件套 + 双重兼容回退（token 参数互换 / temperature 降级 / 空流转非流式），
 * 供 plan、summary 两条路由共用。判定逻辑与 analyze-materials 同源
 * （lib/built-in-api-service/analyze-request.ts）。
 */

import { isReasoningLikeModelId } from "@/lib/built-in-api-service/analyze-request";
import {
  extractOpenAiCompatibleError,
  extractOpenAiCompatibleText,
  parseOpenAiCompatibleResponseText,
} from "@/lib/openai-compatible-response";
import { serverFetchWithRetry } from "@/lib/network/server-fetch-with-retry";

export type OpenAiChatMessage = { role: string; content: unknown };

export interface OpenAiChatAttemptInput {
  url: string;
  headers: Record<string, string>;
  model: string;
  messages: OpenAiChatMessage[];
  /** 缺省：reasoning 模型 16000，普通模型 8192 */
  maxOutputTokens?: number;
  /** 仅对非 reasoning 模型生效；缺省不发 temperature */
  temperature?: number;
  /** 缺省 90s —— Render/Cloudflare 网关 100s idle 上限内必须有响应或转为流式输出 */
  timeoutMs?: number;
  /**
   * 可选的请求体增强钩子（plan 路由的 enhanceOpenAICompatibility）。
   * 每次 attempt 都会重新执行，确保兼容层看到的是当次真实参数。
   */
  enhance?: (config: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }) => Promise<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }>;
  /** 每次 attempt 的观测回调（记日志用） */
  onAttempt?: (info: {
    operation: string;
    status: number | null;
    detailPreview: string;
  }) => void;
}

export interface OpenAiChatAttemptResult {
  res: Response;
  rawText: string;
  /** parseOpenAiCompatibleResponseText 的产物（JSON 与 SSE 文本均可解析） */
  data: any;
  /** choices[0].message.content 聚合文本（SSE delta 已合并） */
  text: string;
  url: string;
  operation: string;
  reasoningLike: boolean;
  maxOutputTokens: number;
}

type TokenParam = "max_tokens" | "max_completion_tokens";

const runSingleAttempt = async (
  input: OpenAiChatAttemptInput,
  attempt: {
    tokenParam: TokenParam;
    includeTemperature: boolean;
    stream: boolean;
    operation: string;
  },
  maxOutputTokens: number
) => {
  const body: Record<string, unknown> = {
    model: input.model,
    [attempt.tokenParam]: maxOutputTokens,
    stream: attempt.stream,
    ...(attempt.includeTemperature && input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    messages: input.messages,
  };
  let config = {
    url: input.url,
    method: "POST",
    headers: input.headers,
    body,
  };
  if (input.enhance) {
    config = await input.enhance(config);
  }
  const res = await serverFetchWithRetry(
    config.url,
    {
      method: config.method,
      headers: config.headers,
      body: JSON.stringify(config.body),
    },
    { retries: 1, retryDelayMs: 2000, timeoutMs: input.timeoutMs ?? 90_000 }
  );
  const rawText = await res.text().catch(() => "");
  input.onAttempt?.({
    operation: attempt.operation,
    status: res.status,
    detailPreview: res.ok ? "" : rawText.slice(0, 500),
  });
  return { res, rawText, url: config.url, operation: attempt.operation };
};

export async function executeOpenAiChatWithCompatRetries(
  input: OpenAiChatAttemptInput
): Promise<OpenAiChatAttemptResult> {
  const reasoningLike = isReasoningLikeModelId(input.model);
  const maxOutputTokens = (() => {
    const raw = Number(input.maxOutputTokens);
    if (Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), 16000);
    return reasoningLike ? 16000 : 8192;
  })();
  const primaryParam: TokenParam = reasoningLike
    ? "max_completion_tokens"
    : "max_tokens";

  let attempt = await runSingleAttempt(
    input,
    {
      tokenParam: primaryParam,
      includeTemperature: !reasoningLike,
      stream: reasoningLike,
      operation: "chat/completions",
    },
    maxOutputTokens
  );

  // 回退 1：400 且响应体点名 token 参数 / temperature → 换参数或去温度重试一次
  if (!attempt.res.ok && attempt.res.status === 400) {
    const lowered = attempt.rawText.toLowerCase();
    const altParam: TokenParam =
      primaryParam === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    const tokenParamRejected = lowered.includes(primaryParam);
    const temperatureRejected =
      !reasoningLike &&
      input.temperature !== undefined &&
      lowered.includes("temperature");
    if (tokenParamRejected || temperatureRejected) {
      attempt = await runSingleAttempt(
        input,
        {
          tokenParam: tokenParamRejected ? altParam : primaryParam,
          includeTemperature: false,
          stream: reasoningLike,
          operation: tokenParamRejected
            ? `chat/completions-token-param-retry-${altParam}`
            : "chat/completions-no-temperature-retry",
        },
        maxOutputTokens
      );
    }
  }

  // 回退 2：流式 + HTTP ok + 空文本（部分网关 SSE 兼容性差）→ 非流式重试一次
  if (attempt.res.ok && reasoningLike) {
    const probe = parseOpenAiCompatibleResponseText(attempt.rawText);
    const probeText = extractOpenAiCompatibleText(probe).trim();
    if (!probeText && !extractOpenAiCompatibleError(probe)) {
      attempt = await runSingleAttempt(
        input,
        {
          tokenParam: primaryParam,
          includeTemperature: false,
          stream: false,
          operation: "chat/completions-nostream-retry",
        },
        maxOutputTokens
      );
    }
  }

  const data = parseOpenAiCompatibleResponseText(attempt.rawText);
  const text = extractOpenAiCompatibleText(data).trim();
  return {
    res: attempt.res,
    rawText: attempt.rawText,
    data,
    text,
    url: attempt.url,
    operation: attempt.operation,
    reasoningLike,
    maxOutputTokens,
  };
}
