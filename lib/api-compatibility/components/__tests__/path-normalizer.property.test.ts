// Property-based tests for Path Normalizer
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4**

import * as fc from 'fast-check';
import { PathNormalizer } from '../path-normalizer';

describe('Feature: third-party-api-compatibility, Property 1: 路径规范化一致性', () => {
  const normalizer = new PathNormalizer();

  // Generator for valid base URLs
  const validBaseUrl = fc.oneof(
    fc.constant('https://api.example.com'),
    fc.constant('http://localhost:8080'),
    fc.constant('https://api.openai.com'),
    fc.constant('https://custom-api.com/api'),
    fc.webUrl({ validSchemes: ['http', 'https'] })
  );

  // Generator for endpoint paths
  const endpointPath = fc.oneof(
    fc.constant(''),
    fc.constant('/images/generations'),
    fc.constant('/chat/completions'),
    fc.constant('/models'),
    fc.string({ minLength: 1, maxLength: 50 }).map(s => `/${s.replace(/[^a-zA-Z0-9\-_\/]/g, '')}`)
  );

  // Generator for URLs with duplicate /v1 paths
  const urlWithDuplicateV1 = fc.tuple(validBaseUrl, fc.constantFrom('/v1', '/V1', '/v/v1', '/V/v1'))
    .map(([base, duplicate]) => `${base}${duplicate}/v1/images/generations`);

  // Generator for URLs already containing /v1
  const urlWithExistingV1 = validBaseUrl.map(base => `${base}/v1`);

  // Generator for URLs without /v1
  const urlWithoutV1 = validBaseUrl.filter(url => !url.includes('/v1'));

  test('Property 1.1: 对于任何包含重复/v1路径的URL，规范化后应该只有一个/v1路径段', () => {
    fc.assert(
      fc.property(urlWithDuplicateV1, (url) => {
        const normalized = normalizer.normalizePath(url, '');

        // 🔧 FIX (2026-06-11 G3): 属性声明的是"/v1 路径段"数量，统计范围应为
        // pathname；原实现对完整 URL 计数，fc.webUrl 随机生成 v1 开头的主机名
        // （如 v1.a.aa）时把主机名误计入，规范化正确也会偶发误报。
        const v1Count = (new URL(normalized).pathname.match(/\/v1(?![a-z])/gi) || []).length;

        return v1Count === 1;
      }),
      { numRuns: 100 }
    );
  });

  test('Property 1.2: 对于任何已包含/v1的URL，规范化后不应该添加额外的/v1', () => {
    fc.assert(
      fc.property(urlWithExistingV1, endpointPath, (baseUrl, endpoint) => {
        const normalized = normalizer.normalizePath(baseUrl, endpoint);
        
        // Should not have duplicate /v1 paths
        return !normalizer.detectDuplicatePaths(normalized);
      }),
      { numRuns: 100 }
    );
  });

  test('Property 1.3: 对于任何不包含/v1的URL，规范化后应该正确添加/v1前缀', () => {
    fc.assert(
      fc.property(urlWithoutV1, endpointPath, (baseUrl, endpoint) => {
        // Skip if endpoint already contains /v1
        if (endpoint.includes('/v1')) {
          return true;
        }
        
        const normalized = normalizer.normalizePath(baseUrl, endpoint);
        
        // Should contain exactly one /v1
        const v1Count = (normalized.match(/\/v1(?![a-z])/gi) || []).length;
        return v1Count === 1;
      }),
      { numRuns: 100 }
    );
  });

  test('Property 1.4: 对于任何输入URL，规范化后的URL应该是有效的', () => {
    fc.assert(
      fc.property(validBaseUrl, endpointPath, (baseUrl, endpoint) => {
        const normalized = normalizer.normalizePath(baseUrl, endpoint);
        const validation = normalizer.validateUrl(normalized);
        
        // The normalized URL should be valid or have only minor issues
        return validation.isValid || validation.issues.every(issue => 
          !issue.includes('Invalid URL format') && 
          !issue.includes('Only HTTP and HTTPS protocols are supported')
        );
      }),
      { numRuns: 100 }
    );
  });

  test('Property: 重复路径检测的一致性', () => {
    fc.assert(
      fc.property(urlWithDuplicateV1, (url) => {
        // URLs with duplicate /v1 should be detected
        return normalizer.detectDuplicatePaths(url);
      }),
      { numRuns: 100 }
    );
  });

  test('Property: 规范化的幂等性', () => {
    fc.assert(
      fc.property(validBaseUrl, endpointPath, (baseUrl, endpoint) => {
        const normalized1 = normalizer.normalizePath(baseUrl, endpoint);
        const normalized2 = normalizer.normalizePath(baseUrl, endpoint);
        
        // Normalizing the same inputs should always produce the same result
        return normalized1 === normalized2;
      }),
      { numRuns: 100 }
    );
  });

  test('Property: 基础URL规范化的幂等性', () => {
    fc.assert(
      fc.property(validBaseUrl, (baseUrl) => {
        const normalized1 = normalizer.normalizePath(baseUrl, '');
        const normalized2 = normalizer.normalizePath(normalized1, '');
        
        // Normalizing a base URL twice should produce the same result
        return normalized1 === normalized2;
      }),
      { numRuns: 100 }
    );
  });

  test('Property: URL验证的完整性', () => {
    fc.assert(
      fc.property(fc.string(), (randomString) => {
        const validation = normalizer.validateUrl(randomString);
        
        // Validation should always return a result with boolean isValid
        return typeof validation.isValid === 'boolean' &&
               Array.isArray(validation.issues);
      }),
      { numRuns: 100 }
    );
  });
});