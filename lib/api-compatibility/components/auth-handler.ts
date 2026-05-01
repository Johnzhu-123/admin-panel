// Authentication handling component for third-party API compatibility

import { AuthenticationHandler as IAuthenticationHandler } from '../interfaces';
import { 
  HTTPRequest, 
  APIProvider, 
  AuthenticationType 
} from '../types';

export class AuthenticationHandler implements IAuthenticationHandler {
  /**
   * Applies authentication to HTTP request based on provider configuration
   * Validates: Requirements 4.1, 4.2, 4.3, 4.4
   */
  applyAuthentication(request: HTTPRequest, provider: APIProvider): HTTPRequest {
    if (!request || !provider) {
      throw new Error('Request and provider are required');
    }

    if (!provider.apiKey || typeof provider.apiKey !== 'string') {
      throw new Error('API key is required and must be a string');
    }

    const authenticatedRequest: HTTPRequest = {
      ...request,
      headers: { ...request.headers }
    };

    switch (provider.authType) {
      case 'bearer':
        authenticatedRequest.headers['Authorization'] = `Bearer ${provider.apiKey}`;
        break;

      case 'api_key':
        authenticatedRequest.headers['X-API-Key'] = provider.apiKey;
        break;

      case 'custom_header':
        // Apply custom headers from provider configuration
        if (provider.customHeaders) {
          Object.entries(provider.customHeaders).forEach(([key, value]) => {
            // Replace placeholder with actual API key (safe string replacement)
            const processedValue = typeof value === 'string' && value.includes('{API_KEY}') 
              ? value.split('{API_KEY}').join(provider.apiKey)
              : value;
            authenticatedRequest.headers[key] = processedValue;
          });
        } else {
          // Fallback to common custom header patterns
          authenticatedRequest.headers['api-key'] = provider.apiKey;
        }
        break;

      default:
        throw new Error(`Unsupported authentication type: ${provider.authType}`);
    }

    // Always add Content-Type for JSON requests
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
      if (!authenticatedRequest.headers['Content-Type']) {
        authenticatedRequest.headers['Content-Type'] = 'application/json';
      }
    }

