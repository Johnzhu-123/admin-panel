import type { TTSRequest, TTSResponse, TTSServiceStatus } from "./types";

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

    const audioData =
      result?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error("Gemini TTS 未返回音频数据");
    }

    return {
      audioBase64: audioData,
      format: "wav",
    };
  }
}
