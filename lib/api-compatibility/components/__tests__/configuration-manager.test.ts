import { ConfigurationManagerImpl } from '../configuration-manager';
import { ProviderConfig, APIProvider } from '../../types';

describe('ConfigurationManagerImpl', () => {
  let manager: ConfigurationManagerImpl;

  beforeEach(() => {
    manager = new ConfigurationManagerImpl();
  });

  describe('getProviderTemplate', () => {
    it('should return OpenAI template', () => {
      const template = manager.getProviderTemplate('openai');
      
      expect(template).toBeDefined();
      expect(template!.name).toBe('OpenAI');
      expect(template!.authType).toBe('bearer');
      expect(template!.supportedFormats).toContain('url');
      expect(template!.supportedFormats).toContain('b64_json');
      expect(template!.pathMappings['images/generations']).toBe('/v1/images/generations');
    });

    it('should return Anthropic template', () => {
      const template = manager.getProviderTemplate('anthropic');
      
      expect(template).toBeDefined();
      expect(template!.name).toBe('Anthropic Claude');
      expect(template!.authType).toBe('custom_header');
      expect(template!.customHeaders['anthropic-version']).toBe('2023-06-01');
    });

    it('should return null for unknown provider', () => {
      const template = manager.getProviderTemplate('unknown-provider');
      expect(template).toBeNull();
    });

    it('should be case insensitive', () => {
      const template1 = manager.getProviderTemplate('OpenAI');
      const template2 = manager.getProviderTemplate('OPENAI');
      const template3 = manager.getProviderTemplate('openai');
      
      expect(template1).toEqual(template2);
      expect(template2).toEqual(template3);
    });
  });

  describe('listProviderTemplates', () => {
    it('should return all available templates', () => {
      const templates = manager.listProviderTemplates();
      
      expect(templates).toContain('openai');
      expect(templates).toContain('anthropic');
      expect(templates).toContain('cohere');
      expect(templates).toContain('huggingface');
      expect(templates).toContain('replicate');
      expect(templates).toContain('azure-openai');
      expect(templates.length).toBeGreaterThan(0);
    });
  });

  describe('setProviderConfig and getProviderConfig', () => {
    it('should store and retrieve provider configuration', () => {
      const config: ProviderConfig = {
        id: 'test-provider',
        name: 'Test Provider',
        baseUrl: 'https://api.test.com',
        authType: 'bearer',
        supportedFormats: ['url'],
        pathMappings: { 'images/generations': '/v1/images' },
        customHeaders: { 'Content-Type': 'application/json' },
        retryConfig: { maxRetries: 3, backoffMs: 1000, retryableErrors: ['rate_limit'] },
        timeoutMs: 30000,
        rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, burstLimit: 10 },
      };

      manager.setProviderConfig(config);
      const retrieved = manager.getProviderConfig('test-provider');

      expect(retrieved).toEqual(config);
    });

    it('should return null for non-existent provider', () => {
      const config = manager.getProviderConfig('non-existent');
      expect(config).toBeNull();
    });

    it('should validate configuration before storing', () => {
      const invalidConfig = {
        id: '', // Invalid empty ID
        name: 'Test',
        baseUrl: 'https://api.test.com',
        authType: 'bearer',
      } as ProviderConfig;

      expect(() => manager.setProviderConfig(invalidConfig)).toThrow('Configuration must have a valid ID');
    });
  });

  describe('configuration validation', () => {
    it('should reject configuration without name', () => {
      const config = {
        id: 'test',
        name: '',
        baseUrl: 'https://api.test.com',
        authType: 'bearer',
      } as ProviderConfig;

      expect(() => manager.setProviderConfig(config)).toThrow('Configuration must have a valid name');
    });

    it('should reject configuration without baseUrl', () => {
      const config = {
        id: 'test',
        name: 'Test',
        baseUrl: '',
        authType: 'bearer',
      } as ProviderConfig;

      expect(() => manager.setProviderConfig(config)).toThrow('Configuration must have a valid baseUrl');
    });

    it('should reject configuration with invalid authType', () => {
      const config = {
        id: 'test',
        name: 'Test',
        baseUrl: 'https://api.test.com',
        authType: 'invalid' as any,
        supportedFormats: ['url'],
        pathMappings: {},
        customHeaders: {},
        retryConfig: { maxRetries: 3, backoffMs: 1000, retryableErrors: [] },
        timeoutMs: 30000,
        rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, burstLimit: 10 },
      };

      expect(() => manager.setProviderConfig(config)).toThrow('Configuration must have a valid authType');
    });

    it('should reject configuration without supported formats', () => {
      const config = {
        id: 'test',
        name: 'Test',
        baseUrl: 'https://api.test.com',
        authType: 'bearer',
        supportedFormats: [],
        pathMappings: {},
        customHeaders: {},
        retryConfig: { maxRetries: 3, backoffMs: 1000, retryableErrors: [] },
        timeoutMs: 30000,
        rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, burstLimit: 10 },
      };

      expect(() => manager.setProviderConfig(config)).toThrow('Configuration must have at least one supported format');
    });
  });

  describe('autoDetectConfig', () => {
    it('should detect OpenAI provider and use template', async () => {
      const provider: APIProvider = {
        id: 'my-openai',
        name: 'My OpenAI',
        baseUrl: 'https://api.openai.com',
        apiKey: 'test-key',
        authType: 'bearer',
      };

      const config = await manager.autoDetectConfig(provider);

      expect(config.id).toBe('my-openai');
      expect(config.baseUrl).toBe('https://api.openai.com');
      expect(config.authType).toBe('bearer');
      expect(config.supportedFormats).toContain('url');
      expect(config.pathMappings['images/generations']).toBe('/v1/images/generations');
    });

    it('should create basic config for unknown provider', async () => {
      const provider: APIProvider = {
        id: 'unknown-provider',
        name: 'Unknown Provider',
        baseUrl: 'https://api.unknown.com',
        apiKey: 'test-key',
        authType: 'api_key',
      };

      const config = await manager.autoDetectConfig(provider);

      expect(config.id).toBe('unknown-provider');
      expect(config.name).toBe('Unknown Provider');
      expect(config.baseUrl).toBe('https://api.unknown.com');
      expect(config.authType).toBe('api_key');
      expect(config.supportedFormats).toContain('url');
    });
  });

  describe('getAllConfigurations', () => {
    it('should return all stored configurations', () => {
      const config1: ProviderConfig = {
        id: 'provider1',
        name: 'Provider 1',
        baseUrl: 'https://api1.com',
        authType: 'bearer',
        supportedFormats: ['url'],
        pathMappings: {},
        customHeaders: {},
        retryConfig: { maxRetries: 3, backoffMs: 1000, retryableErrors: [] },
        timeoutMs: 30000,
        rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, burstLimit: 10 },
      };

      const config2: ProviderConfig = {
        id: 'provider2',
        name: 'Provider 2',
        baseUrl: 'https://api2.com',
        authType: 'api_key',
        supportedFormats: ['b64_json'],
        pathMappings: {},
        customHeaders: {},
        retryConfig: { maxRetries: 2, backoffMs: 2000, retryableErrors: [] },
        timeoutMs: 60000,
        rateLimits: { requestsPerMinute: 30, requestsPerHour: 500, burstLimit: 5 },
      };

      manager.setProviderConfig(config1);
      manager.setProviderConfig(config2);

      const allConfigs = manager.getAllConfigurations();
      expect(allConfigs).toHaveLength(2);
      expect(allConfigs.find(c => c.id === 'provider1')).toEqual(config1);
      expect(allConfigs.find(c => c.id === 'provider2')).toEqual(config2);
    });
  });

  describe('removeProviderConfig', () => {
    it('should remove existing configuration', () => {
      const config: ProviderConfig = {
        id: 'test-provider',
        name: 'Test Provider',
        baseUrl: 'https://api.test.com',
        authType: 'bearer',
        supportedFormats: ['url'],
        pathMappings: {},
        customHeaders: {},
        retryConfig: { maxRetries: 3, backoffMs: 1000, retryableErrors: [] },
        timeoutMs: 30000,
        rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, burstLimit: 10 },
      };

      manager.setProviderConfig(config);
      expect(manager.getProviderConfig('test-provider')).toEqual(config);

      const removed = manager.removeProviderConfig('test-provider');
      expect(removed).toBe(true);
      expect(manager.getProviderConfig('test-provider')).toBeNull();
    });

    it('should return false for non-existent configuration', () => {
      const removed = manager.removeProviderConfig('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('configuration history', () => {
    it('should track configuration history', () => {
      const config1: ProviderConfig = {
        id: 'test-provider',
        name: 'Test Provider v1',
        baseUrl: 'https://api.test.com',
        authType: 'bearer',
        supportedFormats: ['url'],
        pathMappings: {},
        customHeaders: {},
        retryConfig: { maxRetries: 3, backoffMs: 1000, retryableErrors: [] },
        timeoutMs: 30000,
        rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, burstLimit: 10 },
      };

      const config2: ProviderConfig = {
        ...config1,
        name: 'Test Provider v2',
        timeoutMs: 60000,
      };

      manager.setProviderConfig(config1);
      manager.setProviderConfig(config2);

      const history = manager.getConfigurationHistory('test-provider');
      expect(history).toHaveLength(1);
      expect(history[0].name).toBe('Test Provider v1');
    });

    it('should restore previous configuration', () => {
      const config1: ProviderConfig = {
        id: 'test-provider',
        name: 'Test Provider v1',
        baseUrl: 'https://api.test.com',
        authType: 'bearer',
        supportedFormats: ['url'],
        pathMappings: {},
        customHeaders: {},
        retryConfig: { maxRetries: 3, backoffMs: 1000, retryableErrors: [] },
        timeoutMs: 30000,
        rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, burstLimit: 10 },
      };

      const config2: ProviderConfig = {
        ...config1,
        name: 'Test Provider v2',
      };

      manager.setProviderConfig(config1);
      manager.setProviderConfig(config2);

      const restored = manager.restoreConfiguration('test-provider', 0);
      expect(restored).toBe(true);

      const currentConfig = manager.getProviderConfig('test-provider');
      expect(currentConfig!.name).toBe('Test Provider v1');
    });
  });

  describe('exportConfigurations and importConfigurations', () => {
    it('should export and import configurations', () => {
      const config: ProviderConfig = {
        id: 'test-provider',
        name: 'Test Provider',
        baseUrl: 'https://api.test.com',
        authType: 'bearer',
        supportedFormats: ['url'],
        pathMappings: {},
        customHeaders: {},
        retryConfig: { maxRetries: 3, backoffMs: 1000, retryableErrors: [] },
        timeoutMs: 30000,
        rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, burstLimit: 10 },
      };

      manager.setProviderConfig(config);
      const exported = manager.exportConfigurations();

      // Clear and import
      manager.clearAllConfigurations();
      expect(manager.getProviderConfig('test-provider')).toBeNull();

      const result = manager.importConfigurations(exported);
      expect(result.success).toBe(1);
      expect(result.errors).toHaveLength(0);

      const imported = manager.getProviderConfig('test-provider');
      expect(imported).toEqual(config);
    });

    it('should handle import errors gracefully', () => {
      const invalidJson = 'invalid json';
      const result = manager.importConfigurations(invalidJson);

      expect(result.success).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('JSON parsing error');
    });
  });

  describe('mergeConfiguration', () => {
    it('should merge partial configuration with existing one', () => {
      const originalConfig: ProviderConfig = {
        id: 'test-provider',
        name: 'Test Provider',
        baseUrl: 'https://api.test.com',
        authType: 'bearer',
        supportedFormats: ['url'],
        pathMappings: {},
        customHeaders: {},
        retryConfig: { maxRetries: 3, backoffMs: 1000, retryableErrors: [] },
        timeoutMs: 30000,
        rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, burstLimit: 10 },
      };

      manager.setProviderConfig(originalConfig);

      const partialUpdate = {
        name: 'Updated Test Provider',
        timeoutMs: 60000,
        supportedFormats: ['url', 'b64_json'],
      };

      const merged = manager.mergeConfiguration('test-provider', partialUpdate);
      expect(merged).toBe(true);

      const updatedConfig = manager.getProviderConfig('test-provider');
      expect(updatedConfig!.name).toBe('Updated Test Provider');
      expect(updatedConfig!.timeoutMs).toBe(60000);
      expect(updatedConfig!.supportedFormats).toEqual(['url', 'b64_json']);
      expect(updatedConfig!.baseUrl).toBe('https://api.test.com'); // Unchanged
    });

    it('should return false for non-existent provider', () => {
      const merged = manager.mergeConfiguration('non-existent', { name: 'New Name' });
      expect(merged).toBe(false);
    });
  });

  describe('clearAllConfigurations', () => {
    it('should clear all configurations and history', () => {
      const config: ProviderConfig = {
        id: 'test-provider',
        name: 'Test Provider',
        baseUrl: 'https://api.test.com',
        authType: 'bearer',
        supportedFormats: ['url'],
        pathMappings: {},
        customHeaders: {},
        retryConfig: { maxRetries: 3, backoffMs: 1000, retryableErrors: [] },
        timeoutMs: 30000,
        rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, burstLimit: 10 },
      };

      manager.setProviderConfig(config);
      expect(manager.getAllConfigurations()).toHaveLength(1);

      manager.clearAllConfigurations();
      expect(manager.getAllConfigurations()).toHaveLength(0);
      expect(manager.getConfigurationHistory('test-provider')).toHaveLength(0);
    });
  });
});