    return authenticatedRequest;
  }

  /**
   * Detects the authentication type by testing different methods
   * Validates: Requirements 4.4
   */
  async detectAuthType(provider: APIProvider): Promise<AuthenticationType> {
    if (!provider || !provider.baseUrl || !provider.apiKey) {
      throw new Error('Provider with baseUrl and apiKey is required');
    }

    // Test different authentication methods in order of preference
    const authMethods: AuthenticationType[] = ['bearer', 'api_key', 'custom_header'];
    
    for (const authType of authMethods) {
      try {
        const testProvider = { ...provider, authType };
        const isValid = await this.validateAuthentication(testProvider);
        if (isValid) {
          return authType;
        }
      } catch (error) {
        // Continue to next auth method
        continue;
      }
    }

    // Default to bearer token if detection fails
    return 'bearer';
  }

  /**
   * Validates authentication by making a test request
   * Validates: Requirements 4.1, 4.2, 4.3
   */
  async validateAuthentication(provider: APIProvider): Promise<boolean> {
    if (!provider || !provider.baseUrl || !provider.apiKey) {
      return false;
    }

    try {
      // Create a test request to a common endpoint
      const testRequest: HTTPRequest = {
        url: `${provider.baseUrl}/models`,
        method: 'GET',
        headers: {}
      };

      const authenticatedRequest = this.applyAuthentication(testRequest, provider);
      
      // Make the actual HTTP request
      const response = await fetch(authenticatedRequest.url, {
        method: authenticatedRequest.method,
        headers: authenticatedRequest.headers,
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      // Consider authentication valid if we don't get 401/403
      return response.status !== 401 && response.status !== 403;
    } catch (error) {
      // Network errors or timeouts don't necessarily mean auth is invalid
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('timeout') || message.includes('network') || message.includes('fetch')) {
          // Assume auth is valid if we can't test due to network issues
          return true;
        }
      }
      return false;
    }
  }

  /**
   * Gets common authentication patterns for known providers
   * Helper method for auto-configuration
   */
  getKnownProviderAuthPattern(providerName: string): Partial<APIProvider> {
    if (!providerName || typeof providerName !== 'string') {
      return { authType: 'bearer', customHeaders: {} };
    }

    const patterns: Record<string, Partial<APIProvider>> = {
      'openai': {
        authType: 'bearer',
        customHeaders: {}
      },
      'anthropic': {
        authType: 'custom_header',
        customHeaders: {
          'x-api-key': '{API_KEY}',
          'anthropic-version': '2023-06-01'
        }
      },
      'cohere': {
        authType: 'bearer',
        customHeaders: {}
      },
      'huggingface': {
        authType: 'bearer',
        customHeaders: {}
      },
      'replicate': {
        authType: 'bearer',
        customHeaders: {}
      },
      'together': {
        authType: 'bearer',
        customHeaders: {}
      },
      'groq': {
        authType: 'bearer',
        customHeaders: {}
      },
      'perplexity': {
        authType: 'bearer',
        customHeaders: {}
      },
      'mistral': {
        authType: 'bearer',
        customHeaders: {}
      }
    };

    const normalizedName = providerName.toLowerCase().trim();
    
    // Handle edge cases and reserved words
    if (normalizedName.length === 0 || 
        ['constructor', 'prototype', '__proto__', 'toString', 'valueOf'].includes(normalizedName)) {
      return { authType: 'bearer', customHeaders: {} };
    }

    return patterns[normalizedName] || { authType: 'bearer', customHeaders: {} };
  }

  /**
   * Applies multiple authentication methods for maximum compatibility
   * Some providers accept multiple auth headers
   */
  applyMultipleAuthMethods(request: HTTPRequest, provider: APIProvider): HTTPRequest {
    const authenticatedRequest: HTTPRequest = {
      ...request,
      headers: { ...request.headers }
    };

    if (!provider.apiKey) {
      return authenticatedRequest;
    }

    // Apply all common authentication methods
    authenticatedRequest.headers['Authorization'] = `Bearer ${provider.apiKey}`;
    authenticatedRequest.headers['X-API-Key'] = provider.apiKey;
    authenticatedRequest.headers['api-key'] = provider.apiKey;

    // Apply custom headers if provided
    if (provider.customHeaders) {
      Object.entries(provider.customHeaders).forEach(([key, value]) => {
        const processedValue = typeof value === 'string' && value.includes('{API_KEY}') 
          ? value.split('{API_KEY}').join(provider.apiKey)
          : value;
        authenticatedRequest.headers[key] = processedValue;
      });
    }

    // Always add Content-Type for JSON requests
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
      if (!authenticatedRequest.headers['Content-Type']) {
        authenticatedRequest.headers['Content-Type'] = 'application/json';
      }
    }

    return authenticatedRequest;
  }

  /**
   * Extracts authentication error details from response
   * Helper method for error analysis
   */
  extractAuthError(response: Response, responseBody?: string): {
    isAuthError: boolean;
    errorType: 'invalid_key' | 'expired_key' | 'insufficient_quota' | 'rate_limit' | 'unknown';
    message: string;
  } {
    const status = response.status;
    const body = responseBody || '';
    const bodyLower = body.toLowerCase();

    if (status === 401) {
      if (bodyLower.includes('invalid') && bodyLower.includes('key')) {
        return { isAuthError: true, errorType: 'invalid_key', message: 'Invalid API key' };
      }
      if (bodyLower.includes('expired')) {
        return { isAuthError: true, errorType: 'expired_key', message: 'API key has expired' };
      }
      return { isAuthError: true, errorType: 'unknown', message: 'Authentication failed' };
    }

    if (status === 403) {
      if (bodyLower.includes('quota') || bodyLower.includes('billing')) {
        return { isAuthError: true, errorType: 'insufficient_quota', message: 'Insufficient quota or billing issue' };
      }
      return { isAuthError: true, errorType: 'unknown', message: 'Access forbidden' };
    }

    if (status === 429) {
      return { isAuthError: true, errorType: 'rate_limit', message: 'Rate limit exceeded' };
    }

    return { isAuthError: false, errorType: 'unknown', message: '' };
  }
}