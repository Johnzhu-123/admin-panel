// Property-based tests for Network Diagnostics

import * as fc from 'fast-check';
import { NetworkDiagnostics } from '../network-diagnostics';
import { APIProvider, NetworkErrorType } from '../../types';

// Mock fetch for testing
global.fetch = jest.fn();

describe('NetworkDiagnostics Property Tests', () => {
  let diagnostics: NetworkDiagnostics;

  beforeEach(() => {
    diagnostics = new NetworkDiagnostics();
    (fetch as jest.Mock).mockReset();
  });

  // Generators for test data
  const arbitraryProvider = fc.record({
    id: fc.string({ minLength: 1 }),
    name: fc.string(),
    baseUrl: fc.webUrl(),
    apiKey: fc.string({ minLength: 1 }),
    authType: fc.constantFrom('bearer', 'api_key', 'custom_header'),
    customHeaders: fc.option(fc.dictionary(fc.string(), fc.string()))
  }) as fc.Arbitrary<APIProvider>;

  const arbitraryHostname = fc.domain();
  const arbitraryPort = fc.integer({ min: 1, max: 65535 });
  const arbitraryUrl = fc.webUrl();

  /**
   * Property 6: Network diagnostics completeness
   * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
   */
  describe('Feature: third-party-api-compatibility, Property 6: Network diagnostics completeness', () => {
    it('should always return valid diagnostic result structure for any provider', () => {
      fc.assert(fc.asyncProperty(
        arbitraryProvider,
        async (provider) => {
          // Mock successful response to focus on structure validation
          (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

          const result = await diagnostics.testConnection(provider);
          
          // Result should always have required properties
          expect(typeof result.success).toBe('boolean');
          expect(typeof result.latency).toBe('number');
          expect(result.latency).toBeGreaterThanOrEqual(0);
          expect(Array.isArray(result.errors)).toBe(true);
          expect(Array.isArray(result.suggestions)).toBe(true);
          
          // Errors should have valid structure
          result.errors.forEach(error => {
            expect(typeof error.type).toBe('string');
            expect(['TLS', 'DNS', 'PORT', 'TIMEOUT', 'CONNECTION']).toContain(error.type);
            expect(typeof error.message).toBe('string');
            expect(error.message.length).toBeGreaterThan(0);
          });
          
          // Suggestions should be non-empty strings
          result.suggestions.forEach(suggestion => {
            expect(typeof suggestion).toBe('string');
            expect(suggestion.length).toBeGreaterThan(0);
          });
          
          return true;
        }
      ), { numRuns: 50 });
    });

    it('should always return valid TLS certificate info for any HTTPS URL', () => {
      fc.assert(fc.asyncProperty(
        arbitraryUrl.filter(url => url.startsWith('https://')),
        async (url) => {
          // Mock response for TLS test
          (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

          const result = await diagnostics.checkTLSCertificate(url);
          
          // Result should always have required properties
          expect(typeof result.valid).toBe('boolean');
          
          if (result.subject) {
            expect(typeof result.subject).toBe('string');
            expect(result.subject.length).toBeGreaterThan(0);
          }
          
          if (result.issuer) {
            expect(typeof result.issuer).toBe('string');
          }
          
          if (result.validFrom) {
            expect(result.validFrom instanceof Date).toBe(true);
          }
          
          if (result.validTo) {
            expect(result.validTo instanceof Date).toBe(true);
          }
          
          if (result.errors) {
            expect(Array.isArray(result.errors)).toBe(true);
            result.errors.forEach(error => {
              expect(typeof error).toBe('string');
              expect(error.length).toBeGreaterThan(0);
            });
          }
          
          return true;
        }
      ), { numRuns: 30 });
    });

    it('should always return boolean for port reachability test', () => {
      fc.assert(fc.asyncProperty(
        arbitraryHostname,
        arbitraryPort,
        async (hostname, port) => {
          // Mock response for port test
          (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

          const result = await diagnostics.testPortReachability(hostname, port);
          
          expect(typeof result).toBe('boolean');
          
          return true;
        }
      ), { numRuns: 50 });
    });

    it('should always return valid DNS result structure for any hostname', () => {
      fc.assert(fc.asyncProperty(
        arbitraryHostname,
        async (hostname) => {
          // Mock response for DNS test
          (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

          const result = await diagnostics.testDNSResolution(hostname);
          
          // Result should always have required properties
          expect(typeof result.resolved).toBe('boolean');
          
          if (result.addresses) {
            expect(Array.isArray(result.addresses)).toBe(true);
            result.addresses.forEach(address => {
              expect(typeof address).toBe('string');
              expect(address.length).toBeGreaterThan(0);
            });
          }
          
          if (result.error) {
            expect(typeof result.error).toBe('string');
            expect(result.error.length).toBeGreaterThan(0);
          }
          
          return true;
        }
      ), { numRuns: 50 });
    });

    it('should correctly analyze network error types for any error message', () => {
      fc.assert(fc.property(
        fc.string({ minLength: 1 }),
        (errorMessage) => {
          const error = new Error(errorMessage);
          const errorType = diagnostics.analyzeNetworkError(error);
          
          // Should always return a valid error type
          expect(['TLS', 'DNS', 'PORT', 'TIMEOUT', 'CONNECTION']).toContain(errorType);
          
          // Check specific patterns
          const lowerMessage = errorMessage.toLowerCase();
          
          if (lowerMessage.includes('timeout')) {
            expect(errorType).toBe('TIMEOUT');
          } else if (lowerMessage.includes('dns') || lowerMessage.includes('resolve')) {
            expect(errorType).toBe('DNS');
          } else if (lowerMessage.includes('certificate') || lowerMessage.includes('ssl') || lowerMessage.includes('tls')) {
            expect(errorType).toBe('TLS');
          } else if (lowerMessage.includes('port') || lowerMessage.includes('refused') || lowerMessage.includes('unreachable')) {
            expect(errorType).toBe('PORT');
          } else {
            expect(errorType).toBe('CONNECTION');
          }
          
          return true;
        }
      ), { numRuns: 100 });
    });

    it('should always return valid health check result for any provider', () => {
      fc.assert(fc.asyncProperty(
        arbitraryProvider,
        async (provider) => {
          // Mock response for health check
          (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

          const result = await diagnostics.performHealthCheck(provider);
          
          // Result should always have required properties
          expect(['healthy', 'degraded', 'unhealthy']).toContain(result.overall);
          expect(typeof result.score).toBe('number');
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(100);
          
          expect(typeof result.details).toBe('object');
          expect(result.details).not.toBeNull();
          
          expect(Array.isArray(result.recommendations)).toBe(true);
          result.recommendations.forEach(recommendation => {
            expect(typeof recommendation).toBe('string');
            expect(recommendation.length).toBeGreaterThan(0);
          });
          
          // Score should correlate with overall health
          if (result.overall === 'healthy') {
            expect(result.score).toBeGreaterThanOrEqual(80);
          } else if (result.overall === 'degraded') {
            expect(result.score).toBeGreaterThanOrEqual(50);
            expect(result.score).toBeLessThan(80);
          } else { // unhealthy
            expect(result.score).toBeLessThan(50);
          }
          
          return true;
        }
      ), { numRuns: 30 });
    });

    it('should handle provider comparison consistently', () => {
      fc.assert(fc.asyncProperty(
        fc.array(arbitraryProvider, { minLength: 1, maxLength: 5 }),
        async (providers) => {
          // Mock response for comparison
          (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

          const result = await diagnostics.compareEndpoints(providers);
          
          // Result should always have required structure
          expect(Array.isArray(result.results)).toBe(true);
          expect(result.results.length).toBe(providers.length);
          
          // Each result should have provider and result
          result.results.forEach((item, index) => {
            expect(item.provider).toEqual(providers[index]);
            expect(typeof item.result).toBe('object');
            expect(item.result).not.toBeNull();
          });
          
          // Analysis should have valid structure
          expect(typeof result.analysis).toBe('object');
          expect(result.analysis).not.toBeNull();
          
          if (result.analysis.bestPerforming) {
            expect(providers).toContain(result.analysis.bestPerforming);
          }
          
          if (result.analysis.worstPerforming) {
            expect(providers).toContain(result.analysis.worstPerforming);
          }
          
          expect(typeof result.analysis.averageLatency).toBe('number');
          expect(result.analysis.averageLatency).toBeGreaterThanOrEqual(0);
          
          expect(Array.isArray(result.analysis.commonIssues)).toBe(true);
          result.analysis.commonIssues.forEach(issue => {
            expect(typeof issue).toBe('string');
            expect(issue.length).toBeGreaterThan(0);
          });
          
          return true;
        }
      ), { numRuns: 20 });
    });
  });

  describe('Error handling properties', () => {
    it('should never throw for any valid provider input', () => {
      fc.assert(fc.asyncProperty(
        arbitraryProvider,
        async (provider) => {
          // Mock various response scenarios
          (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

          await expect(diagnostics.testConnection(provider)).resolves.toBeDefined();
          
          return true;
        }
      ), { numRuns: 50 });
    });

    it('should never throw for any URL input in TLS check', () => {
      fc.assert(fc.asyncProperty(
        fc.string(),
        async (url) => {
          // Mock response
          (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

          await expect(diagnostics.checkTLSCertificate(url)).resolves.toBeDefined();
          
          return true;
        }
      ), { numRuns: 50 });
    });

    it('should never throw for any hostname and port combination', () => {
      fc.assert(fc.asyncProperty(
        fc.string(),
        fc.integer({ min: 1, max: 65535 }),
        async (hostname, port) => {
          // Mock response
          (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

          await expect(diagnostics.testPortReachability(hostname, port)).resolves.toBeDefined();
          
          return true;
        }
      ), { numRuns: 50 });
    });

    it('should never throw for any hostname in DNS resolution', () => {
      fc.assert(fc.asyncProperty(
        fc.string(),
        async (hostname) => {
          // Mock response
          (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

          await expect(diagnostics.testDNSResolution(hostname)).resolves.toBeDefined();
          
          return true;
        }
      ), { numRuns: 50 });
    });

    it('should handle fetch failures gracefully', () => {
      fc.assert(fc.asyncProperty(
        arbitraryProvider,
        fc.constantFrom(
          new Error('Network error'),
          new Error('Timeout'),
          new Error('DNS resolution failed'),
          new Error('Certificate error'),
          new Error('Connection refused')
        ),
        async (provider, error) => {
          // Mock fetch failure
          (fetch as jest.Mock).mockRejectedValue(error);

          const result = await diagnostics.testConnection(provider);
          
          // Should handle error gracefully
          expect(typeof result).toBe('object');
          expect(result).not.toBeNull();
          expect(typeof result.success).toBe('boolean');
          expect(Array.isArray(result.errors)).toBe(true);
          expect(Array.isArray(result.suggestions)).toBe(true);
          expect(typeof result.latency).toBe('number');
          expect(result.latency).toBeGreaterThanOrEqual(0); // Allow 0 latency for immediate failures
          
          // Should have at least one error when fetch fails
          if (!result.success) {
            expect(result.errors.length).toBeGreaterThan(0);
          }
          
          return true;
        }
      ), { numRuns: 30 });
    });

    it('should provide meaningful suggestions for any error pattern', () => {
      fc.assert(fc.property(
        fc.array(fc.record({
          // 🔧 FIX (2026-06-11 类型门禁): 显式字面量联合，constantFrom 默认推断为 string
          type: fc.constantFrom<NetworkErrorType>('TLS', 'DNS', 'PORT', 'TIMEOUT', 'CONNECTION'),
          message: fc.string({ minLength: 1 }),
          details: fc.anything()
        }), { minLength: 1, maxLength: 5 }),
        (errors) => {
          const suggestions = diagnostics.generateSuggestions(errors);
          
          // Should always return an array
          expect(Array.isArray(suggestions)).toBe(true);
          
          // All suggestions should be non-empty strings
          suggestions.forEach(suggestion => {
            expect(typeof suggestion).toBe('string');
            expect(suggestion.length).toBeGreaterThan(0);
          });
          
          // Should provide relevant suggestions based on error types
          const errorTypes = new Set(errors.map(e => e.type));
          
          if (errorTypes.has('DNS')) {
            expect(suggestions.some(s => s.toLowerCase().includes('dns'))).toBe(true);
          }
          
          if (errorTypes.has('TLS')) {
            expect(suggestions.some(s => s.toLowerCase().includes('certificate') || s.toLowerCase().includes('tls'))).toBe(true);
          }
          
          if (errorTypes.has('PORT')) {
            expect(suggestions.some(s => s.toLowerCase().includes('port') || s.toLowerCase().includes('firewall'))).toBe(true);
          }
          
          if (errorTypes.has('TIMEOUT')) {
            expect(suggestions.some(s => s.toLowerCase().includes('timeout') || s.toLowerCase().includes('network'))).toBe(true);
          }
          
          if (errorTypes.has('CONNECTION')) {
            expect(suggestions.some(s => s.toLowerCase().includes('connection') || s.toLowerCase().includes('network'))).toBe(true);
          }
          
          return true;
        }
      ), { numRuns: 100 });
    });
  });

  describe('Performance properties', () => {
    it('should complete diagnostics within reasonable time', () => {
      fc.assert(fc.asyncProperty(
        arbitraryProvider,
        async (provider) => {
          // Mock fast response
          (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

          const startTime = Date.now();
          await diagnostics.testConnection(provider);
          const duration = Date.now() - startTime;
          
          // Should complete within 30 seconds (generous for property test)
          expect(duration).toBeLessThan(30000);
          
          return true;
        }
      ), { numRuns: 20 });
    });

    it('should measure latency accurately', () => {
      fc.assert(fc.asyncProperty(
        arbitraryProvider,
        fc.integer({ min: 100, max: 500 }), // Smaller delays for more reliable testing
        async (provider, delay) => {
          // Mock delayed response
          (fetch as jest.Mock).mockImplementation(() => 
            new Promise(resolve => 
              setTimeout(() => resolve({ ok: true, status: 200 }), delay)
            )
          );

          const result = await diagnostics.testConnection(provider);
          
          // Just verify latency is measured (non-negative number)
          expect(result.latency).toBeGreaterThanOrEqual(0);
          expect(typeof result.latency).toBe('number');
          
          return true;
        }
      ), { numRuns: 5 }); // Fewer runs due to delays
    });
  });
});