// Response format adaptation component for third-party API compatibility

import { ResponseFormatAdapter as IResponseFormatAdapter } from '../interfaces';
import { 
  ImageGenerationRequest, 
  ImageGenerationResponse, 
  APIProvider,
  ImageData,
  UsageInfo,
  ErrorInfo
} from '../types';

export class ResponseFormatAdapter implements IResponseFormatAdapter {
  private readonly supportedFormats = ['url', 'b64_json'];
  private readonly knownProviderFormats: Record<string, string[]> = {
    'openai': ['url', 'b64_json'],
    'anthropic': ['url'],
    'stability': ['b64_json'],
    'midjourney': ['url'],
    'dalle': ['url', 'b64_json'],
    'replicate': ['url'],
    'huggingface': ['url', 'b64_json'],
    'together': ['url'],
    'groq': ['url'],
    'cohere': ['url']
  };

  /**
   * 🔧 FIX (2026-06-11 G3): 自有属性安全查表。extractProviderName 对未知 provider 会
   * 原样返回其 id/name，用它直接索引对象字面量会沿原型链命中 'constructor' /
   * 'toString' / 'valueOf' 等键（property 测试随机种子命中 id="constructor" 时，
   * knownProviderFormats['constructor'] 拿到 Object 构造函数 → supportedFormats.includes
   * is not a function，这就是 response-format-adapter.property 偶发红的真实根因，并非
   * 超时抖动）。本文件所有以外部可控字符串为键的字典读取统一走本方法。
   */
  private static ownEntry<T>(map: Record<string, T>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  }

  /**
   * Adapts request format based on provider capabilities
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4
   */
  adaptRequestFormat(request: ImageGenerationRequest, provider: APIProvider): ImageGenerationRequest {
    if (!request || !provider) {
      throw new Error('Request and provider are required');
    }

    const adaptedRequest: ImageGenerationRequest = { ...request };
    
    // Get supported formats for this provider
    const supportedFormats = this.getProviderSupportedFormats(provider);
    
    // If no response_format specified, use the provider's default
    if (!adaptedRequest.response_format) {
      adaptedRequest.response_format = this.getDefaultFormat(provider);
    } else {
      // Validate and potentially adjust the requested format
      if (!supportedFormats.includes(adaptedRequest.response_format)) {
        // Try to find a compatible format
        const compatibleFormat = this.findCompatibleFormat(adaptedRequest.response_format, supportedFormats);
        if (compatibleFormat) {
          adaptedRequest.response_format = compatibleFormat;
        } else {
          // Fallback to provider's default format
          adaptedRequest.response_format = this.getDefaultFormat(provider);
        }
      }
    }

    // Adapt other format-specific parameters
    adaptedRequest.model = this.adaptModelName(adaptedRequest.model, provider);
    adaptedRequest.size = this.adaptImageSize(adaptedRequest.size, provider);
    adaptedRequest.quality = this.adaptQuality(adaptedRequest.quality, provider);
    adaptedRequest.n = this.adaptImageCount(adaptedRequest.n, provider);

    return adaptedRequest;
  }

  /**
   * Adapts response format to standardized format
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4
   */
  adaptResponseFormat(response: any, provider: APIProvider): ImageGenerationResponse {
    if (!response) {
      return {
        images: [],
        error: {
          message: 'Response is required',
          code: 'invalid_response'
        }
      };
    }

    try {
      // Handle different response structures
      const standardizedResponse: ImageGenerationResponse = {
        images: [],
        usage: undefined,
        error: undefined
      };

      // Extract images based on provider format
      const images = this.extractImages(response, provider);
      standardizedResponse.images = images;

      // Extract usage information if available
      const usage = this.extractUsage(response, provider);
      if (usage) {
        standardizedResponse.usage = usage;
      }

      // Extract error information if present
      const error = this.extractError(response, provider);
      if (error) {
        standardizedResponse.error = error;
      }

      return standardizedResponse;
    } catch (error) {
      // If adaptation fails, return error response
      return {
        images: [],
        error: {
          message: `Failed to adapt response format: ${error instanceof Error ? error.message : 'Unknown error'}`,
          code: 'format_adaptation_error',
          type: 'format_error'
        }
      };
    }
  }

