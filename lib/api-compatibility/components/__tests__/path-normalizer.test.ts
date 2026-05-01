// Unit tests for Path Normalizer
// Tests specific examples and edge cases
// Validates: Requirements 1.1, 1.2, 1.3, 1.4

import { PathNormalizer } from '../path-normalizer';

describe('PathNormalizer', () => {
  let normalizer: PathNormalizer;

  beforeEach(() => {
    normalizer = new PathNormalizer();
  });

  describe('normalizePath', () => {
    describe('基本功能测试', () => {
      test('应该为不包含/v1的URL添加/v1前缀', () => {
        const result = normalizer.normalizePath('https://api.example.com', '/images/generations');
        expect(result).toBe('https://api.example.com/v1/images/generations');
      });

      test('应该保持已包含/v1的URL不变', () => {
        const result = normalizer.normalizePath('https://api.example.com/v1', '/images/generations');
        expect(result).toBe('https://api.example.com/v1/images/generations');
      });

      test('应该处理空端点路径', () => {
        const result = normalizer.normalizePath('https://api.example.com', '');
        expect(result).toBe('https://api.example.com/v1');
      });

      test('应该处理绝对URL端点', () => {
        const result = normalizer.normalizePath('https://api.example.com', 'https://other-api.com/v1/images');
        expect(result).toBe('https://other-api.com/v1/images');
      });
    });

    describe('重复路径处理', () => {
      test('应该移除重复的/v1路径', () => {
        const result = normalizer.normalizePath('https://api.example.com/v1/v1', '/images/generations');
        expect(result).toBe('https://api.example.com/v1/images/generations');
      });

      test('应该修复/v/v1模式', () => {
        const result = normalizer.normalizePath('https://api.example.com/v/v1', '/images/generations');
        expect(result).toBe('https://api.example.com/v1/images/generations');
      });

      test('应该修复/V/v1模式', () => {
        const result = normalizer.normalizePath('https://api.example.com/V/v1', '/images/generations');
        expect(result).toBe('https://api.example.com/v1/images/generations');
      });

      test('应该修复/V1模式', () => {
        const result = normalizer.normalizePath('https://api.example.com/V1', '/images/generations');
        expect(result).toBe('https://api.example.com/v1/images/generations');
      });
    });

    describe('版本变体处理', () => {
      test('应该保持/v1beta路径', () => {
        const result = normalizer.normalizePath('https://api.example.com/v1beta', '/images/generations');
        expect(result).toBe('https://api.example.com/v1beta/images/generations');
      });

      test('应该保持/v1alpha路径', () => {
        const result = normalizer.normalizePath('https://api.example.com/v1alpha', '/images/generations');
        expect(result).toBe('https://api.example.com/v1alpha/images/generations');
      });
    });

    describe('端点路径处理', () => {
      test('应该处理以/v1开头的端点', () => {
        const result = normalizer.normalizePath('https://api.example.com', '/v1/images/generations');
        expect(result).toBe('https://api.example.com/v1/images/generations');
      });

      test('应该处理不以/开头的端点', () => {
        const result = normalizer.normalizePath('https://api.example.com', 'images/generations');
        expect(result).toBe('https://api.example.com/v1/images/generations');
      });
    });

    describe('边界情况', () => {
      test('应该处理尾部斜杠', () => {
        const result = normalizer.normalizePath('https://api.example.com/', '/images/generations');
        expect(result).toBe('https://api.example.com/v1/images/generations');
      });

      test('应该处理多个尾部斜杠', () => {
        const result = normalizer.normalizePath('https://api.example.com///', '/images/generations');
        expect(result).toBe('https://api.example.com/v1/images/generations');
      });

      test('应该抛出错误当baseUrl为空', () => {
        expect(() => normalizer.normalizePath('', '/images/generations')).toThrow('Base URL is required');
      });

      test('应该抛出错误当baseUrl不是字符串', () => {
        expect(() => normalizer.normalizePath(null as any, '/images/generations')).toThrow('Base URL is required');
      });
    });
  });

  describe('detectDuplicatePaths', () => {
    test('应该检测到/v1.../v1模式', () => {
      expect(normalizer.detectDuplicatePaths('https://api.example.com/v1/something/v1')).toBe(true);
    });

    test('应该检测到/v/v1模式', () => {
      expect(normalizer.detectDuplicatePaths('https://api.example.com/v/v1')).toBe(true);
    });

    test('应该检测到/V/v1模式', () => {
      expect(normalizer.detectDuplicatePaths('https://api.example.com/V/v1')).toBe(true);
    });

    test('应该检测到/V1.../v1模式', () => {
      expect(normalizer.detectDuplicatePaths('https://api.example.com/V1/something/v1')).toBe(true);
    });

    test('应该检测到/v1beta.../v1模式', () => {
      expect(normalizer.detectDuplicatePaths('https://api.example.com/v1beta/something/v1')).toBe(true);
    });

    test('应该检测到/v1alpha.../v1模式', () => {
      expect(normalizer.detectDuplicatePaths('https://api.example.com/v1alpha/something/v1')).toBe(true);
    });

    test('不应该误报正常的/v1路径', () => {
      expect(normalizer.detectDuplicatePaths('https://api.example.com/v1/images')).toBe(false);
    });

    test('不应该误报包含v1但不重复的路径', () => {
      expect(normalizer.detectDuplicatePaths('https://api.example.com/version1/v1')).toBe(false);
    });

    test('应该处理空字符串', () => {
      expect(normalizer.detectDuplicatePaths('')).toBe(false);
    });

    test('应该处理null输入', () => {
      expect(normalizer.detectDuplicatePaths(null as any)).toBe(false);
    });
  });

  describe('validateUrl', () => {
    test('应该验证有效的URL', () => {
      const result = normalizer.validateUrl('https://api.example.com/v1');
      expect(result.isValid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    test('应该检测无效的URL格式', () => {
      const result = normalizer.validateUrl('not-a-url');
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain('Invalid URL format');
      expect(result.suggestedFix).toBe('Ensure URL starts with http:// or https://');
    });

    test('应该检测重复路径', () => {
      const result = normalizer.validateUrl('https://api.example.com/v1/v1');
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain('Duplicate /v1 paths detected');
      expect(result.suggestedFix).toBe('https://api.example.com/v1');
    });

    test('应该检测双斜杠问题', () => {
      const result = normalizer.validateUrl('https://api.example.com//v1');
      expect(result.issues).toContain('Double slash before /v1 detected');
      expect(result.suggestedFix).toBe('https://api.example.com/v1');
    });

    test('应该检测尾部斜杠问题', () => {
      const result = normalizer.validateUrl('https://api.example.com/v1/');
      expect(result.issues).toContain('Trailing slash after /v1 detected');
      expect(result.suggestedFix).toBe('https://api.example.com/v1');
    });

    test('应该拒绝不支持的协议', () => {
      const result = normalizer.validateUrl('ftp://api.example.com/v1');
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain('Only HTTP and HTTPS protocols are supported');
    });

    test('应该处理空字符串', () => {
      const result = normalizer.validateUrl('');
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain('URL is required and must be a string');
    });

    test('应该处理null输入', () => {
      const result = normalizer.validateUrl(null as any);
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain('URL is required and must be a string');
    });

    test('应该允许HTTP协议', () => {
      const result = normalizer.validateUrl('http://localhost:8080/v1');
      expect(result.isValid).toBe(true);
    });
  });

  describe('真实世界的用例', () => {
    test('OpenAI官方API', () => {
      const result = normalizer.normalizePath('https://api.openai.com', '/images/generations');
      expect(result).toBe('https://api.openai.com/v1/images/generations');
    });

    test('已经包含/v1的OpenAI API', () => {
      const result = normalizer.normalizePath('https://api.openai.com/v1', '/images/generations');
      expect(result).toBe('https://api.openai.com/v1/images/generations');
    });

    test('本地开发服务器', () => {
      const result = normalizer.normalizePath('http://localhost:8080', '/chat/completions');
      expect(result).toBe('http://localhost:8080/v1/chat/completions');
    });

    test('自定义API提供商', () => {
      const result = normalizer.normalizePath('https://custom-api.com/api', '/images/generations');
      expect(result).toBe('https://custom-api.com/api/v1/images/generations');
    });

    test('修复常见的配置错误', () => {
      const result = normalizer.normalizePath('https://api.example.com/v/v1', '/images/generations');
      expect(result).toBe('https://api.example.com/v1/images/generations');
    });
  });
});