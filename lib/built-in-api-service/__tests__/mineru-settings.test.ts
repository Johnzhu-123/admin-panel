import {
  DEFAULT_MINERU_RUNTIME_SETTINGS,
  mergeMinerURuntimeSettings,
  sanitizeMinerURuntimeSettings,
} from "../mineru-settings";

describe("MinerU runtime settings", () => {
  it("normalizes admin-managed MinerU token, endpoint, and defaults", () => {
    const merged = mergeMinerURuntimeSettings(DEFAULT_MINERU_RUNTIME_SETTINGS, {
      enabled: true,
      baseUrl: "https://mineru.example.com/",
      apiToken: "  mineru-token-123  ",
      defaultOptions: {
        modelVersion: "pipeline",
        language: "en",
        enableFormula: false,
        enableTable: true,
        isOcr: true,
        extraFormats: ["docx", "html", "docx", "zip"] as unknown as Array<"docx" | "html" | "latex">,
      },
    });

    expect(merged).toMatchObject({
      enabled: true,
      baseUrl: "https://mineru.example.com",
      apiToken: "mineru-token-123",
      defaultOptions: {
        modelVersion: "pipeline",
        language: "en",
        enableFormula: false,
        enableTable: true,
        isOcr: true,
        extraFormats: ["docx", "html"],
      },
    });
  });

  it("keeps the stored token when admin UI sends a masked token", () => {
    const merged = mergeMinerURuntimeSettings(
      {
        ...DEFAULT_MINERU_RUNTIME_SETTINGS,
        apiToken: "real-token",
      },
      {
        apiToken: "real********oken",
        baseUrl: "https://mineru.net",
      }
    );

    expect(merged.apiToken).toBe("real-token");
  });

  it("sanitizes MinerU settings without exposing the raw token", () => {
    const sanitized = sanitizeMinerURuntimeSettings({
      ...DEFAULT_MINERU_RUNTIME_SETTINGS,
      apiToken: "mineru-secret-token",
    });

    expect(sanitized.apiToken).toBeUndefined();
    expect(sanitized.apiTokenConfigured).toBe(true);
    expect(sanitized.apiTokenMask).toMatch(/^mine\*+oken$/);
  });
});
