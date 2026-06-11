// Path normalization component for third-party API compatibility

import { PathNormalizer as IPathNormalizer } from '../interfaces';
import { ValidationResult } from '../types';

export class PathNormalizer implements IPathNormalizer {
  /**
   * 🔧 FIX (2026-06-11 G3): 把绝对 URL 拆成 origin + 路径 + query/hash。原实现的
   * /v1 检测、去重、追加全部直接跑在完整 URL 字符串上，主机名里含 "v1" 时
   * （如 v1.api.example.com、property 测试随机生成的 v1a.a.aa）会被当成路径段：
   * 二次规范化触发"去重"，把 origin 和路径一起搅碎成 http://v1 之类的垃圾——
   * 这就是 path-normalizer.property 幂等性用例随机种子偶发红的真实根因。
   * 拆分后所有 /v1 处理只作用于 pathname，origin 原样保留。
   */
  private splitAbsoluteUrl(
    url: string
  ): { origin: string; path: string; suffix: string } | null {
    if (!/^https?:\/\//i.test(url)) {
      return null;
    }
    try {
      const parsed = new URL(url);
      return {
        origin: parsed.origin,
        path: parsed.pathname.replace(/\/+$/, ''),
        suffix: `${parsed.search}${parsed.hash}`
      };
    } catch {
      return null;
    }
  }

  /**
   * Normalizes API paths to ensure proper /v1 prefix handling
   * Validates: Requirements 1.1, 1.2, 1.3, 1.4
   */
  normalizePath(baseUrl: string, endpoint: string): string {
    if (!baseUrl || typeof baseUrl !== 'string') {
      throw new Error('Base URL is required and must be a string');
    }

    const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
    const trimmedEndpoint = (endpoint || '').trim();

    // Handle absolute URLs in endpoint
    if (/^https?:\/\//i.test(trimmedEndpoint)) {
      return this.normalizeAbsoluteUrl(trimmedEndpoint);
    }

    // Normalize the base URL first
    const normalizedBase = this.normalizeBaseUrl(trimmedBase);

    // Handle endpoint path
    if (!trimmedEndpoint) {
      return normalizedBase;
    }

    const cleanEndpoint = trimmedEndpoint.startsWith('/') ? trimmedEndpoint : `/${trimmedEndpoint}`;

    // If endpoint already starts with /v1, combine with root base
    if (/^\/v1/i.test(cleanEndpoint)) {
      const rootBase = normalizedBase.replace(/\/v1(?:beta|alpha)?$/i, '');
      return `${rootBase}${cleanEndpoint}`;
    }

    return `${normalizedBase}${cleanEndpoint}`;
  }

  /**
   * Detects duplicate /v1 paths in URLs
   * Validates: Requirements 1.1, 1.2
   */
  detectDuplicatePaths(url: string): boolean {
    if (!url || typeof url !== 'string') {
      return false;
    }

    const trimmed = url.trim();

    // 🔧 FIX (2026-06-11 G3): 绝对 URL 只检查 pathname，避免主机名里的 "v1"
    // （如 v1a.example.com）被误判成路径段；非绝对输入保持原行为。
    const parts = this.splitAbsoluteUrl(trimmed);
    const target = parts ? parts.path : trimmed;

    // Check for various duplicate patterns
    const duplicatePatterns = [
      /\/v1.*\/v1/i,           // /v1.../v1
      /\/v\/v1/i,              // /v/v1
      /\/V\/v1/i,              // /V/v1
      /\/V1.*\/v1/i,           // /V1.../v1
      /\/v1beta.*\/v1/i,       // /v1beta.../v1
      /\/v1alpha.*\/v1/i,      // /v1alpha.../v1
    ];

    // Also check for standalone /V1 pattern (should be /v1)
    const standaloneV1Pattern = /\/V1(?![a-z])/;

    return duplicatePatterns.some(pattern => pattern.test(target)) ||
           standaloneV1Pattern.test(target);
  }