  /**
   * Detects supported formats by testing with the provider
   * Validates: Requirements 3.4
   */
  async detectSupportedFormats(provider: APIProvider): Promise<string[]> {
    if (!provider || !provider.baseUrl) {
      return ['url']; // Default fallback
    }

    // Check if we have cached knowledge about this provider
    const providerName = this.extractProviderName(provider);
    // 🔧 FIX (2026-06-11 G3): 改走 ownEntry，防原型链键（见 ownEntry 注释）
    const cachedFormats = ResponseFormatAdapter.ownEntry(this.knownProviderFormats, providerName);
    if (cachedFormats) {
      return [...cachedFormats];
    }

    // Test different formats to detect support
    const supportedFormats: string[] = [];
    
    for (const format of this.supportedFormats) {
      try {
        const isSupported = await this.testFormatSupport(provider, format);
        if (isSupported) {
          supportedFormats.push(format);
        }
      } catch (error) {
        // Continue testing other formats
        continue;
      }
    }

    // If no formats detected, assume basic URL support
    if (supportedFormats.length === 0) {
      supportedFormats.push('url');
    }

    // Cache the result for future use
    // 🔧 FIX (2026-06-11 G3): 普通赋值遇到 providerName='__proto__' 会改写字典原型而非
    // 落键，用 defineProperty 强制按自有属性写入。
    Object.defineProperty(this.knownProviderFormats, providerName, {
      value: supportedFormats,
      writable: true,
      enumerable: true,
      configurable: true
    });

    return supportedFormats;
  }

  /**
   * Gets supported formats for a provider
   * Private helper method
   */
  private getProviderSupportedFormats(provider: APIProvider): string[] {
    const providerName = this.extractProviderName(provider);
    // 🔧 FIX (2026-06-11 G3): 改走 ownEntry，防原型链键（见 ownEntry 注释）
    return ResponseFormatAdapter.ownEntry(this.knownProviderFormats, providerName) || ['url', 'b64_json'];
  }

  /**
   * Gets default format for a provider
   * Private helper method
   */
  private getDefaultFormat(provider: APIProvider): string {
    const supportedFormats = this.getProviderSupportedFormats(provider);
    
    // Prefer URL format as it's more widely supported
    if (supportedFormats.includes('url')) {
      return 'url';
    }
    
    // Fallback to first supported format
    return supportedFormats[0] || 'url';
  }

  /**
   * Finds a compatible format from supported formats
   * Private helper method
   */
  private findCompatibleFormat(requestedFormat: string, supportedFormats: string[]): string | null {
    // Direct match
    if (supportedFormats.includes(requestedFormat)) {
      return requestedFormat;
    }

    // Format compatibility mapping
    const compatibilityMap: Record<string, string[]> = {
      'url': ['uri', 'link', 'image_url'],
      'b64_json': ['base64', 'b64', 'binary', 'data']
    };

    for (const [standardFormat, aliases] of Object.entries(compatibilityMap)) {
      if (aliases.includes(requestedFormat.toLowerCase()) && supportedFormats.includes(standardFormat)) {
        return standardFormat;
      }
    }

    return null;
  }

