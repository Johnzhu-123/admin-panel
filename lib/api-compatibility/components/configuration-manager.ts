import { ConfigurationManager } from '../interfaces';
import {
  ProviderConfig,
  APIProvider,
  AuthenticationType,
  RetryConfig,
  RateLimitConfig,
} from '../types';

/**
 * Predefined provider templates for common API providers
 */
const PROVIDER_TEMPLATES: Record<string, Partial<ProviderConfig>> = {
  openai: {
    name: 'OpenAI',
    authType: 'bearer',
    supportedFormats: ['url', 'b64_json'],
    pathMappings: {
      'images/generations': '/v1/images/generations',
      'chat/completions': '/v1/chat/completions',
    },
    customHeaders: {
      'Content-Type': 'application/json',
    },
    retryConfig: {
      maxRetries: 3,
      backoffMs: 1000,
      retryableErrors: ['rate_limit', 'network_error', 'timeout'],
    },
    timeoutMs: 30000,
    rateLimits: {
      requestsPerMinute: 60,
      requestsPerHour: 1000,
      burstLimit: 10,
    },
  },
  
  anthropic: {
    name: 'Anthropic Claude',
    authType: 'custom_header',
    supportedFormats: ['url'],
    pathMappings: {
      'images/generations': '/v1/messages',
      'chat/completions': '/v1/messages',
    },
    customHeaders: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    retryConfig: {
      maxRetries: 2,
      backoffMs: 2000,
      retryableErrors: ['rate_limit', 'network_error'],
    },
    timeoutMs: 60000,
    rateLimits: {
      requestsPerMinute: 30,
      requestsPerHour: 500,
      burstLimit: 5,
    },
  },
  
  cohere: {
    name: 'Cohere',
    authType: 'bearer',
    supportedFormats: ['url', 'b64_json'],
    pathMappings: {
      'images/generations': '/v1/generate',
      'chat/completions': '/v1/chat',
    },
    customHeaders: {
      'Content-Type': 'application/json',
    },
    retryConfig: {
      maxRetries: 3,
      backoffMs: 1500,
      retryableErrors: ['rate_limit', 'network_error'],
    },
    timeoutMs: 45000,
    rateLimits: {
      requestsPerMinute: 100,
      requestsPerHour: 2000,
      burstLimit: 20,
    },
  },
  
  huggingface: {
    name: 'Hugging Face',
    authType: 'bearer',
    supportedFormats: ['url', 'b64_json'],
    pathMappings: {
      'images/generations': '/models/{model}/generate',
      'chat/completions': '/models/{model}/chat',
    },
    customHeaders: {
      'Content-Type': 'application/json',
    },
    retryConfig: {
      maxRetries: 2,
      backoffMs: 3000,
      retryableErrors: ['rate_limit', 'network_error'],
    },
    timeoutMs: 120000,
    rateLimits: {
      requestsPerMinute: 20,
      requestsPerHour: 300,
      burstLimit: 3,
    },
  },
  
  replicate: {
    name: 'Replicate',
    authType: 'bearer',
    supportedFormats: ['url'],
    pathMappings: {
      'images/generations': '/v1/predictions',
      'chat/completions': '/v1/predictions',
    },
    customHeaders: {
      'Content-Type': 'application/json',
    },
    retryConfig: {
      maxRetries: 3,
      backoffMs: 2000,
      retryableErrors: ['rate_limit', 'network_error'],
    },
    timeoutMs: 180000, // Replicate can be slow
    rateLimits: {
      requestsPerMinute: 10,
      requestsPerHour: 100,
      burstLimit: 2,
    },
  },
  
  'azure-openai': {
    name: 'Azure OpenAI',
    authType: 'api_key',
    supportedFormats: ['url', 'b64_json'],
    pathMappings: {
      'images/generations': '/openai/deployments/{deployment-id}/images/generations',
      'chat/completions': '/openai/deployments/{deployment-id}/chat/completions',
    },
    customHeaders: {
      'Content-Type': 'application/json',
    },
    retryConfig: {
      maxRetries: 3,
      backoffMs: 1000,
      retryableErrors: ['rate_limit', 'network_error'],
    },
    timeoutMs: 30000,
    rateLimits: {
      requestsPerMinute: 120,
      requestsPerHour: 2000,
      burstLimit: 20,
    },
  },
};

/**
 * Configuration manager implementation
 * Manages API provider configurations and templates
 */
export class ConfigurationManagerImpl implements ConfigurationManager {
  private configurations: Map<string, ProviderConfig> = new Map();
  private configHistory: Map<string, ProviderConfig[]> = new Map();

  constructor() {
    // Initialize with default configurations
    this.initializeDefaultConfigurations();
  }

