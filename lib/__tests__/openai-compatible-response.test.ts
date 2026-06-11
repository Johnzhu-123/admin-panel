import {
  describeOpenAiCompatibleEmptyReason,
  extractOpenAiCompatibleError,
  extractOpenAiCompatibleText,
  parseOpenAiCompatibleResponseText,
  summarizeOpenAiCompatiblePayload,
} from "../openai-compatible-response";

describe("openai compatible response helpers", () => {
  it("extracts text from normal chat responses", () => {
    expect(
      extractOpenAiCompatibleText({
        choices: [{ message: { content: "hello" } }],
      })
    ).toBe("hello");
  });

  it("extracts upstream error envelopes even when HTTP status is 200", () => {
    const payload = {
      error: {
        message: "All connection attempts failed",
        type: "upstream_error",
      },
    };

    expect(extractOpenAiCompatibleError(payload)).toBe(
      "All connection attempts failed"
    );
    expect(describeOpenAiCompatibleEmptyReason(payload)).toBe(
      "All connection attempts failed"
    );
  });

  it("summarizes payloads for diagnostics", () => {
    const summary = summarizeOpenAiCompatiblePayload({
      error: { message: "boom" },
    });

    expect(summary).toContain("boom");
  });

  it("parses SSE chat completion chunks into normal text", () => {
    const payload = [
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      "data: [DONE]",
    ].join("\n\n");

    const parsed = parseOpenAiCompatibleResponseText(payload);

    expect(extractOpenAiCompatibleText(parsed)).toBe("你好");
  });

  it("parses data-prefixed full chat responses", () => {
    const parsed = parseOpenAiCompatibleResponseText(
      'data: {"choices":[{"message":{"content":[{"type":"text","text":"脚本正文"}]}}]}'
    );

    expect(extractOpenAiCompatibleText(parsed)).toBe("脚本正文");
  });

  it("explains primitive empty upstream responses", () => {
    const parsed = parseOpenAiCompatibleResponseText("0");

    expect(parsed).toBe(0);
    expect(describeOpenAiCompatibleEmptyReason(parsed)).toContain(
      "上游返回了空的原始值"
    );
  });

  // 🔧 FIX (2026-06-11 BUG-CS1): 同一 chunk 内 delta.content 与 message.content
  // 并存时只取 delta，文本不得被重复拼接。
  it("does not duplicate text when a chunk carries both delta.content and message.content", () => {
    const payload = [
      'data: {"choices":[{"delta":{"content":"你"},"message":{"content":"你"}}]}',
      'data: {"choices":[{"delta":{"content":"好"},"message":{"content":"你好"}}]}',
      "data: [DONE]",
    ].join("\n\n");

    const parsed = parseOpenAiCompatibleResponseText(payload);

    expect(extractOpenAiCompatibleText(parsed)).toBe("你好");
  });

  // 🔧 FIX (2026-06-11 BUG-CS1): 流式 delta.tool_calls 按 index 聚合，
  // function.arguments 字符串分片必须拼接完整。
  it("aggregates streamed delta.tool_calls arguments by index", () => {
    const payload = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"draw","arguments":"{\\"pro"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mpt\\":\\"cat\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ].join("\n\n");

    const parsed = parseOpenAiCompatibleResponseText(payload);
    const toolCalls = parsed?.choices?.[0]?.message?.tool_calls;

    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("call_1");
    expect(toolCalls[0].function.name).toBe("draw");
    expect(toolCalls[0].function.arguments).toBe('{"prompt":"cat"}');
    // tool_calls-only 流也要能通过 extract 提取出参数文本
    expect(extractOpenAiCompatibleText(parsed)).toBe('{"prompt":"cat"}');
  });
});
