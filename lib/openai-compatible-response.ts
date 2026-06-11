const tryParseJsonPayload = (value: string): any => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const parseJsonObjectsFromText = (rawText: string) => {
  const parsed: any[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < rawText.length; index += 1) {
    const char = rawText[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      if (depth === 0) startIndex = index;
      depth += 1;
      continue;
    }

    if ((char === "}" || char === "]") && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        const candidate = rawText.slice(startIndex, index + 1).trim();
        const value = tryParseJsonPayload(candidate);
        if (Array.isArray(value)) {
          parsed.push(...value.filter((entry) => entry && typeof entry === "object"));
        } else if (value && typeof value === "object") {
          parsed.push(value);
        }
        startIndex = -1;
      }
    }
  }

  return parsed;
};

export const parseOpenAiCompatibleEventStream = (rawText: string) => {
  if (!/(^|\r?\n)\s*data:/m.test(rawText || "")) return [];

  const chunks: any[] = [];
  let currentDataLines: string[] = [];

  const flush = () => {
    if (!currentDataLines.length) return;
    const payload = currentDataLines.join("\n").trim();
    currentDataLines = [];
    if (!payload || payload === "[DONE]") return;

    const directValue = tryParseJsonPayload(payload);
    if (Array.isArray(directValue)) {
      chunks.push(...directValue.filter((entry) => entry && typeof entry === "object"));
      return;
    }
    if (directValue && typeof directValue === "object") {
      chunks.push(directValue);
      return;
    }

    const recovered = parseJsonObjectsFromText(payload);
    if (recovered.length) {
      chunks.push(...recovered);
    }
  };

  const lines = (rawText || "").replace(/\u0000/g, "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      continue;
    }

    if (trimmed.startsWith(":")) {
      flush();
      continue;
    }

    if (trimmed.startsWith("data:")) {
      if (currentDataLines.length) {
        const currentPayload = currentDataLines.join("\n").trim();
        if (currentPayload === "[DONE]" || tryParseJsonPayload(currentPayload) !== undefined) {
          flush();
        }
      }
      currentDataLines.push(trimmed.slice(5).trimStart());
      continue;
    }

    if (currentDataLines.length) {
      currentDataLines.push(trimmed);
    }
  }

  flush();
  return chunks;
};

const appendTextPiece = (target: any[], value: unknown) => {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => appendTextPiece(target, entry));
    return;
  }
  target.push(value);
};

