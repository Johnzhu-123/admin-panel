/**
 * 🔧 FIX (2026-06-11 BUG-C20): 占位 API Key 识别（替代散落各处的硬编码白名单）。
 *
 * 背景：部署模板/演示配置里常留 "sk-gemini2API..."、"your-api-key-here" 之类
 * 占位 key；下游若把它们当真实凭据发往上游，只会得到一堆 401 噪音并污染失败日志。
 * 统一在读 env 兜底 key / catalog key 的消费处先过这一道闸。
 *
 * 判定规则（trim 后）：
 *  - 空串或长度 < 20（真实 provider key 几乎都 ≥ 20 字符）
 *  - 命中占位词：placeholder / your-api-key / replace_me / replace-me / replaceme
 *  - 以演示前缀开头：sk-test / sk-demo / sk-gemini2API
 */
export function isPlaceholderApiKey(key: string): boolean {
  const trimmed = (key || "").trim();
  if (trimmed.length < 20) return true;
  return /placeholder|your-api-key|replace[_-]?me|^sk-(test|demo|gemini2API)/i.test(
    trimmed
  );
}
