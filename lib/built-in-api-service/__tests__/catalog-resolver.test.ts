/**
 * @jest-environment node
 *
 * 🔧 FIX (2026-06-11 BUG-D2) 单测：catalog 解析器必须尊重用户请求的模型——
 * requestedModel 命中 subtask.model/models[] 时按用户所选返回；
 * 未命中时回退 subtask.model 并打上 modelFallback 标记。
 */

import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { resolveBuiltInWithCatalog } from "../catalog-resolver";
import { pickAllowedModel, resolveBuiltInCategoryConfig } from "../apply-cloud-config";
import { getInternalServiceConfig } from "../db";

jest.mock("../db", () => ({
  getInternalServiceConfig: jest.fn(),
}));

jest.mock("../index", () => ({
  getBuiltInAPIService: () => ({
    initialize: async () => undefined,
    checkUserAuthorization: async () => true,
  }),
}));

const REAL_KEY = "sk-real-upstream-key-0123456789abcdef";

const makeSubtask = (overrides: Record<string, unknown> = {}) => ({
  id: "default",
  displayName: "默认",
  baseUrl: "https://upstream.example/v1",
  apiKey: REAL_KEY,
  model: "default-model",
  models: ["default-model", "alt-model"],
  isEnabled: true,
  ...overrides,
});

const mockCatalogEntry = (subtask: Record<string, unknown>) => {
  (getInternalServiceConfig as jest.Mock).mockImplementation(async () => ({
    subtask,
    categoryDefaultSubtaskId: "default",
  }));
};

describe("resolveBuiltInWithCatalog requestedModel (BUG-D2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses the requested model when it hits subtask.models[]", async () => {
    mockCatalogEntry(makeSubtask());
    const resolved = await resolveBuiltInWithCatalog("user-1", "text", "alt-model");
    expect(resolved).not.toBeNull();
    expect(resolved!.model).toBe("alt-model");
    expect(resolved!.modelFallback).toBeUndefined();
  });

  it("uses the requested model when it equals subtask.model", async () => {
    mockCatalogEntry(makeSubtask());
    const resolved = await resolveBuiltInWithCatalog("user-1", "text", "default-model");
    expect(resolved).not.toBeNull();
    expect(resolved!.model).toBe("default-model");
    expect(resolved!.modelFallback).toBeUndefined();
  });

  it("falls back to subtask.model and flags modelFallback for unknown models", async () => {
    mockCatalogEntry(makeSubtask());
    const resolved = await resolveBuiltInWithCatalog("user-1", "text", "rogue-model");
    expect(resolved).not.toBeNull();
    expect(resolved!.model).toBe("default-model");
    expect(resolved!.modelFallback).toBe(true);
  });

  it("keeps subtask.model without fallback flag when no model requested", async () => {
    mockCatalogEntry(makeSubtask());
    const resolved = await resolveBuiltInWithCatalog("user-1", "text");
    expect(resolved).not.toBeNull();
    expect(resolved!.model).toBe("default-model");
    expect(resolved!.modelFallback).toBeUndefined();
  });

  // 🔧 FIX (2026-06-11 BUG-C20): 占位 key 视同未配置
  it("rejects placeholder api keys as unconfigured", async () => {
    mockCatalogEntry(makeSubtask({ apiKey: "sk-test-1234567890-abcdefg" }));
    const resolved = await resolveBuiltInWithCatalog("user-1", "text", "alt-model");
    expect(resolved).toBeNull();
  });
});

describe("resolveBuiltInCategoryConfig requestedModel (BUG-D2, tts/video 等价调用点)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("honors a requested model from subtask.models[]", async () => {
    mockCatalogEntry(makeSubtask());
    const config = await resolveBuiltInCategoryConfig("tts", undefined, "alt-model");
    expect(config).not.toBeNull();
    expect(config!.model).toBe("alt-model");
    expect(config!.modelFallback).toBeUndefined();
  });

  it("falls back with modelFallback flag for models outside the allow list", async () => {
    mockCatalogEntry(makeSubtask());
    const config = await resolveBuiltInCategoryConfig("tts", undefined, "rogue-model");
    expect(config).not.toBeNull();
    expect(config!.model).toBe("default-model");
    expect(config!.modelFallback).toBe(true);
  });
});

describe("pickAllowedModel (BUG-D2 共享校验逻辑)", () => {
  it("matches against trimmed model entries", () => {
    expect(
      pickAllowedModel({ model: "m1", models: [" m1 ", "m2 "] }, "m2")
    ).toEqual({ model: "m2", modelFallback: false });
  });

  it("treats legacy catalogs without models[] as default-only", () => {
    expect(pickAllowedModel({ model: "m1" }, "m9")).toEqual({
      model: "m1",
      modelFallback: true,
    });
  });

  it("does not flag fallback when nothing was requested", () => {
    expect(pickAllowedModel({ model: "m1", models: ["m1"] }, "")).toEqual({
      model: "m1",
      modelFallback: false,
    });
  });
});