const mergeOpenAiCompatibleChunks = (chunks: any[]) => {
  if (!chunks.length) return {};

  const contentParts: any[] = [];
  // 🔧 FIX (2026-06-11 BUG-CS1): 聚合流式 tool_calls——按 index 拼接 function.arguments
  const toolCallsByIndex = new Map<number, any>();

  const mergeToolCallFragment = (fragment: any, fallbackIndex: number, replace: boolean) => {
    if (!fragment || typeof fragment !== "object") return;
    const index = typeof fragment.index === "number" ? fragment.index : fallbackIndex;
    const args =
      typeof fragment?.function?.arguments === "string"
        ? fragment.function.arguments
        : "";
    const existing = toolCallsByIndex.get(index);
    if (!existing || replace) {
      toolCallsByIndex.set(index, {
        ...(fragment.id ? { id: fragment.id } : existing?.id ? { id: existing.id } : {}),
        type: fragment.type || existing?.type || "function",
        function: {
          ...(existing?.function || {}),
          ...(fragment.function || {}),
          arguments: replace ? args : `${existing?.function?.arguments || ""}${args}`,
        },
      });
      return;
    }
    if (fragment.id) existing.id = fragment.id;
    if (fragment.type) existing.type = fragment.type;
    if (typeof fragment?.function?.name === "string" && fragment.function.name) {
      existing.function.name = fragment.function.name;
    }
    if (args) {
      existing.function.arguments = `${existing.function.arguments || ""}${args}`;
    }
  };

  for (const chunk of chunks) {
    const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
    for (const choice of choices) {
      // 🔧 FIX (2026-06-11 BUG-CS1): 同一 choice 内 delta.content 与 message.content
      // 并存时只取 delta（部分网关在每个 chunk 同时回填两处，旧实现两份都拼，
      // 文本被整体重复一遍）。choice.text 仅作为两者皆缺时的兜底。
      const deltaContent = choice?.delta?.content;
      const messageContent = choice?.message?.content;
      if (deltaContent !== null && deltaContent !== undefined) {
        appendTextPiece(contentParts, deltaContent);
      } else if (messageContent !== null && messageContent !== undefined) {
        appendTextPiece(contentParts, messageContent);
      } else {
        appendTextPiece(contentParts, choice?.text);
      }

      const deltaToolCalls = choice?.delta?.tool_calls;
      if (Array.isArray(deltaToolCalls)) {
        deltaToolCalls.forEach((fragment: any, fragmentIndex: number) =>
          mergeToolCallFragment(fragment, fragmentIndex, false)
        );
      }
      // message.tool_calls 为完整形态：整体覆盖对应 index 的聚合结果
      const messageToolCalls = choice?.message?.tool_calls;
      if (Array.isArray(messageToolCalls)) {
        messageToolCalls.forEach((fragment: any, fragmentIndex: number) =>
          mergeToolCallFragment(fragment, fragmentIndex, true)
        );
      }
    }
    appendTextPiece(contentParts, chunk?.output_text);
    appendTextPiece(contentParts, chunk?.response?.output_text);
    appendTextPiece(contentParts, chunk?.content);
    appendTextPiece(contentParts, chunk?.text);
  }

  const mergedToolCalls = toolCallsByIndex.size
    ? Array.from(toolCallsByIndex.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => call)
    : null;

  if (!contentParts.length && !mergedToolCalls) {
    return chunks[chunks.length - 1] || {};
  }

  const stringParts = contentParts.filter((part) => typeof part === "string");
  const objectParts = contentParts.filter((part) => typeof part !== "string");
  const mergedContent = !contentParts.length
    ? null // tool_calls-only 流：content 置 null（OpenAI 语义）
    : objectParts.length === 0
      ? stringParts.join("")
      : stringParts.length
        ? [stringParts.join(""), ...objectParts]
        : objectParts.length === 1
          ? objectParts[0]
          : objectParts;
  const lastChunk = chunks[chunks.length - 1] || {};
  const lastChoice = Array.isArray(lastChunk?.choices)
    ? lastChunk.choices[lastChunk.choices.length - 1] || {}
    : {};

  return {
    ...lastChunk,
    object:
      typeof lastChunk?.object === "string"
        ? lastChunk.object.replace(/\.chunk$/, "")
        : lastChunk?.object,
    choices: [
      {
        ...lastChoice,
        message: {
          ...(lastChoice?.message || {}),
          content: mergedContent,
          ...(mergedToolCalls ? { tool_calls: mergedToolCalls } : {}),
        },
        delta: {
          ...(lastChoice?.delta || {}),
          content: mergedContent,
          ...(mergedToolCalls ? { tool_calls: mergedToolCalls } : {}),
        },
      },
    ],
    output_text: typeof mergedContent === "string" ? mergedContent : undefined,
  };
};

export const parseOpenAiCompatibleResponseText = (rawText: string): any => {
  const trimmed = (rawText || "").trim();
  if (!trimmed) return {};

  const directValue = tryParseJsonPayload(trimmed);
  if (directValue !== undefined) return directValue;

  const streamObjects = parseOpenAiCompatibleEventStream(trimmed);
  if (streamObjects.length) {
    return mergeOpenAiCompatibleChunks(streamObjects);
  }

  const recoveredObjects = parseJsonObjectsFromText(trimmed);
  if (recoveredObjects.length === 1) return recoveredObjects[0];
  if (recoveredObjects.length > 1) return mergeOpenAiCompatibleChunks(recoveredObjects);

  return { rawText: trimmed };
};

