import { parseJsonFromText } from "../ai";

// 🔧 FIX (2026-06-11 BUG-D3)：与桌面端 BUG-A1 同款回归锁（两仓 lib/ai.ts 为镜像拷贝）。
// 历史 bug：围栏正则把 \s 写成 \\s，```json 提取分支 100% 失效；顶层数组无兜底。
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