  /**
   * Get provider configuration by ID
   */
  getProviderConfig(providerId: string): ProviderConfig | null {
    return this.configurations.get(providerId) || null;
  }

  /**
   * Set provider configuration
   */
  setProviderConfig(config: ProviderConfig): void {
    // Validate configuration
    this.validateConfiguration(config);
    
    // Store previous configuration in history
    const existingConfig = this.configurations.get(config.id);
    if (existingConfig) {
      this.addToHistory(config.id, existingConfig);
    }
    
    // Set new configuration
    this.configurations.set(config.id, { ...config });
  }

  /**
   * Get predefined template by provider name
   */
  getProviderTemplate(providerName: string): ProviderConfig | null {
    const template = PROVIDER_TEMPLATES[providerName.toLowerCase()];
    if (!template) {
      return null;
    }

    // Create a complete configuration from template
    const config: ProviderConfig = {
      id: providerName.toLowerCase(),
      name: template.name || providerName,
      baseUrl: '', // Must be provided by user
      authType: template.authType || 'bearer',
      supportedFormats: template.supportedFormats || ['url'],
      pathMappings: template.pathMappings || {},
      customHeaders: template.customHeaders || {},
      retryConfig: template.retryConfig || this.getDefaultRetryConfig(),
      timeoutMs: template.timeoutMs || 30000,
      rateLimits: template.rateLimits || this.getDefaultRateLimits(),
    };

    return config;
  }

  /**
   * Auto-detect configuration for a provider
   */
  async autoDetectConfig(provider: APIProvider): Promise<ProviderConfig> {
    // Start with a template if available
    let config = this.getProviderTemplate(this.detectProviderType(provider));
    
    if (!config) {
      // Create a basic configuration
      config = this.createBasicConfig(provider);
    } else {
      // Update template with provider-specific information
      config.id = provider.id;
      config.baseUrl = provider.baseUrl;
    }

    // Detect authentication type if not specified
    if (!config.authType) {
      config.authType = await this.detectAuthType(provider);
    }

    // Detect supported formats
    config.supportedFormats = await this.detectSupportedFormats(provider);

    // Detect optimal timeout and retry settings
    config.timeoutMs = await this.detectOptimalTimeout(provider);
    config.retryConfig = await this.detectOptimalRetryConfig(provider);

    return config;
  }

  /**
   * List all available provider templates
   */
  listProviderTemplates(): string[] {
    return Object.keys(PROVIDER_TEMPLATES);
  }

  /**
   * Get all configured providers
   */
  getAllConfigurations(): ProviderConfig[] {
    return Array.from(this.configurations.values());
  }

  /**
   * Remove a provider configuration
   */
  removeProviderConfig(providerId: string): boolean {
    return this.configurations.delete(providerId);
  }

  /**
   * Get configuration history for a provider
   */
  getConfigurationHistory(providerId: string): ProviderConfig[] {
    return this.configHistory.get(providerId) || [];
  }

  /**
   * Restore a previous configuration
   */
  restoreConfiguration(providerId: string, historyIndex: number): boolean {
    const history = this.configHistory.get(providerId);
    if (!history || historyIndex < 0 || historyIndex >= history.length) {
      return false;
    }

    const configToRestore = history[historyIndex];
    this.setProviderConfig(configToRestore);
    return true;
  }

  /**
   * Export configurations to JSON
   */
  exportConfigurations(): string {
    const configs = Array.from(this.configurations.values());
    return JSON.stringify(configs, null, 2);
  }

  /**
   * Import configurations from JSON
   */
  importConfigurations(jsonData: string): { success: number; errors: string[] } {
    const result = { success: 0, errors: [] as string[] };
    
    try {
      const configs: ProviderConfig[] = JSON.parse(jsonData);
      
      if (!Array.isArray(configs)) {
        result.errors.push('Invalid JSON format: expected array of configurations');
        return result;
      }

      for (const config of configs) {
        try {
          this.validateConfiguration(config);
          this.setProviderConfig(config);
          result.success++;
        } catch (error) {
          result.errors.push(`Failed to import config ${config.id}: ${error.message}`);
        }
      }
    } catch (error) {
      result.errors.push(`JSON parsing error: ${error.message}`);
    }

    return result;
  }

  /**
   * Clear all configurations
   */
  clearAllConfigurations(): void {
    this.configurations.clear();
    this.configHistory.clear();
  }

  /**
   * Merge configurations (useful for updating existing configs)
   */
  mergeConfiguration(providerId: string, partialConfig: Partial<ProviderConfig>): boolean {
    const existingConfig = this.configurations.get(providerId);
    if (!existingConfig) {
      return false;
    }

    const mergedConfig: ProviderConfig = {
      ...existingConfig,
      ...partialConfig,
      id: providerId, // Ensure ID doesn't change
    };

    this.setProviderConfig(mergedConfig);
    return true;
  }

