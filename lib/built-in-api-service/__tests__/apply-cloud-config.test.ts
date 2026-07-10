/** @jest-environment node */

import { applyBuiltInConfigToBody } from "../apply-cloud-config";

describe("built-in catalog credential binding", () => {
  const config = {
    baseUrl: "https://catalog.example/v1",
    apiKey: "catalog-secret",
    model: "catalog-model",
    subtaskId: "default",
  };

  it("overwrites caller-controlled base URLs and API keys as one capability", () => {
    const result = applyBuiltInConfigToBody(
      {
        useBuiltInService: true,
        baseUrl: "https://attacker.example",
        openAiBaseUrl: "https://attacker.example/v1",
        geminiBaseUrl: "https://attacker.example/gemini",
        geminiCompatBaseUrl: "https://attacker.example/compat",
        apiKey: "caller-key",
      },
      config
    );

    expect(result).toMatchObject({
      baseUrl: config.baseUrl,
      openAiBaseUrl: config.baseUrl,
      geminiBaseUrl: config.baseUrl,
      geminiCompatBaseUrl: config.baseUrl,
      apiKey: config.apiKey,
    });
  });

  it("does not inject catalog secrets outside built-in mode", () => {
    const input = {
      useBuiltInService: false,
      baseUrl: "https://user.example/v1",
      apiKey: "user-key",
    };
    expect(applyBuiltInConfigToBody(input, config)).toBe(input);
  });
});
