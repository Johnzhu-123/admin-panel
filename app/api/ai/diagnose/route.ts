import { NextResponse } from "next/server";
import {
  buildOpenAiHeaders,
  normalizeOpenAiAuthHeader,
  defaultOpenAiAuthHeader,
  defaultOpenAiImageEndpointPath,
  defaultOpenAiImageModel,
  defaultOpenAiImageResponseFormat,
  normalizeOpenAiBaseUrl,
  noStoreHeaders,
  resolveOpenAiEndpoint,
} from "@/lib/ai";
import { recordFailureLog } from "@/lib/diagnostics";
import { queuedFetch } from "@/lib/request-queue-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type ImageResponseFormat = "auto" | "b64_json" | "base64" | "url";
type CheckResult = {
  ok: boolean;
  status: number;
  error: string;
  raw: string;
  level?: "ok" | "warn" | "fail";
  allowImport?: boolean;
  note?: string;
  code?: string;
};

const DEFAULT_DIAGNOSTIC_PROMPT = "A simple red circle on a white background.";
const DEFAULT_MULTIMODAL_PROMPT = "Reply with the word OK.";
const DEFAULT_TEXT_PROMPT = "Hello, please respond with 'Text API working' to confirm the connection.";

const truncate = (value: string, limit = 4000) => {
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated]`;
};

const parseSseJson = (rawText: string) => {
  if (!rawText.includes("data:")) return null;
  const lines = rawText.split(/\r?\n/);
  const chunks: any[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      chunks.push(JSON.parse(payload));
    } catch {
      // Ignore malformed SSE chunks.
    }
  }
  if (!chunks.length) return null;

  const textParts: string[] = [];
  const contentParts: any[] = [];
  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const pieces = [choice?.message?.content, choice?.delta?.content];
    for (const piece of pieces) {
      if (piece === undefined || piece === null) continue;
      if (typeof piece === "string") {
        textParts.push(piece);
      } else {
        contentParts.push(piece);
      }
    }
  }

  if (textParts.length) {
    contentParts.unshift(textParts.join(""));
  }
  if (!contentParts.length) {
    return chunks[chunks.length - 1];
  }
  const mergedContent = contentParts.length === 1 ? contentParts[0] : contentParts;
  return {
    choices: [{ message: { content: mergedContent }, delta: { content: mergedContent } }],
  };
};

const normalizeImageResponseFormat = (value: any): ImageResponseFormat => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "b64_json" || raw === "base64" || raw === "url") return raw;
  return "auto";
};

const parseErrorMessage = (raw: string) => {
  if (!raw) return "";
  try {
    const data = JSON.parse(raw);
    const msg =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      data?.detail ||
      "";
    return typeof msg === "string" ? msg : "";
  } catch {
    return "";
  }
};

const extractErrorInfo = (raw: string) => {
  if (!raw) return { message: "", code: "" };
  try {
    const data = JSON.parse(raw);
    const message =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      data?.detail ||
      "";
    const code =
      data?.error?.code ||
      data?.error?.inner_error?.code ||
      data?.code ||
      data?.error?.type ||
      "";
    return {
      message: typeof message === "string" ? message : "",
      code: typeof code === "string" ? code : "",
    };
  } catch {
    return { message: "", code: "" };
  }
};

const isPromptBlocked = (message: string, code: string) => {
  const combined = `${message} ${code}`.toLowerCase();
  if (!combined) return false;
  return (
    combined.includes("content_policy_violation") ||
    combined.includes("responsibleaipolicyviolation") ||
    combined.includes("invalid prompt") ||
    combined.includes("invalid_prompt") ||
    combined.includes("safety system") ||
    combined.includes("content policy")
  );
};

const classifyImageFailure = (status: number, message: string, code: string, hasPayload: boolean = false) => {
  // 如果状态码是200但没有图片数据，这是格式不兼容问题
  if (status === 200 && !hasPayload) {
    return {
      level: "fail" as const,
      allowImport: false,
      note: "接口返回200但无图片数据，可能是格式不兼容或接口实现问题。",
    };
  }
  
  if (status === 429) {
    return {
      level: "warn" as const,
      allowImport: true,
      note: "接口限流，建议稍后重试或更换 Key。",
    };
  }
  
  if (status === 400 && isPromptBlocked(message, code)) {
    return {
      level: "warn" as const,
      allowImport: true,
      note: "提示词被拦截，可更换诊断提示词后重试。",
    };
  }
  
  // 其他错误状态码
  if (status >= 400 && status < 500) {
    return {
      level: "fail" as const,
      allowImport: false,
      note: "客户端错误，请检查API配置和参数。",
    };
  }
  
  if (status >= 500) {
    return {
      level: "warn" as const,
      allowImport: true,
      note: "服务器错误，建议稍后重试。",
    };
  }
  
  return { level: "fail" as const, allowImport: false, note: "" };
};

const hasImagePayload = (data: any) => {
  const candidates = [
    data?.data?.[0]?.b64_json,
    data?.data?.[0]?.b64,
    data?.data?.[0]?.base64,
    data?.data?.[0]?.image_base64,
    data?.data?.[0]?.image,
    data?.data?.base64,
    data?.base64,
    data?.output?.base64,
    data?.image,
  ];
  if (candidates.some((val) => typeof val === "string" && val.trim())) {
    return true;
  }
  const url = data?.data?.[0]?.url || data?.url || "";
  return typeof url === "string" && url.startsWith("http");
};

const extractChatContents = (data: any) => {
  const contents: string[] = [];
  const raw = data?.choices?.[0]?.message?.content;
  const addContent = (value: any) => {
    if (!value) return;
    if (typeof value === "string") {
      contents.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => addContent(item?.text || item?.content || item));
    }
  };
  addContent(raw);
  return contents.filter((value) => typeof value === "string" && value.trim());
};

const looksLikeBase64 = (value: string) =>
  /^[A-Za-z0-9+/=\s]+$/.test(value) && value.replace(/\s+/g, "").length > 200;

const hasChatImagePayload = (data: any) => {
  // 首先检查是否有标准的图片数据格式
  if (hasImagePayload(data)) return true;
  
  const contents = extractChatContents(data);
  for (const content of contents) {
    const trimmed = content.trim();
    
    // 检查是否是data URL格式的图片
    if (/^data:image\/[a-zA-Z+]+;base64,/.test(trimmed)) return true;
    
    // 检查是否是图片URL（直接URL）
    if (/https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?[^\s]*)?$/i.test(trimmed)) return true;
    
    // 🔧 修复：检查 Markdown 格式的图片 URL
    const markdownImageMatch = trimmed.match(/!\[.*?\]\((https?:\/\/[^\s)]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)]*)?)\)/i);
    if (markdownImageMatch) {
      console.log('Detected Markdown image URL:', markdownImageMatch[1]);
      return true;
    }
    
    // 🔧 修复：检查任何 HTTP/HTTPS 图片 URL（更宽松的匹配）
    const httpImageMatch = trimmed.match(/(https?:\/\/[^\s)]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)]*)?)/i);
    if (httpImageMatch) {
      console.log('Detected HTTP image URL:', httpImageMatch[1]);
      return true;
    }
    
    // 检查是否是JSON格式的图片响应
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 8000) {
      try {
        const parsed = JSON.parse(trimmed);
        if (hasImagePayload(parsed)) return true;
      } catch {
        // ignore parsing errors
      }
    }
    
    // 检查是否是纯base64图片数据（更严格的检查）
    if (looksLikeBase64(trimmed) && trimmed.length > 1000) {
      // 只有当base64数据足够长时才认为是图片
      return true;
    }
  }
  
  return false;
};

const hasChatTextPayload = (data: any) => {
  const contents = extractChatContents(data);
  return contents.some((value) => value.trim());
};

const buildImagePayloads = (
  model: string,
  responseFormat: ImageResponseFormat,
  prompt: string
) => {
  const base = { model, prompt, n: 1, size: "1024x1024" };
  if (responseFormat !== "auto") {
    return [{ ...base, response_format: responseFormat }];
  }
  return [
    { ...base, response_format: "b64_json" },
    { ...base, response_format: "base64" },
    { ...base, response_format: "url" },
    base,
  ];
};

const buildChatPayloads = (model: string, prompt: string) => {
  const messages = [
    {
      role: "system",
      content: "You are an image generator. Return ONLY a base64 PNG or data URL.",
    },
    { role: "user", content: prompt },
  ];
  return [
    { model, messages, response_format: { type: "json_object" } },
    { model, messages, response_format: "b64_json" },
    { model, messages },
  ];
};

const buildTextPayloads = (model: string, prompt: string) => {
  const messages = [
    { role: "system", content: "You are a helpful assistant. Respond clearly and concisely." },
    { role: "user", content: prompt }
  ];
  return [
    { model, messages, max_tokens: 50 },
    { model, messages, max_tokens: 100 },
    { model, messages },
  ];
};

const buildMultimodalPayloads = (model: string, prompt: string) => {
  const messages = [{ role: "user", content: prompt }];
  return [
    { model, messages, max_tokens: 32 },
    { model, messages },
  ];
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const apiKey = (body.apiKey || "").trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing apiKey." },
        { status: 400, headers: noStoreHeaders() }
      );
    }

    const baseUrl = normalizeOpenAiBaseUrl(body.openAiBaseUrl);
    const openAiAuthHeader = normalizeOpenAiAuthHeader(body.openAiAuthHeader);
    const imageModel =
      (body.openAiImageModel || "").trim() || defaultOpenAiImageModel;
    const imageEndpointPath =
      (body.openAiImageEndpointPath || defaultOpenAiImageEndpointPath).trim() ||
      defaultOpenAiImageEndpointPath;
    const responseFormat = normalizeImageResponseFormat(
      body.openAiImageResponseFormat || defaultOpenAiImageResponseFormat
    );
    const imagePrompt =
      typeof body.openAiImagePrompt === "string" && body.openAiImagePrompt.trim()
        ? body.openAiImagePrompt.trim()
        : DEFAULT_DIAGNOSTIC_PROMPT;

    const modelsUrl = `${baseUrl}/models`;
    let modelsResult: CheckResult = {
      ok: false,
      status: 0,
      error: "",
      raw: "",
    };

    try {
      const res = await queuedFetch(modelsUrl, {
        method: "GET",
        headers: buildOpenAiHeaders(apiKey, false, openAiAuthHeader),
      }, 'normal');
      const raw = await res.text().catch(() => "");
      const error = res.ok ? "" : parseErrorMessage(raw) || res.statusText || raw;
      modelsResult = {
        ok: res.ok,
        status: res.status,
        error,
        raw: truncate(raw),
      };
      if (!res.ok) {
        recordFailureLog({
          provider: "openai",
          operation: "models",
          url: modelsUrl,
          status: res.status,
          responseBody: raw,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      modelsResult = { ok: false, status: 0, error: message, raw: "" };
      recordFailureLog({
        provider: "openai",
        operation: "models",
        url: modelsUrl,
        status: null,
        responseBody: message,
      });
    }

    const imageEndpoint = resolveOpenAiEndpoint(baseUrl, imageEndpointPath);
    let imageResult: CheckResult = {
      ok: false,
      status: 0,
      error: "",
      raw: "",
    };
    let multimodalResult: CheckResult = {
      ok: false,
      status: 0,
      error: "",
      raw: "",
    };

    const payloads = buildImagePayloads(imageModel, responseFormat, imagePrompt);
    let warnResult: CheckResult | null = null;
    for (const payload of payloads) {
      try {
        const res = await queuedFetch(imageEndpoint, {
          method: "POST",
          headers: buildOpenAiHeaders(apiKey, true, openAiAuthHeader),
          body: JSON.stringify(payload),
        }, 'high'); // 图片检测使用高优先级
        const raw = await res.text().catch(() => "");
        let data: any = {};
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch {
            data = parseSseJson(raw) || {};
          }
        }
        if (res.ok && hasImagePayload(data)) {
          imageResult = {
            ok: true,
            status: res.status,
            error: "",
            raw: truncate(raw),
            level: "ok",
            allowImport: true,
            note: "",
          };
          break;
        }
        
        // 如果状态码是200但没有图片数据，这是失败的
        const errorInfo = extractErrorInfo(raw);
        let error = errorInfo.message;
        const hasPayload = hasImagePayload(data);
        
        if (res.ok && !hasPayload) {
          // 200状态码但没有图片数据，这是格式不兼容或其他问题
          error = "Image payload missing.";
        } else if (!res.ok) {
          // 非200状态码，使用响应中的错误信息
          error = error || res.statusText || "Request failed";
        }
        
        const classification = classifyImageFailure(
          res.status,
          error,
          errorInfo.code,
          hasPayload
        );
        
        imageResult = {
          ok: false, // 明确设置为false，因为没有成功获取图片
          status: res.status,
          error,
          raw: truncate(raw),
          level: classification.level,
          allowImport: classification.allowImport,
          note: classification.note,
          code: errorInfo.code,
        };
        if (classification.level === "warn" && !warnResult) {
          warnResult = imageResult;
        }
        recordFailureLog({
          provider: "openai",
          operation: "images/generations",
          url: imageEndpoint,
          status: res.status,
          requestBody: payload,
          responseBody: raw || data,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "");
        imageResult = { ok: false, status: 0, error: message, raw: "" };
        recordFailureLog({
          provider: "openai",
          operation: "images/generations",
          url: imageEndpoint,
          status: null,
          requestBody: payload,
          responseBody: message,
        });
      }
    }

    if (!imageResult.ok) {
      const chatPayloads = buildChatPayloads(imageModel, imagePrompt);
      const chatUrl = `${baseUrl}/chat/completions`;
      for (const payload of chatPayloads) {
        try {
          const res = await queuedFetch(chatUrl, {
            method: "POST",
            headers: buildOpenAiHeaders(apiKey, true, openAiAuthHeader),
            body: JSON.stringify(payload),
          }, 'high'); // 聊天检测使用高优先级
          const raw = await res.text().catch(() => "");
          let data: any = {};
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch {
              data = parseSseJson(raw) || {};
            }
          }
          if (res.ok && hasChatImagePayload(data)) {
            imageResult = {
              ok: true,
              status: res.status,
              error: "",
              raw: truncate(raw),
              level: "warn",
              allowImport: true,
              note: "图片接口未通过，但聊天接口可用。",
            };
            break;
          }
          
          // 聊天接口也没有返回图片数据
          const error = res.ok 
            ? "Chat interface available but no image generation capability detected."
            : (parseErrorMessage(raw) || res.statusText || "Request failed");
            
          recordFailureLog({
            provider: "openai",
            operation: "chat/completions",
            url: chatUrl,
            status: res.status,
            requestBody: payload,
            responseBody: raw || data,
          });
          
          if (!imageResult.ok) {
            imageResult = {
              ok: false,
              status: res.status,
              error,
              raw: truncate(raw),
              level: "fail",
              allowImport: false,
              note: "",
            };
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || "");
          recordFailureLog({
            provider: "openai",
            operation: "chat/completions",
            url: chatUrl,
            status: null,
            requestBody: payload,
            responseBody: message,
          });
        }
      }
    }

    if (!imageResult.ok && warnResult) {
      imageResult = warnResult;
    }

    try {
      const chatUrl = `${baseUrl}/chat/completions`;
      const payloads = buildMultimodalPayloads(
        imageModel,
        DEFAULT_MULTIMODAL_PROMPT
      );
      for (const payload of payloads) {
        const res = await queuedFetch(chatUrl, {
          method: "POST",
          headers: buildOpenAiHeaders(apiKey, true, openAiAuthHeader),
          body: JSON.stringify(payload),
        }, 'normal'); // 多模态检测使用普通优先级
        const raw = await res.text().catch(() => "");
        let data: any = {};
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch {
            data = parseSseJson(raw) || {};
          }
        }
        if (res.ok && hasChatTextPayload(data)) {
          // 检查是否真的是多模态响应，而不仅仅是文本聊天
          const contents = extractChatContents(data);
          const hasValidResponse = contents.some(content => 
            content.toLowerCase().includes('ok') || 
            content.toLowerCase().includes('yes') ||
            content.length > 0
          );
          
          if (hasValidResponse) {
            multimodalResult = {
              ok: true,
              status: res.status,
              error: "",
              raw: truncate(raw),
              level: "ok",
              allowImport: true,
            };
            break;
          }
        }
        
        const error = res.ok 
          ? "Chat response received but content validation failed."
          : (parseErrorMessage(raw) || res.statusText || "Request failed");
          
        multimodalResult = {
          ok: false,
          status: res.status,
          error,
          raw: truncate(raw),
          level: "fail",
          allowImport: false,
        };
        recordFailureLog({
          provider: "openai",
          operation: "chat/completions",
          url: chatUrl,
          status: res.status,
          requestBody: payload,
          responseBody: raw || data,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      multimodalResult = { ok: false, status: 0, error: message, raw: "" };
      recordFailureLog({
        provider: "openai",
        operation: "chat/completions",
        url: `${baseUrl}/chat/completions`,
        status: null,
        responseBody: message,
      });
    }

    // 文本检测
    let textResult: CheckResult = {
      ok: false,
      status: 0,
      error: "",
      raw: "",
    };

    try {
      const chatUrl = `${baseUrl}/chat/completions`;
      const textPayloads = buildTextPayloads(imageModel, DEFAULT_TEXT_PROMPT);
      
      for (const payload of textPayloads) {
        const res = await queuedFetch(chatUrl, {
          method: "POST",
          headers: buildOpenAiHeaders(apiKey, true, openAiAuthHeader),
          body: JSON.stringify(payload),
        }, 'normal'); // 文本检测使用普通优先级
        const raw = await res.text().catch(() => "");
        let data: any = {};
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch {
            data = parseSseJson(raw) || {};
          }
        }
        
        if (res.ok && hasChatTextPayload(data)) {
          // 检查文本响应的质量
          const contents = extractChatContents(data);
          const hasValidTextResponse = contents.some(content => {
            const text = content.toLowerCase().trim();
            return text.length > 0 && (
              text.includes('text api working') ||
              text.includes('working') ||
              text.includes('hello') ||
              text.length >= 5 // 至少有一些有意义的文本
            );
          });
          
          if (hasValidTextResponse) {
            textResult = {
              ok: true,
              status: res.status,
              error: "",
              raw: truncate(raw),
              level: "ok",
              allowImport: true,
            };
            break;
          }
        }
        
        const error = res.ok 
          ? "Text response received but content validation failed."
          : (parseErrorMessage(raw) || res.statusText || "Request failed");
          
        textResult = {
          ok: false,
          status: res.status,
          error,
          raw: truncate(raw),
          level: "fail",
          allowImport: false,
        };
        
        recordFailureLog({
          provider: "openai",
          operation: "chat/completions",
          url: chatUrl,
          status: res.status,
          requestBody: payload,
          responseBody: raw || data,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      textResult = { ok: false, status: 0, error: message, raw: "" };
      recordFailureLog({
        provider: "openai",
        operation: "chat/completions",
        url: `${baseUrl}/chat/completions`,
        status: null,
        responseBody: message,
      });
    }

    // 当图像模型不可用时，自动检测多模态模型
    let suggestedMultimodalModels: string[] = [];
    if (!imageResult.ok) {
      try {
        const modelsRes = await queuedFetch(`${baseUrl}/models`, {
          method: "GET",
          headers: buildOpenAiHeaders(apiKey, false, openAiAuthHeader),
        }, 'low'); // 模型列表检测使用低优先级
        
        if (modelsRes.ok) {
          const modelsData = await modelsRes.json().catch(() => ({}));
          const models = Array.isArray(modelsData?.data) ? modelsData.data : [];
          
          // 检测多模态模型
          const multimodalCandidates = models
            .map((model: any) => model?.id || model?.name || "")
            .filter((id: string) => {
              if (!id || typeof id !== "string") return false;
              const lowerName = id.toLowerCase();
              
              // 检查是否是已知的多模态模型
              return (
                lowerName.includes('gpt-4o') ||
                lowerName.includes('gpt-4-vision') ||
                lowerName.includes('claude') ||
                lowerName.includes('gemini') ||
                lowerName.includes('vision') ||
                lowerName.includes('multimodal') ||
                lowerName.includes('omni') ||
                lowerName.includes('llava') ||
                (lowerName.includes('gpt-4') && !lowerName.includes('turbo')) ||
                lowerName.includes('qwen-vl') ||
                lowerName.includes('yi-vision')
              );
            })
            .slice(0, 10); // 限制数量
          
          // 测试这些候选模型是否真的支持多模态
          for (const candidateModel of multimodalCandidates) {
            try {
              const testPayload = {
                model: candidateModel,
                messages: [{ role: "user", content: "Reply with OK" }],
                max_tokens: 10
              };
              
              const testRes = await queuedFetch(`${baseUrl}/chat/completions`, {
                method: "POST",
                headers: buildOpenAiHeaders(apiKey, true, openAiAuthHeader),
                body: JSON.stringify(testPayload),
              }, 'low'); // 模型测试使用低优先级
              
              if (testRes.ok) {
                const testData = await testRes.json().catch(() => ({}));
                if (hasChatTextPayload(testData)) {
                  suggestedMultimodalModels.push(candidateModel);
                }
              }
            } catch {
              // 忽略单个模型测试失败
            }
            
            // 限制测试数量以避免超时
            if (suggestedMultimodalModels.length >= 5) break;
          }
        }
      } catch {
        // 忽略模型检测失败
      }
    }

    return NextResponse.json(
      { 
        models: modelsResult, 
        image: imageResult, 
        multimodal: multimodalResult,
        text: textResult,
        suggestedMultimodalModels
      },
      { headers: noStoreHeaders() }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to run diagnostics.";
    return NextResponse.json(
      { error: message },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}
