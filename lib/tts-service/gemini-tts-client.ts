import type { TTSRequest, TTSResponse, TTSServiceStatus } from "./types";
import { pcmBase64ToWavBase64 } from "./text-chunker";

// 🔧 FIX (2026-06-11 BUG-B3): Gemini TTS 的 inlineData.data 是无容器 16-bit 裸 PCM，
// mimeType 形如 `audio/L16;codec=pcm;rate=24000`。直接标 format:"wav" 返回会得到
// 一段没有 RIFF 头的"假 WAV"，下游无法播放/拼接。这里解析采样率（缺省 24000，
// 声道按 1、位深按 16），补 44 字节标准 WAV 头后再返回。
const GEMINI_PCM_DEFAULT_SAMPLE_RATE = 24000;

/** 从 Gemini inlineData.mimeType 中解析 PCM 参数（rate= 缺省 24000，mono/16bit）。 */
export function parseGeminiPcmFormat(mimeType?: string): {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
} {
  const rateMatch = /rate=(\d+)/i.exec(mimeType || "");
  const parsedRate = rateMatch ? Number.parseInt(rateMatch[1], 10) : NaN;
  return {
    sampleRate:
      Number.isFinite(parsedRate) && parsedRate > 0
        ? parsedRate
        : GEMINI_PCM_DEFAULT_SAMPLE_RATE,
    numChannels: 1,
    bitsPerSample: 16,
  };
}

/** 把 Gemini 返回的裸 PCM base64 封装为标准 WAV base64（此时 format:"wav" 才名副其实）。 */
export function wrapGeminiInlineAudioAsWav(
  audioBase64: string,
  mimeType?: string
): TTSResponse {
  // 防御：若上游已经返回带容器的 WAV（罕见），不再二次封装。
  if (/^audio\/(wav|x-wav|wave)\b/i.test(mimeType || "")) {
    return { audioBase64, format: "wav" };
  }
  return {
    audioBase64: pcmBase64ToWavBase64(audioBase64, parseGeminiPcmFormat(mimeType)),
    format: "wav",
  };
}

export const GEMINI_TTS_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Vale",
  "Solaris",
] as const;

export type GeminiTTSVoice = (typeof GEMINI_TTS_VOICES)[number];

export class GeminiTTSClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(apiKey: string, baseUrl?: string, model?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
    this.model = model?.trim() || "gemini-2.5-flash-preview-tts";
  }

  async checkStatus(): Promise<TTSServiceStatus> {
    if (!this.apiKey) {
      return { running: false, message: "未配置 Gemini API Key" };
    }
    return {
      running: true,
      modelLoaded: true,
      message: `Gemini TTS 可用 (${this.model})`,
      provider: "gemini",
    };
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    if (!this.apiKey) {
      throw new Error("未配置 Gemini API Key");
    }

    const voiceName =
      request.geminiVoiceName || request.voice || "Charon";

    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: request.text }],
          },
        ],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini TTS 失败: ${res.status} ${detail}`);
    }

    const result = await res.json();

    const inlineData = result?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    const audioData = inlineData?.data;
    if (!audioData) {
      throw new Error("Gemini TTS 未返回音频数据");
    }

    // 🔧 FIX (2026-06-11 BUG-B3): 裸 PCM → 标准 WAV（解析 inlineData.mimeType 的 rate）
    return wrapGeminiInlineAudioAsWav(
      audioData,
      typeof inlineData?.mimeType === "string" ? inlineData.mimeType : undefined
    );
  }
}
