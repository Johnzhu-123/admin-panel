import { createHash } from "crypto";
import type { TTSRequest, TTSResponse, TTSServiceStatus } from "./types";

type EndpointType = "custom" | "openai" | "openai_variant" | "gradio5" | "gradio3";

interface EndpointCandidate {
  type: EndpointType;
  path: string;
  label: string;
}

interface Gradio5FileData {
  path: string;
  url?: string;
  size?: number;
  orig_name?: string;
  mime_type?: string;
  is_stream?: boolean;
  meta: {
    _type: "gradio.FileData";
  };
}

interface Gradio5ParameterDescriptor {
  parameterName: string;
  label: string;
  defaultValue?: unknown;
}

interface CachedValue<T> {
  value: T;
  cachedAt: number;
}

const ENDPOINT_CANDIDATES: EndpointCandidate[] = [
  { type: "custom", path: "/api/v1/tts/synthesize", label: "Custom REST" },
  { type: "openai", path: "/v1/audio/speech", label: "OpenAI Compatible" },
  {
    type: "openai_variant",
    path: "/audio/speech",
    label: "OpenAI Variant",
  },
  { type: "gradio5", path: "/gradio_api/call/gen_single", label: "Gradio 5.x" },
  { type: "gradio3", path: "/api/predict", label: "Gradio 3.x" },
];

const EMOTION_METHOD_MAP: Record<string, string> = {
  same_as_ref: "与音色参考音频相同",
  custom_audio: "使用情感参考音频",
  emotion_text: "使用情感描述文本控制",
  emotion_vector: "使用情感向量控制",
};

const INDEX_TTS_TIMEOUTS = {
  reachability: 15000,
  detectInfo: 8000,
  detectEndpoint: 6000,
  upload: 120000,
  call: 300000,
  sse: 900000,
  audioFetch: 120000,
} as const;

const INDEX_TTS_CACHE_TTLS = {
  reachability: 15000,
  endpoint: 30 * 60 * 1000,
  upload: 30 * 60 * 1000,
} as const;

export class IndexTTSClient {
  private static reachabilityCache = new Map<string, CachedValue<true>>();
  private static endpointCache = new Map<
    string,
    CachedValue<{
      endpoint: EndpointCandidate;
      gradio5Parameters: Gradio5ParameterDescriptor[] | null;
    }>
  >();
  private static gradio5UploadCache = new Map<string, CachedValue<Gradio5FileData>>();
  private static gradio3UploadCache = new Map<string, CachedValue<string>>();
  private baseUrl: string;
  private detectedEndpoint: EndpointCandidate | null = null;
  private gradio5GenSingleParameters: Gradio5ParameterDescriptor[] | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private getCacheKey(suffix: string) {
    return `${this.baseUrl}|${suffix}`;
  }

  private getUploadCacheKey(base64: string, filename: string) {
    const digest = createHash("sha1").update(base64).digest("hex");
    return this.getCacheKey(`upload|${filename}|${digest}`);
  }

