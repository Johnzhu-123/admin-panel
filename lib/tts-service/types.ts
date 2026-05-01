export type EmotionControlMethod =
  | "same_as_ref"
  | "custom_audio"
  | "emotion_text"
  | "emotion_vector";

export interface TTSRequest {
  text: string;
  model?: string;
  voice?: string;
  speed?: number;
  sampleRate?: number;
  referenceAudioBase64?: string;
  emotionControlMethod?: EmotionControlMethod;
  emotionRefAudioBase64?: string;
  emotionWeight?: number;
  emotionVectors?: number[];
  emotionText?: string;
  emotionRandom?: boolean;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTextTokensPerSegment?: number;
  doSample?: boolean;
  lengthPenalty?: number;
  numBeams?: number;
  repetitionPenalty?: number;
  maxMelTokens?: number;
  geminiVoiceName?: string;
}

export interface TTSResponse {
  audioBase64: string;
  format?: string;
  duration?: number;
  sampleRate?: number;
}

export interface TTSServiceStatus {
  running: boolean;
  message?: string;
  modelLoaded?: boolean;
  endpoint?: string;
  provider?: string;
}

export interface TTSServiceConfig {
  provider: "indextts2" | "gemini" | "custom";
  baseUrl: string;
  apiKey?: string;
  defaultVoice?: string;
  enabled: boolean;
}
