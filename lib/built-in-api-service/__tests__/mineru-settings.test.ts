import {
  DEFAULT_MINERU_RUNTIME_SETTINGS,
  mergeMinerURuntimeSettings,
  saveMinerURuntimeSettings,
  sanitizeMinerURuntimeSettings,
} from "../mineru-settings";
import { setSystemSetting } from "../db";

jest.mock("../db", () => ({
  getSystemSetting: jest.fn().mockResolvedValue(null),
  initializeSystemSettingsTable: jest.fn().mockResolvedValue(undefined),
  setSystemSetting: jest.fn(),
}));

const mockSetSystemSetting = setSystemSetting as jest.MockedFunction<
  typeof setSystemSetting
>;

describe("MinerU runtime settings", () => {
  beforeEach(() => {
    mockSetSystemSetting.mockReset();
  });

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

  it("does not persist a plaintext token in production without encryption", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousKey = process.env.BUILT_IN_ENCRYPTION_KEY;
    const previousKeyId = process.env.BUILT_IN_ENCRYPTION_KEY_ID;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.BUILT_IN_ENCRYPTION_KEY;
    delete process.env.BUILT_IN_ENCRYPTION_KEY_ID;

    try {
      await expect(
        saveMinerURuntimeSettings({ apiToken: "must-not-be-plaintext" })
      ).rejects.toThrow(/encryption key/i);
      expect(mockSetSystemSetting).not.toHaveBeenCalled();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = previousNodeEnv;
      if (previousKey === undefined) delete process.env.BUILT_IN_ENCRYPTION_KEY;
      else process.env.BUILT_IN_ENCRYPTION_KEY = previousKey;
      if (previousKeyId === undefined) delete process.env.BUILT_IN_ENCRYPTION_KEY_ID;
      else process.env.BUILT_IN_ENCRYPTION_KEY_ID = previousKeyId;
    }
  });
});