  private getFreshCacheValue<T>(
    cache: Map<string, CachedValue<T>>,
    key: string,
    ttlMs: number
  ): T | null {
    const cached = cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.cachedAt > ttlMs) {
      cache.delete(key);
      return null;
    }
    return cached.value;
  }

  private setCacheValue<T>(
    cache: Map<string, CachedValue<T>>,
    key: string,
    value: T
  ) {
    cache.set(key, { value, cachedAt: Date.now() });
  }

  private async ensureReachable() {
    const cached = this.getFreshCacheValue(
      IndexTTSClient.reachabilityCache,
      this.baseUrl,
      INDEX_TTS_CACHE_TTLS.reachability
    );
    if (cached) return;

    await this.fetchWithTimeout(
      `${this.baseUrl}/`,
      {},
      INDEX_TTS_TIMEOUTS.reachability,
      "连接 IndexTTS2 服务"
    );
    this.setCacheValue(IndexTTSClient.reachabilityCache, this.baseUrl, true);
  }

  private shouldRetryWithFreshUploads(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /404|not found|no such file|missing file|文件不存在|找不到文件/i.test(message);
  }

  private clearCachedUploadsForRequest(request: TTSRequest) {
    if (request.referenceAudioBase64) {
      const gradio5Key = this.getUploadCacheKey(
        request.referenceAudioBase64,
        "ref_audio.wav"
      );
      IndexTTSClient.gradio5UploadCache.delete(gradio5Key);
      IndexTTSClient.gradio3UploadCache.delete(gradio5Key);
    }

    if (request.emotionRefAudioBase64) {
      const gradio5Key = this.getUploadCacheKey(
        request.emotionRefAudioBase64,
        "emotion_ref.wav"
      );
      IndexTTSClient.gradio5UploadCache.delete(gradio5Key);
      IndexTTSClient.gradio3UploadCache.delete(gradio5Key);
    }
  }

  async checkStatus(): Promise<TTSServiceStatus> {
    try {
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/`,
        {},
        INDEX_TTS_TIMEOUTS.reachability,
        "检测 IndexTTS2 服务"
      );
      if (!res.ok) {
        return { running: false, message: `HTTP ${res.status}` };
      }
      const body = await res.text().catch(() => "");
      const modelLoaded = !body.includes("model not loaded") && !body.includes("模型未加载");
      return {
        running: true,
        modelLoaded,
        message: modelLoaded ? "IndexTTS2 运行中" : "IndexTTS2 已连接但模型未加载",
        provider: "indextts2",
      };
    } catch {
      return { running: false, message: "无法连接到 IndexTTS2 服务" };
    }
  }

  async detectEndpoint(): Promise<EndpointCandidate | null> {
    if (this.detectedEndpoint) return this.detectedEndpoint;

    const cached = this.getFreshCacheValue(
      IndexTTSClient.endpointCache,
      this.baseUrl,
      INDEX_TTS_CACHE_TTLS.endpoint
    );
    if (cached) {
      this.detectedEndpoint = cached.endpoint;
      this.gradio5GenSingleParameters = cached.gradio5Parameters;
      return this.detectedEndpoint;
    }

    // 1. Try Gradio 5.x info endpoint first (most common for IndexTTS2)
    try {
      const infoRes = await this.fetchWithTimeout(
        `${this.baseUrl}/gradio_api/info?serialize=False`,
        {},
        INDEX_TTS_TIMEOUTS.detectInfo,
        "探测 IndexTTS2 Gradio 信息"
      );
      if (infoRes.ok) {
        const info = await infoRes.json().catch(() => null);
        const endpoints = info?.named_endpoints || {};
        if ("/gen_single" in endpoints) {
          this.gradio5GenSingleParameters = this.extractGradio5ParameterDescriptors(
            endpoints?.["/gen_single"]?.parameters
          );
          this.detectedEndpoint = ENDPOINT_CANDIDATES[3]; // gradio5
          this.setCacheValue(IndexTTSClient.endpointCache, this.baseUrl, {
            endpoint: this.detectedEndpoint,
            gradio5Parameters: this.gradio5GenSingleParameters,
          });
          return this.detectedEndpoint;
        }
      }
    } catch {
      // not Gradio 5.x
    }

    // 2. Try other candidates via OPTIONS/HEAD
    for (const candidate of ENDPOINT_CANDIDATES) {
      if (candidate.type === "gradio5") continue; // already checked above
      try {
        const url = `${this.baseUrl}${candidate.path}`;
        const res = await this.fetchWithTimeout(
          url,
          { method: "OPTIONS" },
          INDEX_TTS_TIMEOUTS.detectEndpoint,
          `探测 ${candidate.label} 端点`
        ).catch(() =>
          this.fetchWithTimeout(
            url,
            { method: "HEAD" },
            INDEX_TTS_TIMEOUTS.detectEndpoint,
            `探测 ${candidate.label} 端点`
          )
        );
        if (res.status !== 404) {
          this.detectedEndpoint = candidate;
          this.setCacheValue(IndexTTSClient.endpointCache, this.baseUrl, {
            endpoint: this.detectedEndpoint,
            gradio5Parameters: this.gradio5GenSingleParameters,
          });
          return candidate;
        }
      } catch {
        continue;
      }
    }

    // 3. Fallback: try Gradio 3.x info endpoint
    try {
      const infoRes = await this.fetchWithTimeout(
        `${this.baseUrl}/info`,
        {},
        INDEX_TTS_TIMEOUTS.detectInfo,
        "探测 IndexTTS2 Gradio3 信息"
      );
      if (infoRes.ok) {
        this.detectedEndpoint = ENDPOINT_CANDIDATES[4]; // gradio3
        this.setCacheValue(IndexTTSClient.endpointCache, this.baseUrl, {
          endpoint: this.detectedEndpoint,
          gradio5Parameters: this.gradio5GenSingleParameters,
        });
        return this.detectedEndpoint;
      }
    } catch {
      // ignore
    }

    return null;
  }

  private extractGradio5ParameterDescriptors(
    rawParameters: unknown
  ): Gradio5ParameterDescriptor[] {
    if (!Array.isArray(rawParameters)) return [];
    return rawParameters
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const parameterName =
          typeof record.parameter_name === "string" && record.parameter_name.trim()
            ? record.parameter_name.trim()
            : "";
        const label =
          typeof record.label === "string" && record.label.trim()
            ? record.label.trim()
            : parameterName;
        if (!parameterName && !label) return null;
        return {
          parameterName,
          label,
          defaultValue: record.parameter_default,
        };
      })
      .filter((item) => !!item) as Gradio5ParameterDescriptor[];
  }

  private async getGradio5GenSingleParameters(): Promise<Gradio5ParameterDescriptor[]> {
    if (this.gradio5GenSingleParameters?.length) {
      return this.gradio5GenSingleParameters;
    }
    await this.detectEndpoint();
    return this.gradio5GenSingleParameters || [];
  }

  private getGradio5ParameterValue(
    parameter: Gradio5ParameterDescriptor,
    request: TTSRequest,
    emotionMethod: string,
    refAudioData: Gradio5FileData | null,
    emotionRefData: Gradio5FileData | null,
    emotionVecs: number[]
  ): unknown {
    const key = parameter.parameterName.trim().toLowerCase();
    const label = parameter.label.trim().toLowerCase();
    const fallback = parameter.defaultValue ?? null;

    if (key === "emo_control_method" || label === "情感控制方式") return emotionMethod;
    if (key === "prompt" || label === "音色参考音频") return refAudioData;
    if (key === "text" || label === "文本") return request.text;
    if (key === "emo_ref_path" || label === "上传情感参考音频") return emotionRefData;
    if (key === "emo_weight" || label === "情感权重") return request.emotionWeight ?? 1.0;
    if (key === "emo_text" || label === "情感描述文本") return request.emotionText || "";
    if (key === "emo_random" || label === "情感随机采样") return request.emotionRandom ?? false;
    if (key === "speaking_speed" || label === "语速") return request.speed ?? 1.0;
    if (key === "max_text_tokens_per_segment" || label === "分句最大token数") {
      return request.maxTextTokensPerSegment ?? 120;
    }
    if (key === "do_sample" || label === "do_sample" || key === "param_16") {
      return request.doSample ?? true;
    }
    if (key === "top_p" || label === "top_p" || key === "param_17") {
      return request.topP ?? 0.7;
    }
    if (key === "top_k" || label === "top_k" || key === "param_18") {
      return request.topK ?? 20;
    }
    if (key === "temperature" || label === "temperature" || key === "param_19") {
      return request.temperature ?? 0.3;
    }
    if (key === "length_penalty" || label === "length_penalty" || key === "param_20") {
      return request.lengthPenalty ?? 1.0;
    }
    if (key === "num_beams" || label === "num_beams" || key === "param_21") {
      return request.numBeams ?? 3;
    }
    if (
      key === "repetition_penalty" ||
      label === "repetition_penalty" ||
      key === "param_22"
    ) {
      return request.repetitionPenalty ?? 10.0;
    }
    if (key === "max_mel_tokens" || label === "max_mel_tokens" || key === "param_23") {
      return request.maxMelTokens ?? 600;
    }

    const emotionVectorMap: Record<string, number> = {
      vec1: emotionVecs[0] ?? 0,
      vec2: emotionVecs[1] ?? 0,
      vec3: emotionVecs[2] ?? 0,
      vec4: emotionVecs[3] ?? 0,
      vec5: emotionVecs[4] ?? 0,
      vec6: emotionVecs[5] ?? 0,
      vec7: emotionVecs[6] ?? 0,
      vec8: emotionVecs[7] ?? 0,
    };
    if (key in emotionVectorMap) {
      return emotionVectorMap[key];
    }

    return fallback;
  }

  private async buildGradio5CallData(
    request: TTSRequest,
    emotionMethod: string,
    refAudioData: Gradio5FileData | null,
    emotionRefData: Gradio5FileData | null,
    emotionVecs: number[]
  ): Promise<unknown[]> {
    const parameters = await this.getGradio5GenSingleParameters();
    if (!parameters.length) {
      return [
        emotionMethod,
        refAudioData,
        request.text,
        emotionRefData,
        request.emotionWeight ?? 1.0,
        ...emotionVecs,
        request.emotionText || "",
        request.emotionRandom ?? false,
        request.speed ?? 1.0,
        request.maxTextTokensPerSegment ?? 120,
        request.doSample ?? true,
        request.topP ?? 0.7,
        request.topK ?? 20,
        request.temperature ?? 0.3,
        request.lengthPenalty ?? 1.0,
        request.numBeams ?? 3,
        request.repetitionPenalty ?? 10.0,
        request.maxMelTokens ?? 600,
      ];
    }

    return parameters.map((parameter) =>
      this.getGradio5ParameterValue(
        parameter,
        request,
        emotionMethod,
        refAudioData,
        emotionRefData,
        emotionVecs
      )
    );
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    try {
      await this.ensureReachable();
    } catch {
      throw new Error(
        `无法连接到 IndexTTS2 服务 (${this.baseUrl})，请确认服务已启动。`
      );
    }

    const endpoint = await this.detectEndpoint();
    if (!endpoint) {
      throw new Error("无法检测到 IndexTTS2 API 端点，请确认服务正在运行。");
    }

    switch (endpoint.type) {
      case "custom":
        return this.synthesizeCustom(request);
      case "openai":
      case "openai_variant":
        return this.synthesizeOpenAI(request, endpoint.path);
      case "gradio5":
        return this.synthesizeGradio5(request);
      case "gradio3":
        return this.synthesizeGradio3(request);
      default:
        throw new Error(`不支持的端点类型: ${endpoint.type}`);
    }
  }

  private async synthesizeCustom(request: TTSRequest): Promise<TTSResponse> {
    const url = `${this.baseUrl}/api/v1/tts/synthesize`;
    const res = await this.fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: request.text,
          voice: request.voice,
          speed: request.speed ?? 1.0,
          reference_audio: request.referenceAudioBase64,
        }),
      },
      INDEX_TTS_TIMEOUTS.call,
      "调用 IndexTTS2 自定义接口"
    );
    return this.parseAudioResponse(res);
  }

  private async synthesizeOpenAI(
    request: TTSRequest,
    path: string
  ): Promise<TTSResponse> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "indextts2",
          input: request.text,
          voice: request.voice || "default",
          speed: request.speed ?? 1.0,
          response_format: "wav",
        }),
      },
      INDEX_TTS_TIMEOUTS.call,
      "调用 IndexTTS2 OpenAI 兼容接口"
    );
    return this.parseAudioResponse(res);
  }

  /** Gradio 5.x: POST /gradio_api/call/gen_single -> SSE result */
  private async synthesizeGradio5(request: TTSRequest): Promise<TTSResponse> {
    try {
      return await this.synthesizeGradio5Once(request);
    } catch (error) {
      if (this.shouldRetryWithFreshUploads(error)) {
        this.clearCachedUploadsForRequest(request);
        return this.synthesizeGradio5Once(request);
      }
      throw error;
    }
  }

  private async synthesizeGradio5Once(request: TTSRequest): Promise<TTSResponse> {
    const emotionMethod =
      EMOTION_METHOD_MAP[request.emotionControlMethod || "same_as_ref"] ||
      "与音色参考音频相同";
    const emotionVecs = request.emotionVectors || [0, 0, 0, 0, 0, 0, 0, 0];

    // Upload reference audio if provided
    let refAudioData: Gradio5FileData | null = null;
    if (request.referenceAudioBase64) {
      refAudioData = await this.uploadGradio5File(
        request.referenceAudioBase64,
        "ref_audio.wav"
      );
    }

    // Upload emotion reference audio if custom
    let emotionRefData: Gradio5FileData | null = null;
    if (request.emotionControlMethod === "custom_audio" && request.emotionRefAudioBase64) {
      emotionRefData = await this.uploadGradio5File(
        request.emotionRefAudioBase64,
        "emotion_ref.wav"
      );
    }

    // Step 1: Submit the call
    const callUrl = `${this.baseUrl}/gradio_api/call/gen_single`;
    const callData = await this.buildGradio5CallData(
      request,
      emotionMethod,
      refAudioData,
      emotionRefData,
      emotionVecs
    );
    const callRes = await this.fetchWithTimeout(
      callUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: callData,
        }),
      },
      INDEX_TTS_TIMEOUTS.call,
      "提交 IndexTTS2 合成任务"
    );

    if (!callRes.ok) {
      const detail = await callRes.text().catch(() => "Unknown error");
      throw new Error(`IndexTTS2 调用失败: ${callRes.status} ${detail}`);
    }

    const { event_id } = await callRes.json();
    if (!event_id) {
      throw new Error("IndexTTS2 未返回 event_id");
    }

    // Step 2: Read SSE stream for result
    const resultUrl = `${this.baseUrl}/gradio_api/call/gen_single/${event_id}`;
    const sseRes = await this.fetchWithTimeout(
      resultUrl,
      {},
      INDEX_TTS_TIMEOUTS.sse,
      "等待 IndexTTS2 合成结果"
    );
    if (!sseRes.ok) {
      throw new Error(`IndexTTS2 SSE 连接失败: ${sseRes.status}`);
    }

    const audioData = await this.readGradio5SSEStream(sseRes);
    if (!audioData) {
      throw new Error("IndexTTS2 合成失败，未获取到音频数据");
    }

    // Step 3: Fetch the audio file
    const audioUrl = audioData.url
      ? (audioData.url.startsWith("http") ? audioData.url : `${this.baseUrl}${audioData.url}`)
      : `${this.baseUrl}/gradio_api/file=${audioData.path}`;
    const audioRes = await this.fetchWithTimeout(
      audioUrl,
      {},
      INDEX_TTS_TIMEOUTS.audioFetch,
      "下载 IndexTTS2 音频文件"
    );
    return this.parseAudioResponse(audioRes);
  }

  private async readGradio5SSEStream(res: Response): Promise<{ path: string; url?: string } | null> {
    const reader = res.body?.getReader();
    if (!reader) {
      const sseText = await res.text();
      return this.parseGradio5SSE(sseText);
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (error) {
        if (this.isTimeoutError(error)) {
          throw new Error(
            "等待 IndexTTS2 合成结果超时。服务持续发送 heartbeat 但未返回 complete，通常是未上传参考音频，或当前参数过重。请先上传参考音频，并尝试降低 maxMelTokens / numBeams。"
          );
        }
        throw error;
      }

      const { value, done } = readResult;
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      const parsed = this.extractGradio5SSEPayload(buffer);
      buffer = parsed.remaining;

      if (parsed.error) {
        try {
          await reader.cancel();
        } catch {
          // Ignore reader cancellation errors.
        }
        throw new Error(`IndexTTS2 合成错误: ${parsed.error}`);
      }

      if (parsed.result) {
        try {
          await reader.cancel();
        } catch {
          // Ignore reader cancellation errors.
        }
        return parsed.result;
      }

      if (done) break;
    }

    return this.parseGradio5SSE(buffer);
  }

  private extractGradio5SSEPayload(input: string): {
    remaining: string;
    result: { path: string; url?: string } | null;
    error: string | null;
  } {
    let remaining = input;

    while (true) {
      const separatorMatch = remaining.match(/\r?\n\r?\n/);
      if (!separatorMatch || separatorMatch.index === undefined) {
        break;
      }

      const rawEvent = remaining.slice(0, separatorMatch.index);
      remaining = remaining.slice(separatorMatch.index + separatorMatch[0].length);

      const lines = rawEvent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) continue;

      const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "";
      const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      const dataPayload = dataLines.join("\n");

      if (eventName === "error") {
        const message = this.formatGradioErrorPayload(dataPayload);
        return {
          remaining,
          result: null,
          error: message,
        };
      }

      if (eventName === "complete") {
        return {
          remaining,
          result: this.parseGradio5OutputPayload(dataPayload),
          error: null,
        };
      }
    }

    return { remaining, result: null, error: null };
  }

  private formatGradioErrorPayload(dataPayload: string): string {
    if (!dataPayload || dataPayload === "null" || dataPayload === "None") {
      return "IndexTTS2 返回了空错误事件。常见原因是 maxMelTokens 过小导致生成被截断，或本地 IndexTTS 推理异常。请尝试提高 maxMelTokens 至 1500 后重试，并查看本地 IndexTTS2 日志。";
    }

    try {
      const parsed = JSON.parse(dataPayload);
      const candidates = [
        parsed?.error,
        parsed?.message,
        parsed?.msg,
        parsed?.detail,
        parsed?.details,
        parsed?.title,
        parsed?.value,
      ];

      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
          return candidate.trim();
        }
      }

      if (Array.isArray(parsed)) {
        const flattened = parsed
          .map((item) =>
            typeof item === "string"
              ? item
              : typeof item?.message === "string"
                ? item.message
                : typeof item?.error === "string"
                  ? item.error
                  : ""
          )
          .filter(Boolean)
          .join(" | ");
        if (flattened) return flattened;
      }

      return JSON.stringify(parsed);
    } catch {
      return dataPayload;
    }
  }

  private parseGradio5OutputPayload(dataPayload: string): { path: string; url?: string } | null {
    if (!dataPayload) return null;
    try {
      const parsed = JSON.parse(dataPayload);
      const output = parsed?.[0] ?? parsed?.data?.[0];
      const fileData = output?.value ?? output;
      if (typeof output === "string") return { path: output };
      if (typeof fileData === "string") return { path: fileData };
      if (fileData?.path) return fileData;
      if (fileData?.url) return { path: "", url: fileData.url };
    } catch {
      // Ignore malformed payloads and let caller continue/fallback.
    }
    return null;
  }

  private parseGradio5SSE(sseText: string): { path: string; url?: string } | null {
    const parsed = this.extractGradio5SSEPayload(sseText);
    if (parsed.error) {
      throw new Error(`IndexTTS2 合成错误: ${parsed.error}`);
    }
    return parsed.result;
  }

  /** Gradio 3.x fallback */
  private async synthesizeGradio3(request: TTSRequest): Promise<TTSResponse> {
    try {
      return await this.synthesizeGradio3Once(request);
    } catch (error) {
      if (this.shouldRetryWithFreshUploads(error)) {
        this.clearCachedUploadsForRequest(request);
        return this.synthesizeGradio3Once(request);
      }
      throw error;
    }
  }

  private async synthesizeGradio3Once(request: TTSRequest): Promise<TTSResponse> {
    const emotionMethod =
      EMOTION_METHOD_MAP[request.emotionControlMethod || "same_as_ref"] ||
      "与音色参考音频相同";
    const emotionVecs = request.emotionVectors || [0, 0, 0, 0, 0, 0, 0, 0];

    let refAudioPath: string | null = null;
    if (request.referenceAudioBase64) {
      refAudioPath = await this.uploadGradio3File(request.referenceAudioBase64, "ref_audio.wav");
    }

    let emotionRefPath: string | null = null;
    if (request.emotionControlMethod === "custom_audio" && request.emotionRefAudioBase64) {
      emotionRefPath = await this.uploadGradio3File(request.emotionRefAudioBase64, "emotion_ref.wav");
    }

    const url = `${this.baseUrl}/api/predict`;
    const res = await this.fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fn_index: 0,
          data: [
            emotionMethod,
            refAudioPath,
            request.text,
            emotionRefPath,
            request.emotionWeight ?? 1.0,
            ...emotionVecs,
            request.emotionText || "",
            request.emotionRandom ?? false,
            request.speed ?? 1.0,
            request.maxTextTokensPerSegment ?? 120,
            request.doSample ?? true,
            request.topP ?? 0.7,
            request.topK ?? 20,
            request.temperature ?? 0.3,
            request.lengthPenalty ?? 1.0,
            request.numBeams ?? 3,
            request.repetitionPenalty ?? 10.0,
            request.maxMelTokens ?? 600,
          ],
          session_hash: crypto.randomUUID?.() || Math.random().toString(36),
        }),
      },
      INDEX_TTS_TIMEOUTS.call,
      "调用 IndexTTS2 Gradio3 合成接口"
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "Unknown error");
      throw new Error(`IndexTTS2 synthesis failed: ${res.status} ${detail}`);
    }

    const result = await res.json();
    const audioPath = result?.data?.[0]?.name || result?.data?.[0] || null;
    if (!audioPath) {
      throw new Error("IndexTTS2 合成成功但未返回音频文件路径");
    }

    const audioUrl = audioPath.startsWith("http")
      ? audioPath
      : `${this.baseUrl}/file=${audioPath}`;
    const audioRes = await this.fetchWithTimeout(
      audioUrl,
      {},
      INDEX_TTS_TIMEOUTS.audioFetch,
      "下载 IndexTTS2 音频文件"
    );
    return this.parseAudioResponse(audioRes);
  }

  private base64ToBlob(base64: string, type = "audio/wav"): Blob {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type });
  }

  private buildGradio5FileData(path: string, filename: string): Gradio5FileData {
    return {
      path,
      orig_name: filename,
      mime_type: "audio/wav",
      is_stream: false,
      meta: {
        _type: "gradio.FileData",
      },
    };
  }

  /** Gradio 5.x upload: POST /gradio_api/upload */
  private async uploadGradio5File(base64: string, filename: string): Promise<Gradio5FileData> {
    const cacheKey = this.getUploadCacheKey(base64, filename);
    const cached = this.getFreshCacheValue(
      IndexTTSClient.gradio5UploadCache,
      cacheKey,
      INDEX_TTS_CACHE_TTLS.upload
    );
    if (cached) {
      return cached;
    }

    const blob = this.base64ToBlob(base64);
    const formData = new FormData();
    formData.append("files", blob, filename);

    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/gradio_api/upload`,
      {
        method: "POST",
        body: formData,
      },
      INDEX_TTS_TIMEOUTS.upload,
      "上传 IndexTTS2 参考音频"
    );
    if (!res.ok) throw new Error(`文件上传失败: ${res.status}`);
    const paths = await res.json();
    const uploadedPath = Array.isArray(paths) ? paths[0] : paths;
    if (!uploadedPath || typeof uploadedPath !== "string") {
      throw new Error("IndexTTS2 上传成功，但未返回可用的文件路径");
    }
    const fileData = this.buildGradio5FileData(uploadedPath, filename);
    this.setCacheValue(IndexTTSClient.gradio5UploadCache, cacheKey, fileData);
    return fileData;
  }

  /** Gradio 3.x upload: POST /upload */
  private async uploadGradio3File(base64: string, filename: string): Promise<string> {
    const cacheKey = this.getUploadCacheKey(base64, filename);
    const cached = this.getFreshCacheValue(
      IndexTTSClient.gradio3UploadCache,
      cacheKey,
      INDEX_TTS_CACHE_TTLS.upload
    );
    if (cached) {
      return cached;
    }

    const blob = this.base64ToBlob(base64);
    const formData = new FormData();
    formData.append("files", blob, filename);

    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/upload`,
      {
        method: "POST",
        body: formData,
      },
      INDEX_TTS_TIMEOUTS.upload,
      "上传 IndexTTS2 参考音频"
    );
    if (!res.ok) throw new Error(`文件上传失败: ${res.status}`);
    const paths = await res.json();
    const uploadedPath = Array.isArray(paths) ? paths[0] : paths;
    this.setCacheValue(IndexTTSClient.gradio3UploadCache, cacheKey, uploadedPath);
    return uploadedPath;
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
    timeoutMs: number,
    context: string
  ): Promise<Response> {
    try {
      return await fetch(input, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (this.isTimeoutError(error)) {
        throw new Error(`${context}超时（>${Math.ceil(timeoutMs / 1000)} 秒）`);
      }
      throw error;
    }
  }

  private isTimeoutError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || "");
    return /aborted due to timeout|timeout|AbortError/i.test(message);
  }

  private async parseAudioResponse(res: Response): Promise<TTSResponse> {
    if (!res.ok) {
      const detail = await res.text().catch(() => "Unknown error");
      throw new Error(`TTS 请求失败: ${res.status} ${detail}`);
    }

    const contentType = res.headers.get("content-type") || "";

    if (contentType.includes("json")) {
      const json = await res.json();
      if (json.audio_base64 || json.audioBase64 || json.audio) {
        return {
          audioBase64: json.audio_base64 || json.audioBase64 || json.audio,
          format: json.format || "wav",
        };
      }
      throw new Error("JSON 响应中未找到音频数据");
    }

    // Binary audio response
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return { audioBase64: base64, format: "wav" };
  }
}
