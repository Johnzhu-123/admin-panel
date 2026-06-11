import {
  convertJsonStringsToAsciiLiterals,
  escapeStringToAsciiLiterals,
  formatAsciiCodecCompatMessage,
  isAsciiCodecError,
  looksLikeGeminiModel,
  normalizeOpenAiBaseUrl,
  parseJsonFromText,
  stringifyJsonAsciiSafe,
} from "../ai";

// 🔧 FIX (2026-06-11 BUG-A1)：锁住围栏 JSON / 顶层数组 / 前后噪声四类解析场景，
// 防止 parseJsonFromText 的正则再次回归（历史 bug：\s 被写成 \\s 导致围栏分支全灭）。
describe("parseJsonFromText", () => {
  it("parses plain json objects", () => {
    expect(parseJsonFromText('{"slides":[{"title":"A"}]}')).toEqual({
      slides: [{ title: "A" }],
    });
  });

  it("parses fenced json objects (```json)", () => {
    const text = '前置说明\n```json\n{"slides":[{"title":"围栏"}]}\n```\n后置说明';
    expect(parseJsonFromText(text)).toEqual({ slides: [{ title: "围栏" }] });
  });

  it("parses fenced json without language tag", () => {
    const text = '```\n{"ok":true}\n```';
    expect(parseJsonFromText(text)).toEqual({ ok: true });
  });

  it("parses fenced top-level arrays", () => {
    const text = '```json\n[{"title":"P1"},{"title":"P2"}]\n```';
    expect(parseJsonFromText(text)).toEqual([{ title: "P1" }, { title: "P2" }]);
  });

  it("parses bare top-level arrays wrapped in prose", () => {
    const text = '模型返回如下：\n[{"title":"P1"},{"title":"P2"}]\n以上。';
    expect(parseJsonFromText(text)).toEqual([{ title: "P1" }, { title: "P2" }]);
  });

  it("parses objects wrapped in prose noise", () => {
    const text = '好的，结果是 {"slides":[]} 请查收';
    expect(parseJsonFromText(text)).toEqual({ slides: [] });
  });

  it("returns empty object for unparseable text", () => {
    expect(parseJsonFromText("完全不是 JSON")).toEqual({});
    expect(parseJsonFromText("")).toEqual({});
  });
});

describe("ai helpers", () => {
  it("serializes non-ascii characters into ascii-safe json", () => {
    const payload = {
      text: "中文😀",
      nested: ["演示", "PPT"],
    };

    const json = stringifyJsonAsciiSafe(payload);

    expect(json).toContain("\\u4e2d\\u6587");
    expect(json).toContain("\\ud83d\\ude00");
    expect(json).not.toContain("中文");
  });

  it("detects ascii codec errors from upstream services", () => {
    expect(isAsciiCodecError("upstream_error: 'ascii' codec can't encode characters")).toBe(
      true
    );
    expect(isAsciiCodecError("ordinary network timeout")).toBe(false);
  });

  it("detects Gemini-family model ids for fallback routing", () => {
    expect(looksLikeGeminiModel("gemini-3.1-pro-preview")).toBe(true);
    expect(looksLikeGeminiModel("gemini_flash")).toBe(true);
    expect(looksLikeGeminiModel("gpt-4o-mini")).toBe(false);
  });

  it("formats ascii codec errors into actionable messages", () => {
    const message = formatAsciiCodecCompatMessage(
      "upstream_error: 'ascii' codec can't encode characters in position 12-13"
    );

    expect(message).toContain("当前中转服务在转发请求时出现编码错误");
    expect(message).toContain("ASCII 安全编码");
  });

  it("keeps composite analyze error details instead of collapsing to generic codec message", () => {
    const message = formatAsciiCodecCompatMessage(
      "Gemini 兼容接口失败：'ascii' codec can't encode characters；OpenAI 兼容回退也失败：timeout"
    );

    expect(message).toContain("Gemini 兼容接口失败");
    expect(message).toContain("OpenAI 兼容回退也失败");
  });

  it("escapes unicode text to ascii literals", () => {
    expect(escapeStringToAsciiLiterals("中文😀A")).toBe("\\u4e2d\\u6587\\ud83d\\ude00A");
  });

  it("converts nested json strings to ascii literals", () => {
    const value = convertJsonStringsToAsciiLiterals({
      title: "分析中文",
      nested: [{ text: "段落😀" }, "保留ASCII123"],
      count: 1,
    }) as Record<string, unknown>;

    expect(value.title).toBe("\\u5206\\u6790\\u4e2d\\u6587");
    expect((value.nested as Array<any>)[0].text).toBe(
      "\\u6bb5\\u843d\\ud83d\\ude00"
    );
    expect((value.nested as Array<any>)[1]).toBe("\\u4fdd\\u7559ASCII123");
    expect(value.count).toBe(1);
  });
});

// 🔧 FIX (2026-06-11 BUG-CS2)：锁住 normalizeOpenAiBaseUrl 的 /v1 非末段语义，
// 防止 /v1/openai 这类中转网关前缀再次被截断回归。
describe("normalizeOpenAiBaseUrl /v1 path handling", () => {
  it("keeps the full path when /v1 is not the last segment", () => {
    expect(normalizeOpenAiBaseUrl("https://relay.example.com/v1/openai")).toBe(
      "https://relay.example.com/v1/openai"
    );
    expect(
      normalizeOpenAiBaseUrl("https://relay.example.com/v1/openai/")
    ).toBe("https://relay.example.com/v1/openai");
  });

  it("keeps existing behavior when v1/v1beta is the last segment", () => {
    expect(normalizeOpenAiBaseUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1"
    );
    expect(normalizeOpenAiBaseUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1"
    );
    expect(normalizeOpenAiBaseUrl("https://api.example.com/v1beta")).toBe(
      "https://api.example.com/v1beta"
    );
  });

  it("appends /v1 when the base url has no version segment", () => {
    expect(normalizeOpenAiBaseUrl("https://api.example.com")).toBe(
      "https://api.example.com/v1"
    );
    expect(normalizeOpenAiBaseUrl("https://api.example.com/openai/")).toBe(
      "https://api.example.com/openai/v1"
    );
  });
});