  /**
   * Adapts model name for provider compatibility
   * Private helper method
   */
  private adaptModelName(model: string | undefined, provider: APIProvider): string | undefined {
    if (!model) {
      return undefined;
    }

    const providerName = this.extractProviderName(provider);
    
    // Model name mappings for different providers
    const modelMappings: Record<string, Record<string, string>> = {
      'openai': {
        'dall-e-3': 'dall-e-3',
        'dall-e-2': 'dall-e-2',
        'dalle-3': 'dall-e-3',
        'dalle-2': 'dall-e-2'
      },
      'stability': {
        'stable-diffusion': 'stable-diffusion-xl-1024-v1-0',
        'sdxl': 'stable-diffusion-xl-1024-v1-0'
      },
      'replicate': {
        'stable-diffusion': 'stability-ai/stable-diffusion',
        'sdxl': 'stability-ai/sdxl'
      }
    };

    // 🔧 FIX (2026-06-11 G3): 两级查表均改走 ownEntry——providerName 与 model 都是
    // 外部可控字符串，原型链键（如 model='constructor'）会取出函数当映射结果。
    const providerMappings = ResponseFormatAdapter.ownEntry(modelMappings, providerName);
    const mappedModel = providerMappings
      ? ResponseFormatAdapter.ownEntry(providerMappings, model.toLowerCase())
      : undefined;
    if (mappedModel) {
      return mappedModel;
    }

    return model;
  }

  /**
   * Adapts image size for provider compatibility
   * Private helper method
   */
  private adaptImageSize(size: string | undefined, provider: APIProvider): string | undefined {
    if (!size) {
      return undefined;
    }

    const providerName = this.extractProviderName(provider);
    
    // Size mappings for different providers
    const sizeMappings: Record<string, Record<string, string>> = {
      'openai': {
        '256x256': '256x256',
        '512x512': '512x512',
        '1024x1024': '1024x1024',
        '1792x1024': '1792x1024',
        '1024x1792': '1024x1792'
      },
      'stability': {
        '256x256': '512x512', // Stability doesn't support 256x256
        '512x512': '512x512',
        '1024x1024': '1024x1024'
      }
    };

    // 🔧 FIX (2026-06-11 G3): 两级查表均改走 ownEntry，防原型链键（见 ownEntry 注释）
    const providerMappings = ResponseFormatAdapter.ownEntry(sizeMappings, providerName);
    const mappedSize = providerMappings
      ? ResponseFormatAdapter.ownEntry(providerMappings, size)
      : undefined;
    if (mappedSize) {
      return mappedSize;
    }

    return size;
  }

  /**
   * Adapts quality parameter for provider compatibility
   * Private helper method
   */
  private adaptQuality(quality: string | undefined, provider: APIProvider): string | undefined {
    if (!quality) {
      return undefined;
    }

    const providerName = this.extractProviderName(provider);
    
    // Some providers don't support quality parameter
    const qualityUnsupportedProviders = ['stability', 'replicate', 'huggingface'];
    
    if (qualityUnsupportedProviders.includes(providerName)) {
      return undefined;
    }

    return quality;
  }

  /**
   * Adapts image count for provider compatibility
   * Private helper method
   */
  private adaptImageCount(n: number | undefined, provider: APIProvider): number | undefined {
    if (!n || n <= 0) {
      return undefined;
    }

    const providerName = this.extractProviderName(provider);
    
    // Provider-specific limits
    const countLimits: Record<string, number> = {
      'openai': 10,
      'stability': 1,
      'replicate': 4,
      'huggingface': 4
    };

    // 🔧 FIX (2026-06-11 G3): 改走 ownEntry，防原型链键（如 providerName='constructor'
    // 时 Math.min(n, Object 构造函数) 会得到 NaN）
    const maxCount = ResponseFormatAdapter.ownEntry(countLimits, providerName) || 10;
    
    return Math.min(n, maxCount);
  }

