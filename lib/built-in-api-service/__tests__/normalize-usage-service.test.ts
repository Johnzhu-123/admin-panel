/**
 * @jest-environment node
 *
 * 🔧 FIX (2026-06-11 BUG-D6) 单测：代理路由写库的 service_id 形如
 * built-in-{category}-{subtaskId}，归类前必须剥掉 built-in- 前缀，
 * 否则全部用量都被丢进"其它服务"。
 */

import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@vercel/postgres", () => ({
  sql: Object.assign(jest.fn(), { query: jest.fn() }),
}));

import { normalizeBuiltInUsageService } from "../db";

describe("normalizeBuiltInUsageService (BUG-D6)", () => {
  it("classifies built-in-tts-default as tts", () => {
    expect(normalizeBuiltInUsageService("built-in-tts-default")).toEqual({
      service: "tts",
      label: "云端 TTS",
    });
  });

  it("classifies built-in-video-default as video", () => {
    expect(normalizeBuiltInUsageService("built-in-video-default").service).toBe(
      "video"
    );
  });

  it("classifies built-in-image-generation as image", () => {
    expect(
      normalizeBuiltInUsageService("built-in-image-generation").service
    ).toBe("image");
  });

  it("still classifies built-in-mineru as mineru", () => {
    expect(normalizeBuiltInUsageService("built-in-mineru").service).toBe(
      "mineru"
    );
  });

  it("keeps legacy ids working (tts/default, built-in-default, gemini-built-in)", () => {
    expect(normalizeBuiltInUsageService("tts/default").service).toBe("tts");
    expect(normalizeBuiltInUsageService("built-in-default").service).toBe(
      "image"
    );
    expect(normalizeBuiltInUsageService("gemini-built-in").service).toBe(
      "image"
    );
  });

  it("falls back to raw id for unknown services", () => {
    expect(normalizeBuiltInUsageService("")).toEqual({
      service: "other",
      label: "其它服务",
    });
    expect(normalizeBuiltInUsageService("built-in-foo").service).toBe("foo");
  });
});