  private initializeDefaultConfigurations(): void {
    // Initialize with some common provider templates
    const commonProviders = ['openai', 'anthropic', 'cohere'];
    
    for (const providerName of commonProviders) {
      const template = this.getProviderTemplate(providerName);
      if (template) {
        // Don't set these as active configurations since they lack baseUrl
        // They're just available as templates
      }
    }
  }

  private validateConfiguration(config: ProviderConfig): void {
    if (!config.id || typeof config.id !== 'string') {
      throw new Error('Configuration must have a valid ID');
    }

    if (!config.name || typeof config.name !== 'string') {
      throw new Error('Configuration must have a valid name');
    }

    if (!config.baseUrl || typeof config.baseUrl !== 'string') {
      throw new Error('Configuration must have a valid baseUrl');
    }

    if (!config.authType || !['bearer', 'api_key', 'custom_header'].includes(config.authType)) {
      throw new Error('Configuration must have a valid authType');
    }

    if (!Array.isArray(config.supportedFormats) || config.supportedFormats.length === 0) {
      throw new Error('Configuration must have at least one supported format');
    }

    if (typeof config.timeoutMs !== 'number' || config.timeoutMs <= 0) {
      throw new Error('Configuration must have a valid timeout');
    }

    // Validate retry config
    if (!config.retryConfig || typeof config.retryConfig !== 'object') {
      throw new Error('Configuration must have a valid retry config');
    }

    if (typeof config.retryConfig.maxRetries !== 'number' || config.retryConfig.maxRetries < 0) {
      throw new Error('Retry config must have a valid maxRetries');
    }

    // Validate rate limits
    if (!config.rateLimits || typeof config.rateLimits !== 'object') {
      throw new Error('Configuration must have valid rate limits');
    }
  }

  private addToHistory(providerId: string, config: ProviderConfig): void {
    if (!this.configHistory.has(providerId)) {
      this.configHistory.set(providerId, []);
    }

    const history = this.configHistory.get(providerId)!;
    history.push({ ...config });

    // Keep only the last 10 configurations
    if (history.length > 10) {
      history.splice(0, history.length - 10);
    }
  }

  private detectProviderType(provider: APIProvider): string {
    const baseUrl = provider.baseUrl.toLowerCase();
    
    if (baseUrl.includes('openai.com')) return 'openai';
    if (baseUrl.includes('anthropic.com')) return 'anthropic';
    if (baseUrl.includes('cohere.ai')) return 'cohere';
    if (baseUrl.includes('huggingface.co')) return 'huggingface';
    if (baseUrl.includes('replicate.com')) return 'replicate';
    if (baseUrl.includes('azure.com') && baseUrl.includes('openai')) return 'azure-openai';
    
    return 'generic';
  }

  private createBasicConfig(provider: APIProvider): ProviderConfig {
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      authType: provider.authType,
      supportedFormats: ['url'],
      pathMappings: {
        'images/generations': '/v1/images/generations',
        'chat/completions': '/v1/chat/completions',
      },
      customHeaders: provider.customHeaders || {},
      retryConfig: this.getDefaultRetryConfig(),
      timeoutMs: 30000,
      rateLimits: this.getDefaultRateLimits(),
    };
  }

  private async detectAuthType(provider: APIProvider): Promise<AuthenticationType> {
    // This is a simplified implementation
    // In a real scenario, this would make test requests to detect auth type
    return provider.authType || 'bearer';
  }

  private async detectSupportedFormats(provider: APIProvider): Promise<string[]> {
    // This is a simplified implementation
    // In a real scenario, this would test different formats
    return ['url', 'b64_json'];
  }

  private async detectOptimalTimeout(provider: APIProvider): Promise<number> {
    // This is a simplified implementation
    // In a real scenario, this would make test requests to measure response times
    const baseUrl = provider.baseUrl.toLowerCase();
    
    if (baseUrl.includes('replicate')) return 180000; // Replicate is slow
    if (baseUrl.includes('huggingface')) return 120000; // HF can be slow
    if (baseUrl.includes('anthropic')) return 60000; // Claude can be slow
    
    return 30000; // Default timeout
  }

  private async detectOptimalRetryConfig(provider: APIProvider): Promise<RetryConfig> {
    // This is a simplified implementation
    // In a real scenario, this would analyze error patterns
    return this.getDefaultRetryConfig();
  }

  private getDefaultRetryConfig(): RetryConfig {
    return {
      maxRetries: 3,
      backoffMs: 1000,
      retryableErrors: ['rate_limit', 'network_error', 'timeout'],
    };
  }

  private getDefaultRateLimits(): RateLimitConfig {
    return {
      requestsPerMinute: 60,
      requestsPerHour: 1000,
      burstLimit: 10,
    };
  }
}