  /**
   * Validates URL structure and provides suggestions
   * Validates: Requirements 1.4
   */
  validateUrl(url: string): ValidationResult {
    const result: ValidationResult = {
      isValid: true,
      issues: [],
      suggestedFix: undefined
    };

    if (!url || typeof url !== 'string') {
      result.isValid = false;
      result.issues.push('URL is required and must be a string');
      return result;
    }

    const trimmed = url.trim();

    // Check for valid URL format
    try {
      new URL(trimmed);
    } catch {
      result.isValid = false;
      result.issues.push('Invalid URL format');
      result.suggestedFix = 'Ensure URL starts with http:// or https://';
      return result;
    }

    // Check for duplicate paths
    if (this.detectDuplicatePaths(trimmed)) {
      result.isValid = false;
      result.issues.push('Duplicate /v1 paths detected');
      result.suggestedFix = this.normalizePath(trimmed, '');
    }

    // 🔧 FIX (2026-06-11 G3): 这两项启发式检查同样只看 pathname（保留原始尾斜杠）——
    // 完整 URL 上 'http://v1...' 会误中 '//v1'，'http://v1/' 会误中 endsWith('/v1/')。
    let heuristicTarget = trimmed;
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        heuristicTarget = new URL(trimmed).pathname;
      } catch {
        // keep full string for unparseable input
      }
    }

    // Check for common issues
    if (heuristicTarget.includes('//v1')) {
      result.issues.push('Double slash before /v1 detected');
      if (!result.suggestedFix) {
        result.suggestedFix = trimmed.replace(/([^:])\/\/v1/g, '$1/v1');
      }
    }

    if (heuristicTarget.endsWith('/v1/')) {
      result.issues.push('Trailing slash after /v1 detected');
      if (!result.suggestedFix) {
        result.suggestedFix = trimmed.replace(/\/v1\/$/, '/v1');
      }
    }

    // Check for unsupported protocols
    if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) {
      result.isValid = false;
      result.issues.push('Only HTTP and HTTPS protocols are supported');
    }

    return result;
  }

  /**
   * Normalizes base URL to ensure proper /v1 handling
   * Private helper method
   */
  private normalizeBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, '');

    // 🔧 FIX (2026-06-11 G3): 绝对 URL 先拆 origin，/v1 检测与追加只作用于
    // pathname，主机名里的 "v1"（如 v1.api.example.com）不再被当成路径段处理；
    // 非绝对输入（normalizeAbsoluteUrl 传入的纯 pathname）保持原有整串逻辑。
    const parts = this.splitAbsoluteUrl(trimmed);
    if (parts) {
      return `${parts.origin}${this.normalizeBasePathPart(parts.path)}${parts.suffix}`;
    }

    return this.normalizeBasePathPart(trimmed);
  }

  /**
   * Applies the /v1 normalization rules to a path-only string
   * Private helper method（原 normalizeBaseUrl 的整串逻辑，仅作用域改为路径）
   */
  private normalizeBasePathPart(pathPart: string): string {
    const trimmed = pathPart.replace(/\/+$/, '');

    // Check for incorrect duplicate path patterns first
    if (this.detectDuplicatePaths(trimmed)) {
      return this.collapseDuplicatePaths(trimmed);
    }

    // Check if already contains /v1 path
    const v1Match = trimmed.match(/\/v1(?:beta|alpha)?(?:\/|$)/i);
    if (v1Match && v1Match.index !== undefined) {
      // If already contains /v1, remove trailing slash and return
      const end = v1Match.index + v1Match[0].length;
      const sliceEnd = v1Match[0].endsWith('/') ? end - 1 : end;
      return trimmed.slice(0, sliceEnd);
    }

    // 🔧 FIX (2026-06-11 G3): 追加 /v1 后可能恰好拼出 detectDuplicatePaths 认定的
    // 笔误模式（如路径以 /v 结尾 → '/v/v1'；以 /V1x 结尾 → '/V1x/v1'），下一轮
    // 规范化会按"修复"路径改写它，破坏幂等性（property 测试随机生成 http://a.aa/v
    // 时偶发红）。追加后立即收敛到修复不动点，保证一次规范化输出即为稳定形态。
    const appended = `${trimmed}/v1`;
    return this.detectDuplicatePaths(appended)
      ? this.collapseDuplicatePaths(appended)
      : appended;
  }

  /**
   * 🔧 FIX (2026-06-11 G3): 反复应用 fixDuplicatePaths 直到不再被判定为重复
   * （或不再变化）为止。fixDuplicatePaths 单次执行对混合大小写/v1 前缀段
   * （如 '/V1x/v1' → '/V1' → '/v1'）可能需要多轮才稳定，单轮结果会让
   * 二次规范化得到不同输出。收敛到不动点后，规范化天然幂等。
   */
  private collapseDuplicatePaths(pathname: string): string {
    let current = pathname;
    while (this.detectDuplicatePaths(current)) {
      const next = this.fixDuplicatePaths(current);
      if (next === current) {
        break;
      }
      current = next;
    }
    return current;
  }

  /**
   * Normalizes absolute URLs
   * Private helper method
   */
  private normalizeAbsoluteUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      
      // Check if pathname already has proper /v1 structure
      if (this.detectDuplicatePaths(pathname)) {
        // Fix duplicate paths in pathname
        // 🔧 FIX (2026-06-11 G3): 与 normalizeBasePathPart 一致，收敛到不动点
        const fixedPath = this.collapseDuplicatePaths(pathname);
        urlObj.pathname = fixedPath;
      } else if (!pathname.includes('/v1')) {
        // Add /v1 if not present
        const normalizedPath = this.normalizeBaseUrl(pathname.replace(/\/+$/, '') || '');
        urlObj.pathname = normalizedPath;
      }
      
      return urlObj.toString();
    } catch {
      // If URL parsing fails, return original
      return url;
    }
  }

  /**
   * Fixes duplicate paths in a pathname
   * Private helper method
   */
  private fixDuplicatePaths(pathname: string): string {
    // Remove duplicate /v1 patterns
    let fixed = pathname;
    
    // Fix /v/v1 -> /v1
    fixed = fixed.replace(/\/v\/v1/gi, '/v1');
    
    // Fix /V/v1 -> /v1
    fixed = fixed.replace(/\/V\/v1/gi, '/v1');
    
    // Fix /V1 -> /v1
    fixed = fixed.replace(/\/V1(?![a-z])/gi, '/v1');
    
    // Fix multiple /v1 occurrences - keep only the first one
    const v1Matches = fixed.match(/\/v1(?:beta|alpha)?/gi);
    if (v1Matches && v1Matches.length > 1) {
      const firstV1 = v1Matches[0];
      const beforeFirst = fixed.substring(0, fixed.indexOf(firstV1));
      const afterLast = fixed.substring(fixed.lastIndexOf(v1Matches[v1Matches.length - 1]) + v1Matches[v1Matches.length - 1].length);
      fixed = beforeFirst + firstV1 + afterLast;
    }
    
    return fixed;
  }
}