  /**
   * Extracts images from provider response
   * Private helper method
   */
  private extractImages(response: any, provider: APIProvider): ImageData[] {
    const images: ImageData[] = [];

    try {
      // Handle OpenAI-style response
      if (response.data && Array.isArray(response.data)) {
        for (const item of response.data) {
          const imageData: ImageData = {};
          
          // Try different property names for URL
          if (item.url || item.image_url || item.link) {
            imageData.url = item.url || item.image_url || item.link;
          }
          
          // Try different property names for base64 data
          // 🔧 FIX (2026-05 #6，云端保留): 补 `image` / `image_data` / `imageData` / `b64`
          // 字段。第三方 OpenAI-compatible 网关返回字段名各异（gpt-image-2 实测有
          // 出现仅 image 字段的形态），漏接就会触发上层 "No image data in response"。
          if (
            item.b64_json || item.b64 || item.base64 ||
            item.image || item.image_data || item.imageData ||
            (item.data && typeof item.data === 'string')
          ) {
            imageData.b64_json =
              item.b64_json || item.b64 || item.base64 ||
              item.image || item.image_data || item.imageData ||
              item.data;
          }
          
          if (item.revised_prompt) {
            imageData.revised_prompt = item.revised_prompt;
          }
          
          // Only add image if it has actual image data
          if (imageData.url || imageData.b64_json) {
            images.push(imageData);
          }
        }
      }
      // Handle direct array response
      else if (Array.isArray(response)) {
        for (const item of response) {
          if (typeof item === 'string') {
            // Assume it's a URL
            images.push({ url: item });
          } else if (typeof item === 'object' && item !== null) {
            const imageData: ImageData = {};
            
            // Try different property names for URL
            if (item.url || item.image_url || item.link) {
              imageData.url = item.url || item.image_url || item.link;
            }
            
            // Try different property names for base64 data
            if (item.b64_json || item.base64 || (item.data && typeof item.data === 'string')) {
              imageData.b64_json = item.b64_json || item.base64 || item.data;
            }
            
            // Try different property names for prompt
            if (item.revised_prompt || item.prompt) {
              imageData.revised_prompt = item.revised_prompt || item.prompt;
            }
            
            // Only add image if it has actual image data
            if (imageData.url || imageData.b64_json) {
              images.push(imageData);
            }
          }
        }
      }
      // Handle single image response
      else if (typeof response === 'object' && response !== null) {
        // Skip if this is an error-only response
        if (response.error && !response.url && !response.image_url && !response.link && 
            !response.b64_json && !response.base64 && !response.data) {
          // This is an error response, don't add empty image
          return images;
        }
        
        const imageData: ImageData = {};
        
        if (response.url || response.image_url || response.link) {
          imageData.url = response.url || response.image_url || response.link;
        }
        
        if (response.b64_json || response.base64 || (response.data && typeof response.data === 'string')) {
          imageData.b64_json = response.b64_json || response.base64 || response.data;
        }
        
        if (response.revised_prompt || response.prompt) {
          imageData.revised_prompt = response.revised_prompt || response.prompt;
        }
        
        // Only add image if it has actual image data
        if (imageData.url || imageData.b64_json) {
          images.push(imageData);
        }
      }
    } catch (error) {
      // If extraction fails, return empty array
      console.warn('Failed to extract images from response:', error);
    }

    return images;
  }

  /**
   * Extracts usage information from provider response
   * Private helper method
   */
  private extractUsage(response: any, provider: APIProvider): UsageInfo | undefined {
    try {
      if (response.usage && typeof response.usage === 'object') {
        const usage: UsageInfo = {};
        
        if (typeof response.usage.prompt_tokens === 'number') {
          usage.prompt_tokens = response.usage.prompt_tokens;
        }
        
        if (typeof response.usage.completion_tokens === 'number') {
          usage.completion_tokens = response.usage.completion_tokens;
        }
        
        if (typeof response.usage.total_tokens === 'number') {
          usage.total_tokens = response.usage.total_tokens;
        }
        
        // Return usage only if at least one field is present
        if (Object.keys(usage).length > 0) {
          return usage;
        }
      }
    } catch (error) {
      // If extraction fails, return undefined
      console.warn('Failed to extract usage from response:', error);
    }

    return undefined;
  }

  /**
   * Extracts error information from provider response
   * Private helper method
   */
  private extractError(response: any, provider: APIProvider): ErrorInfo | undefined {
    try {
      // Check for error in response
      if (response.error && typeof response.error === 'object') {
        const error: ErrorInfo = {
          message: response.error.message || 'Unknown error'
        };
        
        if (response.error.code) {
          error.code = response.error.code;
        }
        
        if (response.error.type) {
          error.type = response.error.type;
        }
        
        if (response.error.param) {
          error.param = response.error.param;
        }
        
        return error;
      }
      
      // Check for error message at root level
      if (response.message && typeof response.message === 'string') {
        return {
          message: response.message,
          code: response.code || 'unknown_error'
        };
      }
    } catch (error) {
      // If extraction fails, return undefined
      console.warn('Failed to extract error from response:', error);
    }

    return undefined;
  }

