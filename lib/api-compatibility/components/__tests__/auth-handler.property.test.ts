// Property-based tests for Authentication Handler
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

import * as fc from 'fast-check';
import { AuthenticationHandler } from '../auth-handler';
import { APIProvider, HTTPRequest, AuthenticationType } from '../../types';

describe('Feature: third-party-api-compatibility, Property 5: 认证方式兼容性', () => {
  const authHandler = new AuthenticationHandler();

  // Generator for valid API keys
  const apiKey = fc.oneof(
    fc.string({ minLength: 10, maxLength: 100 }).filter(s => s.trim().length > 0),
    fc.constant('sk-1234567890abcdef'),
    fc.constant('api_key_test_123'),
    fc.constant('bearer_token_xyz')
  );

  // Generator for authentication types
  const authType = fc.constantFrom<AuthenticationType>('bearer', 'api_key', 'custom_header');

  // Generator for valid base URLs
  const baseUrl = fc.oneof(
    fc.constant('https://api.openai.com'),
    fc.constant('https://api.anthropic.com'),
    fc.constant('http://localhost:8080'),
    fc.webUrl({ validSchemes: ['http', 'https'] })
  );

  // Generator for provider names
  const providerName = fc.oneof(
    fc.constantFrom('openai', 'anthropic', 'cohere', 'huggingface', 'replicate'),
    fc.string({ minLength: 3, maxLength: 20 })
      .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s))
      .filter(s => !['constructor', 'prototype', '__proto__', 'toString', 'valueOf'].includes(s.toLowerCase()))
  );

  // Generator for API providers
  const apiProvider = fc.record({
    id: fc.string({ minLength: 1, maxLength: 50 }),
    name: providerName,
    baseUrl: baseUrl,
    apiKey: apiKey,
    authType: authType,
    customHeaders: fc.option(fc.dictionary(
      fc.string({ minLength: 1, maxLength: 30 }),
      fc.string({ minLength: 1, maxLength: 100 })
    ))
  }) as fc.Arbitrary<APIProvider>;

  // Generator for HTTP requests
  const httpRequest = fc.record({
    url: baseUrl,
    method: fc.constantFrom('GET', 'POST', 'PUT', 'PATCH', 'DELETE'),
    headers: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 30 }),
      fc.string({ minLength: 1, maxLength: 100 })
    )
  }) as fc.Arbitrary<HTTPRequest>;

  test('Property 4.1: 对于任何Bearer Token认证，应该正确设置Authorization头', () => {
    fc.assert(
      fc.property(httpRequest, apiKey, baseUrl, (request, key, url) => {
        const provider: APIProvider = {
          id: 'test',
          name: 'test',
          baseUrl: url,
          apiKey: key,
          authType: 'bearer'
        };

        const result = authHandler.applyAuthentication(request, provider);
        
        return result.headers['Authorization'] === `Bearer ${key}`;
      }),
      { numRuns: 100 }
    );
  });

  test('Property 4.2: 对于任何API Key认证，应该正确设置X-API-Key头', () => {
    fc.assert(
      fc.property(httpRequest, apiKey, baseUrl, (request, key, url) => {
        const provider: APIProvider = {
          id: 'test',
          name: 'test',
          baseUrl: url,
          apiKey: key,
          authType: 'api_key'
        };

        const result = authHandler.applyAuthentication(request, provider);
        
        return result.headers['X-API-Key'] === key;
      }),
      { numRuns: 100 }
    );
  });

  test('Property 4.3: 对于任何自定义Header认证，应该正确应用自定义头', () => {
    fc.assert(
      fc.property(httpRequest, apiKey, baseUrl, (request, key, url) => {
        const customHeaders = { 'custom-auth': '{API_KEY}', 'x-custom': 'value' };
        const provider: APIProvider = {
          id: 'test',
          name: 'test',
          baseUrl: url,
          apiKey: key,
          authType: 'custom_header',
          customHeaders
        };

        const result = authHandler.applyAuthentication(request, provider);
        
        return result.headers['custom-auth'] === key &&
               result.headers['x-custom'] === 'value';
      }),
      { numRuns: 100 }
    );
  });

  test('Property 4.4: 对于任何API提供商，应该能够自动选择正确的认证方式', () => {
    fc.assert(
      fc.property(providerName, (name) => {
        const pattern = authHandler.getKnownProviderAuthPattern(name);
        
        // Should return a valid auth pattern
        return pattern.authType !== undefined &&
               ['bearer', 'api_key', 'custom_header'].includes(pattern.authType) &&
               typeof pattern.customHeaders === 'object';
      }),
      { numRuns: 100 }
    );
  });

  test('Property: 认证应用的幂等性', () => {
    fc.assert(
      fc.property(apiProvider, httpRequest, (provider, request) => {
        const result1 = authHandler.applyAuthentication(request, provider);
        const result2 = authHandler.applyAuthentication(request, provider);
        
        // Applying authentication twice should produce the same result
        return JSON.stringify(result1.headers) === JSON.stringify(result2.headers);
      }),
      { numRuns: 100 }
    );
  });

  test('Property: 原始请求不应被修改', () => {
    fc.assert(
      fc.property(apiProvider, httpRequest, (provider, request) => {
        const originalHeaders = JSON.stringify(request.headers);
        const originalUrl = request.url;
        const originalMethod = request.method;
        
        authHandler.applyAuthentication(request, provider);
        
        // Original request should remain unchanged
        return JSON.stringify(request.headers) === originalHeaders &&
               request.url === originalUrl &&
               request.method === originalMethod;
      }),
      { numRuns: 100 }
    );
  });

  test('Property: POST请求应该自动添加Content-Type', () => {
    fc.assert(
      fc.property(apiProvider, baseUrl, (provider, url) => {
        const postRequest: HTTPRequest = {
          url: url,
          method: 'POST',
          headers: {}
        };
        
        const result = authHandler.applyAuthentication(postRequest, provider);
        
        return result.headers['Content-Type'] === 'application/json';
      }),
      { numRuns: 100 }
    );
  });

  test('Property: 多重认证方法应该包含所有标准头', () => {
    fc.assert(
      fc.property(apiProvider, httpRequest, (provider, request) => {
        const result = authHandler.applyMultipleAuthMethods(request, provider);
        
        // Should include all standard auth headers
        return result.headers['Authorization'] === `Bearer ${provider.apiKey}` &&
               result.headers['X-API-Key'] === provider.apiKey &&
               result.headers['api-key'] === provider.apiKey;
      }),
      { numRuns: 100 }
    );
  });

  test('Property: 认证错误提取的一致性', () => {
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 599 }), fc.string(), (status, body) => {
        // Mock Response object
        const mockResponse = { status } as Response;
        const result = authHandler.extractAuthError(mockResponse, body);
        
        // Should always return a consistent structure
        return typeof result.isAuthError === 'boolean' &&
               typeof result.errorType === 'string' &&
               typeof result.message === 'string' &&
               ['invalid_key', 'expired_key', 'insufficient_quota', 'rate_limit', 'unknown'].includes(result.errorType);
      }),
      { numRuns: 100 }
    );
  });

  test('Property: 输入验证的完整性', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (request, provider) => {
        try {
          authHandler.applyAuthentication(request as any, provider as any);
          return true; // If no error, that's fine
        } catch (error) {
          // Should throw meaningful error messages
          return error instanceof Error && error.message.length > 0;
        }
      }),
      { numRuns: 100 }
    );
  });
});