const flattenTextParts = (value: unknown, depth = 0): string[] => {
  if (depth > 6) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenTextParts(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return flattenTextParts(record.text, depth + 1);
    }
    if (typeof record.content === "string") {
      return flattenTextParts(record.content, depth + 1);
    }
    if (typeof record.output_text === "string") {
      return flattenTextParts(record.output_text, depth + 1);
    }
    if (typeof record.value === "string") {
      return flattenTextParts(record.value, depth + 1);
    }
  }
  return [];
};

export const extractOpenAiCompatibleText = (payload: any) => {
  const message = payload?.choices?.[0]?.message;
  const toolCallArgs = Array.isArray(message?.tool_calls)
    ? message.tool_calls
        .map((call: any) => call?.function?.arguments)
        .filter((value: unknown) => typeof value === "string" && value.trim())
    : [];
  const alternatives = [
    message?.content,
    message?.reasoning_content,
    message?.reasoning,
    payload?.choices?.[0]?.delta?.content,
    payload?.choices?.[0]?.delta?.reasoning_content,
    payload?.choices?.[0]?.text,
    payload?.output_text,
    payload?.response?.output_text,
    payload?.response?.output,
    payload?.content,
    payload?.text,
    toolCallArgs,
  ];
  for (const value of alternatives) {
    const text = flattenTextParts(value).join("\n");
    if (text) return text;
  }
  return "";
};

/**
 * P0 (2026-05-24)：扩展版 extract，同时返回 finish_reason / usage 元信息，
 * 让调用方能识别"看似成功但实质有问题"的响应（特别是 length 截断）。
 */
export interface OpenAiCompatibleExtractionResult {
  text: string;
  finishReason?: string;
  truncated?: boolean;
  refusal?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export const extractOpenAiCompatibleResult = (
  payload: any
): OpenAiCompatibleExtractionResult => {
  const text = extractOpenAiCompatibleText(payload);
  const choice = payload?.choices?.[0];
  const finishReason =
    typeof choice?.finish_reason === "string"
      ? choice.finish_reason.toLowerCase()
      : undefined;
  const refusal =
    typeof choice?.message?.refusal === "string" && choice.message.refusal.trim()
      ? choice.message.refusal.trim()
      : undefined;
  const usage = payload?.usage;
  return {
    text,
    finishReason,
    truncated: finishReason === "length",
    refusal,
    usage:
      usage && typeof usage === "object"
        ? {
            prompt_tokens: Number(usage.prompt_tokens) || undefined,
            completion_tokens: Number(usage.completion_tokens) || undefined,
            total_tokens: Number(usage.total_tokens) || undefined,
          }
        : undefined,
  };
};

export const extractOpenAiCompatibleError = (payload: any) => {
  if (!payload || typeof payload !== "object") return "";
  const candidates = [
    payload?.error?.message,
    payload?.error,
    payload?.message,
    payload?.detail,
    payload?.response?.error?.message,
    payload?.response?.error,
    payload?.response?.message,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

export const summarizeOpenAiCompatiblePayload = (payload: any) => {
  try {
    const text = JSON.stringify(payload);
    if (!text) return "";
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "";
  }
};

export const describeOpenAiCompatibleEmptyReason = (payload: any) => {
  const explicitError = extractOpenAiCompatibleError(payload);
  if (explicitError) return explicitError;

  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const finishReason =
    typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
  const refusal =
    typeof message?.refusal === "string" && message.refusal.trim()
      ? message.refusal.trim()
      : "";
  if (refusal) return `模型拒答：${refusal}`;
  if (finishReason === "content_filter") return "响应被安全策略过滤";
  if (finishReason === "length") return "响应被 max_tokens 截断";
  if (finishReason === "tool_calls") return "响应仅返回工具调用，无文本";
  if (payload === 0 || payload === false || payload === null) {
    return `上游返回了空的原始值：${JSON.stringify(payload)}`;
  }
  if (payload !== undefined && typeof payload !== "object") {
    return `上游返回了非文本原始值：${JSON.stringify(payload)}`;
  }
  if (!payload || typeof payload !== "object" || !Object.keys(payload).length) {
    return "响应体为空";
  }
  return "";
};
