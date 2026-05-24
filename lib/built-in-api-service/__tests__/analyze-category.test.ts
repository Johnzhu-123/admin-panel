import { resolveBuiltInAnalyzeCategory } from "../analyze-category";

describe("resolveBuiltInAnalyzeCategory", () => {
  it("keeps desktop material analysis on the text catalog", () => {
    expect(
      resolveBuiltInAnalyzeCategory({
        builtInCategory: "text",
        forceTextOnly: true,
        analysisMode: "material-text",
        hasImages: false,
      })
    ).toBe("text");
  });

  it("defaults text-only material analysis to the text catalog", () => {
    expect(
      resolveBuiltInAnalyzeCategory({
        forceTextOnly: true,
        analysisMode: "material-text",
        hasImages: false,
      })
    ).toBe("text");
  });

  it("uses multimodal only when no explicit category is provided and images are present", () => {
    expect(resolveBuiltInAnalyzeCategory({ hasImages: true })).toBe("multimodal");
  });
});
