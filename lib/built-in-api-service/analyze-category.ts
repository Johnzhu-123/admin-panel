export const BUILT_IN_ANALYZE_CATEGORIES = [
  "multimodal",
  "text",
  "image",
  "vision",
  "tts",
  "video",
] as const;

export type BuiltInAnalyzeCategory = (typeof BUILT_IN_ANALYZE_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(BUILT_IN_ANALYZE_CATEGORIES);

export function resolveBuiltInAnalyzeCategory(input: {
  builtInCategory?: unknown;
  forceTextOnly?: boolean;
  analysisMode?: unknown;
  hasImages?: boolean;
}): BuiltInAnalyzeCategory {
  const explicit = String(input.builtInCategory || "").trim();
  if (CATEGORY_SET.has(explicit)) {
    return explicit as BuiltInAnalyzeCategory;
  }

  const mode = String(input.analysisMode || "").trim();
  if (input.forceTextOnly === true || mode === "material-text") {
    return "text";
  }

  return input.hasImages === true ? "multimodal" : "text";
}
