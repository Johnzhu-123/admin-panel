import {
  defaultOpenAiTextModel,
  defaultOpenAiVisionModel,
} from "@/lib/ai";

const IMAGE_ONLY_PATTERNS = [
  /gpt-image/i,
  /dall-e/i,
  /stable[-_ ]?diffusion/i,
  /\bsdxl\b/i,
  /\bsd3\b/i,
  /\bflux\b/i,
  /(^|[/:._-])flow([/:._-]|$)/i,
  /pixart/i,
  /kandinsky/i,
  /midjourney/i,
  /ideogram/i,
  /\bimagen\b/i,
  /cogview/i,
  /kolors/i,
  /seedream/i,
  /nano[-_ ]?banana/i,
  /doubao/i,
  /recraft/i,
  /hidream/i,
  /jimeng/i,
  /kontext/i,
  /seededit/i,
  /firefly/i,
];

export function isLikelyOpenAiImageOnlyModel(model?: string): boolean {
  const normalized = (model || "").trim();
  if (!normalized) return false;
  return IMAGE_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function pickSafeOpenAiTextModel(
  requestedModel?: string,
  fallback = defaultOpenAiTextModel
): string {
  const normalized = (requestedModel || "").trim();
  if (!normalized) return fallback;
  if (isLikelyOpenAiImageOnlyModel(normalized)) return fallback;
  return normalized;
}

export function pickSafeOpenAiVisionModel(
  requestedModel?: string,
  fallback = defaultOpenAiVisionModel
): string {
  const normalized = (requestedModel || "").trim();
  if (!normalized) return fallback;
  if (isLikelyOpenAiImageOnlyModel(normalized)) return fallback;
  return normalized;
}
