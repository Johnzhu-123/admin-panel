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
  for (const chunk of chunks) {
    const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
    for (const choice of choices) {
      appendTextPiece(contentParts, choice?.message?.content);
      appendTextPiece(contentParts, choice?.delta?.content);
      appendTextPiece(contentParts, choice?.text);
    }
    appendTextPiece(contentParts, chunk?.output_text);
    appendTextPiece(contentParts, chunk?.response?.output_text);
    appendTextPiece(contentParts, chunk?.content);
    appendTextPiece(contentParts, chunk?.text);
  }

  if (!contentParts.length) {
    return chunks[chunks.length - 1] || {};
  }

  const stringParts = contentParts.filter((part) => typeof part === "string");
  const objectParts = contentParts.filter((part) => typeof part !== "string");
  const mergedContent =
    objectParts.length === 0
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
        },
        delta: {
          ...(lastChoice?.delta || {}),
          content: mergedContent,
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
