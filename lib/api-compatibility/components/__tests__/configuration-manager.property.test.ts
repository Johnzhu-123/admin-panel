import * as fc from 'fast-check';
import { ConfigurationManagerImpl } from '../configuration-manager';
import { ProviderConfig, APIProvider, AuthenticationType } from '../../types';

describe('ConfigurationManagerImpl Property Tests', () => {
  let manager: ConfigurationManagerImpl;

  beforeEach(() => {
    manager = new ConfigurationManagerImpl();
  });

  // Generators for property tests
  // 🔧 FIX (2026-06-11 类型门禁): 显式声明字面量联合，constantFrom 默认推断为 string
  const arbitraryAuthType = fc.constantFrom<AuthenticationType>('bearer', 'api_key', 'custom_header');
  
  const arbitraryRetryConfig = fc.record({
    maxRetries: fc.integer({ min: 0, max: 10 }),
    backoffMs: fc.integer({ min: 100, max: 10000 }),
    retryableErrors: fc.array(fc.string(), { minLength: 0, maxLength: 5 }),
  });

  const arbitraryRateLimits = fc.record({
    requestsPerMinute: fc.integer({ min: 1, max: 1000 }),
    requestsPerHour: fc.integer({ min: 10, max: 10000 }),
    burstLimit: fc.integer({ min: 1, max: 100 }),
  });

  const arbitraryProviderConfig = fc.record({
    id: fc.string({ minLength: 1, maxLength: 50 }),
    name: fc.string({ minLength: 1, maxLength: 100 }),
    baseUrl: fc.webUrl(),
    authType: arbitraryAuthType,
    supportedFormats: fc.array(fc.constantFrom('url', 'b64_json'), { minLength: 1, maxLength: 2 }),
    pathMappings: fc.dictionary(fc.string(), fc.string()),
    customHeaders: fc.dictionary(fc.string(), fc.string()),
    retryConfig: arbitraryRetryConfig,
    timeoutMs: fc.integer({ min: 1000, max: 300000 }),
    rateLimits: arbitraryRateLimits,
  });

  const arbitraryAPIProvider = fc.record({
    id: fc.string({ minLength: 1, maxLength: 50 }),
    name: fc.string({ minLength: 1, maxLength: 100 }),
    baseUrl: fc.webUrl(),
    apiKey: fc.string({ minLength: 1, maxLength: 200 }),
    authType: arbitraryAuthType,
    customHeaders: fc.option(fc.dictionary(fc.string(), fc.string())),
  });

  /**
   * Property 9: 配置管理灵活性
   * For any API提供商，系统应该支持自定义配置、提供预设模板、自动检测参数，并允许用户覆盖默认配置
   * Validates: Requirements 8.1, 8.2, 8.3, 8.4
   */
  it('Feature: third-party-api-compatibility, Property 9: 配置管理灵活性', () => {
    fc.assert(
      fc.property(arbitraryProviderConfig, (config) => {
        // Property: Should be able to store and retrieve any valid configuration
        manager.setProviderConfig(config);
        const retrieved = manager.getProviderConfig(config.id);
        
        expect(retrieved).toEqual(config);

        // Property: Should support configuration updates
        const updatedConfig = { ...config, name: config.name + ' Updated' };
        manager.setProviderConfig(updatedConfig);
        const retrievedUpdated = manager.getProviderConfig(config.id);
        
        expect(retrievedUpdated!.name).toBe(config.name + ' Updated');
        expect(retrievedUpdated!.id).toBe(config.id);

        // Property: Should maintain configuration history
        const history = manager.getConfigurationHistory(config.id);
        expect(history.length).toBeGreaterThan(0);
        expect(history[history.length - 1].name).toBe(config.name);
      }),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Configuration validation consistency
   * For any configuration, validation should be consistent and comprehensive
   */
  it('Feature: third-party-api-compatibility, Property: Configuration validation consistency', () => {
    fc.assert(
      fc.property(arbitraryProviderConfig, (config) => {
        // Property: Valid configurations should be accepted
        expect(() => manager.setProviderConfig(config)).not.toThrow();
        
        // Property: Configurations with empty ID should be rejected
        const invalidIdConfig = { ...config, id: '' };
        expect(() => manager.setProviderConfig(invalidIdConfig)).toThrow();
        
        // Property: Configurations with empty name should be rejected
        const invalidNameConfig = { ...config, name: '' };
        expect(() => manager.setProviderConfig(invalidNameConfig)).toThrow();
        
        // Property: Configurations with empty baseUrl should be rejected
        const invalidUrlConfig = { ...config, baseUrl: '' };
        expect(() => manager.setProviderConfig(invalidUrlConfig)).toThrow();
        
        // Property: Configurations with empty supportedFormats should be rejected
        const invalidFormatsConfig = { ...config, supportedFormats: [] };
        expect(() => manager.setProviderConfig(invalidFormatsConfig)).toThrow();
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Property: Template consistency and availability
   * For any provider template, it should be consistently available and valid
   */
  it('Feature: third-party-api-compatibility, Property: Template consistency and availability', () => {
    fc.assert(
      fc.property(fc.constantFrom('openai', 'anthropic', 'cohere', 'huggingface', 'replicate', 'azure-openai'), (templateName) => {
        const template1 = manager.getProviderTemplate(templateName);
        const template2 = manager.getProviderTemplate(templateName);
        
        // Property: Templates should be consistently available
        expect(template1).toBeDefined();
        expect(template2).toBeDefined();
        expect(template1).toEqual(template2);
        
        // Property: Templates should have required fields
        expect(template1!.name).toBeDefined();
        expect(typeof template1!.name).toBe('string');
        expect(template1!.name.length).toBeGreaterThan(0);
        
        expect(template1!.authType).toBeDefined();
        expect(['bearer', 'api_key', 'custom_header']).toContain(template1!.authType);
        
        expect(template1!.supportedFormats).toBeDefined();
        expect(Array.isArray(template1!.supportedFormats)).toBe(true);
        expect(template1!.supportedFormats.length).toBeGreaterThan(0);
        
        expect(template1!.retryConfig).toBeDefined();
        expect(typeof template1!.retryConfig.maxRetries).toBe('number');
        expect(template1!.retryConfig.maxRetries).toBeGreaterThanOrEqual(0);
        
        expect(template1!.timeoutMs).toBeDefined();
        expect(typeof template1!.timeoutMs).toBe('number');
        expect(template1!.timeoutMs).toBeGreaterThan(0);
      }),
      { numRuns: 20 }
    );
  });

  /**
   * Property: Auto-detection consistency
   * For any API provider, auto-detection should produce valid configurations
   */
  it('Feature: third-party-api-compatibility, Property: Auto-detection consistency', () => {
    fc.assert(
      fc.asyncProperty(arbitraryAPIProvider, async (provider) => {
        const detectedConfig = await manager.autoDetectConfig(provider);
        
        // Property: Auto-detected config should be valid
        expect(detectedConfig.id).toBe(provider.id);
        expect(detectedConfig.baseUrl).toBe(provider.baseUrl);
        expect(detectedConfig.name).toBeDefined();
        expect(detectedConfig.authType).toBeDefined();
        expect(['bearer', 'api_key', 'custom_header']).toContain(detectedConfig.authType);
        
        // Property: Should be able to store auto-detected config
        expect(() => manager.setProviderConfig(detectedConfig)).not.toThrow();
        
        // Property: Auto-detection should be deterministic for same input
        const detectedConfig2 = await manager.autoDetectConfig(provider);
        expect(detectedConfig).toEqual(detectedConfig2);
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Property: Configuration history integrity
   * For any sequence of configuration updates, history should be accurately maintained
   */
  it('Feature: third-party-api-compatibility, Property: Configuration history integrity', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryProviderConfig, { minLength: 2, maxLength: 5 }).chain(configs => {
          // Ensure all configs have the same ID but different content
          const baseId = configs[0].id;
          return fc.constant(configs.map((config, index) => ({
            ...config,
            id: baseId,
            name: `${config.name} v${index + 1}`, // Make names different
            timeoutMs: config.timeoutMs + index * 1000, // Make timeouts different
          })));
        }),
        (configs) => {
          if (configs.length === 0) return;
          
          const providerId = configs[0].id;
          
          // Clear any existing history first
          manager.clearAllConfigurations();
          
          // Apply configurations in sequence
          configs.forEach(config => {
            manager.setProviderConfig(config);
          });
          
          const history = manager.getConfigurationHistory(providerId);
          
          // Property: History should contain previous configurations (up to limit)
          const expectedHistoryLength = Math.min(configs.length - 1, 10);
          expect(history.length).toBe(expectedHistoryLength);
          
          // Property: Current configuration should be the last one
          const current = manager.getProviderConfig(providerId);
          expect(current).toEqual(configs[configs.length - 1]);
          
          // Property: Should be able to restore any historical configuration
          if (history.length > 0) {
            const restored = manager.restoreConfiguration(providerId, 0);
            expect(restored).toBe(true);
            
            const restoredConfig = manager.getProviderConfig(providerId);
            expect(restoredConfig).toBeDefined();
            expect(restoredConfig!.id).toBe(providerId);
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property: Export/Import consistency
   * For any set of configurations, export and import should preserve data integrity
   */
  it('Feature: third-party-api-compatibility, Property: Export/Import consistency', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryProviderConfig, { minLength: 1, maxLength: 3 }).chain(configs => {
          // Ensure all configs have unique IDs
          return fc.constant(configs.map((config, index) => ({
            ...config,
            id: `provider-${index}`,
          })));
        }),
        (configs) => {
          // Clear any existing configurations
          manager.clearAllConfigurations();
          
          // Store all configurations
          configs.forEach(config => {
            manager.setProviderConfig(config);
          });
          
          // Export configurations
          const exported = manager.exportConfigurations();
          
          // Property: Export should produce valid JSON
          expect(() => JSON.parse(exported)).not.toThrow();
          
          // Clear and import
          manager.clearAllConfigurations();
          expect(manager.getAllConfigurations()).toHaveLength(0);
          
          const importResult = manager.importConfigurations(exported);
          
          // Property: Import should succeed for valid data
          expect(importResult.success).toBe(configs.length);
          expect(importResult.errors).toHaveLength(0);
          
          // Property: All configurations should be restored
          const restoredConfigs = manager.getAllConfigurations();
          expect(restoredConfigs).toHaveLength(configs.length);
          
          // Property: Each configuration should be identical to original
          configs.forEach(originalConfig => {
            const restored = manager.getProviderConfig(originalConfig.id);
            expect(restored).toEqual(originalConfig);
          });
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property: Merge configuration consistency
   * For any configuration and partial update, merge should preserve integrity
   */
  it('Feature: third-party-api-compatibility, Property: Merge configuration consistency', () => {
    fc.assert(
      fc.property(
        arbitraryProviderConfig,
        fc.record({
          name: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
          timeoutMs: fc.option(fc.integer({ min: 1000, max: 300000 }), { nil: undefined }),
          supportedFormats: fc.option(fc.array(fc.constantFrom('url', 'b64_json'), { minLength: 1, maxLength: 2 }), { nil: undefined }),
        }),
        (originalConfig, partialUpdate) => {
          // Store original configuration
          manager.setProviderConfig(originalConfig);
          
          // Filter out undefined values from partial update
          const cleanPartialUpdate = Object.fromEntries(
            Object.entries(partialUpdate).filter(([_, value]) => value !== undefined)
          );
          
          // Merge partial update
          const merged = manager.mergeConfiguration(originalConfig.id, cleanPartialUpdate);
          expect(merged).toBe(true);
          
          const updatedConfig = manager.getProviderConfig(originalConfig.id);
          expect(updatedConfig).toBeDefined();
          
          // Property: ID should never change
          expect(updatedConfig!.id).toBe(originalConfig.id);
          
          // Property: Updated fields should have new values
          if (cleanPartialUpdate.name !== undefined) {
            expect(updatedConfig!.name).toBe(cleanPartialUpdate.name);
          } else {
            expect(updatedConfig!.name).toBe(originalConfig.name);
          }
          
          if (cleanPartialUpdate.timeoutMs !== undefined) {
            expect(updatedConfig!.timeoutMs).toBe(cleanPartialUpdate.timeoutMs);
          } else {
            expect(updatedConfig!.timeoutMs).toBe(originalConfig.timeoutMs);
          }
          
          // Property: Non-updated fields should remain unchanged
          expect(updatedConfig!.baseUrl).toBe(originalConfig.baseUrl);
          expect(updatedConfig!.authType).toBe(originalConfig.authType);
        }
      ),
      { numRuns: 30 }
    );
  });

  /**
   * Property: Template list consistency
   * Template list should be consistent and contain expected providers
   */
  it('Feature: third-party-api-compatibility, Property: Template list consistency', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const templates1 = manager.listProviderTemplates();
        const templates2 = manager.listProviderTemplates();
        
        // Property: Template list should be consistent
        expect(templates1).toEqual(templates2);
        
        // Property: Should contain expected providers
        const expectedProviders = ['openai', 'anthropic', 'cohere', 'huggingface', 'replicate', 'azure-openai'];
        expectedProviders.forEach(provider => {
          expect(templates1).toContain(provider);
        });
        
        // Property: All listed templates should be retrievable
        templates1.forEach(templateName => {
          const template = manager.getProviderTemplate(templateName);
          expect(template).toBeDefined();
        });
        
        // Property: Template list should not contain duplicates
        const uniqueTemplates = [...new Set(templates1)];
        expect(templates1).toEqual(uniqueTemplates);
      }),
      { numRuns: 10 }
    );
  });

  /**
   * Property: Configuration removal consistency
   * For any configuration, removal should be consistent and complete
   */
  it('Feature: third-party-api-compatibility, Property: Configuration removal consistency', () => {
    fc.assert(
      fc.property(arbitraryProviderConfig, (config) => {
        // Store configuration
        manager.setProviderConfig(config);
        expect(manager.getProviderConfig(config.id)).toEqual(config);
        
        // Remove configuration
        const removed = manager.removeProviderConfig(config.id);
        expect(removed).toBe(true);
        
        // Property: Configuration should no longer exist
        expect(manager.getProviderConfig(config.id)).toBeNull();
        
        // Property: Removing non-existent configuration should return false
        const removedAgain = manager.removeProviderConfig(config.id);
        expect(removedAgain).toBe(false);
        
        // Property: Configuration should not appear in getAllConfigurations
        const allConfigs = manager.getAllConfigurations();
        expect(allConfigs.find(c => c.id === config.id)).toBeUndefined();
      }),
      { numRuns: 30 }
    );
  });
});