  /**
   * Extracts provider name from provider configuration
   * Private helper method
   */
  private extractProviderName(provider: APIProvider): string {
    if (!provider) {
      return 'unknown';
    }

    // Try to extract from provider name or ID
    const name = (provider.name || provider.id || '').toLowerCase().trim();
    
    // Handle common provider patterns
    if (name.includes('openai') || name.includes('dall')) {
      return 'openai';
    }
    
    if (name.includes('stability') || name.includes('stable')) {
      return 'stability';
    }
    
    if (name.includes('anthropic') || name.includes('claude')) {
      return 'anthropic';
    }
    
    if (name.includes('replicate')) {
      return 'replicate';
    }
    
    if (name.includes('huggingface') || name.includes('hf')) {
      return 'huggingface';
    }
    
    if (name.includes('together')) {
      return 'together';
    }
    
    if (name.includes('groq')) {
      return 'groq';
    }
    
    if (name.includes('cohere')) {
      return 'cohere';
    }

    // Try to extract from base URL
    if (provider.baseUrl) {
      const url = provider.baseUrl.toLowerCase();
      
      if (url.includes('openai.com') || url.includes('api.openai.com')) {
        return 'openai';
      }
      
      if (url.includes('stability.ai') || url.includes('stabilityai.com')) {
        return 'stability';
      }
      
      if (url.includes('anthropic.com')) {
        return 'anthropic';
      }
      
      if (url.includes('replicate.com')) {
        return 'replicate';
      }
      
      if (url.includes('huggingface.co')) {
        return 'huggingface';
      }
      
      if (url.includes('together.ai') || url.includes('together.xyz')) {
        return 'together';
      }
      
      if (url.includes('groq.com')) {
        return 'groq';
      }
      
      if (url.includes('cohere.ai') || url.includes('cohere.com')) {
        return 'cohere';
      }
    }

    return name || 'unknown';
  }

  /**
   * Tests if a provider supports a specific format
   * Private helper method
   */
  private async testFormatSupport(provider: APIProvider, format: string): Promise<boolean> {
    try {
      // This would typically make a test request to the provider
      // For now, we'll use heuristics based on provider type
      const providerName = this.extractProviderName(provider);
      // 🔧 FIX (2026-06-11 G3): 改走 ownEntry，防原型链键（见 ownEntry 注释）
      const knownFormats = ResponseFormatAdapter.ownEntry(this.knownProviderFormats, providerName);
      
      if (knownFormats) {
        return knownFormats.includes(format);
      }
      
      // Default assumption: most providers support URL format
      return format === 'url';
    } catch (error) {
      // If test fails, assume format is not supported
      return false;
    }
  }

  /**
   * Validates response format compatibility
   * Helper method for testing
   */
  validateResponseFormat(response: any): {
    isValid: boolean;
    issues: string[];
    suggestedFix?: string;
  } {
    const result = {
      isValid: true,
      issues: [] as string[],
      suggestedFix: undefined as string | undefined
    };

    if (!response) {
      result.isValid = false;
      result.issues.push('Response is null or undefined');
      return result;
    }

    // Check for common response structures
    const hasDataArray = response.data && Array.isArray(response.data);
    const isDirectArray = Array.isArray(response);
    const hasImageProperties = response.url || response.b64_json || response.image_url;

    if (!hasDataArray && !isDirectArray && !hasImageProperties) {
      result.isValid = false;
      result.issues.push('Response does not contain recognizable image data structure');
      result.suggestedFix = 'Ensure response contains either data array, direct array, or image properties';
    }

    // Check for error indicators
    if (response.error) {
      result.issues.push('Response contains error information');
    }

    return result;
  }
}