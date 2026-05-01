// ModelGate API Compatibility Configuration
// Handles specific compatibility requirements for ModelGate API

import { ProviderConfig, APIProvider } from '../types';

export const MODELGATE_CONFIG: ProviderConfig = {
  id: 'modelgate',
  name: 'ModelGate',
  baseUrl: 'https://mg.aid.pub/v1',
  authType: 'bearer',
  supportedFormats: ['b64_json', 'url', 'base64'],
  pathMappings: {
    // ModelGate uses different paths for different APIs
    '/chat/completions': '/chat/completions',
    '/images/generations': '/api/v1/images/generations', // Note: different base path for images
    '/models': '/models'
  },
  customHeaders: {
    'Content-Type': 'application/json'
  },
  retryConfig: {
    maxRetries: 3,
    backoffMs: 1000,
    retryableErrors: ['network_error', 'rate_limit', 'server_error', 'timeout']
  },
  timeoutMs: 180000, // 增加到180秒，ModelGate图像生成可能需要更长时间
  rateLimits: {
    requestsPerMinute: 60,
    requestsPerHour: 1000,
    burstLimit: 10
  }
};

// ModelGate supported models (based on documentation)
export const MODELGATE_MODELS = {
  text: [
    'gpt-5-nano',
    'gpt-4o',
    'gpt-4o-mini',
    'claude-3-5-sonnet-20241022',
    'claude-sonnet-4-5-20250929',
    'claude-3-5-haiku-20241022',
    'gemini-2.0-flash-exp',
    'gemini-exp-1206',
    'gemini-exp-1121',
    'gemini-1.5-pro-002',
    'gemini-1.5-flash-002',
    'deepseek-chat',
    'deepseek-reasoner',
    'qwen-max',
    'qwen-plus',
    'qwen-turbo',
    'yi-lightning',
    'yi-large',
    'yi-medium',
    'moonshot-v1-8k',
    'moonshot-v1-32k',
    'moonshot-v1-128k',
    'glm-4-plus',
    'glm-4-0520',
    'glm-4-air',
    'glm-4-airx',
    'glm-4-flash'
  ],
  image: [
    'volcengine/doubao-seedream-4-0',
    'google/nano-banana',
    'google/nano-banana-pro'
  ],
  vision: [
    'gpt-4o',
    'gpt-4o-mini',
    'claude-3-5-sonnet-20241022',
    'gemini-2.0-flash-exp',
    'gemini-1.5-pro-002',
    'gemini-1.5-flash-002'
  ]
};

/**
 * Adapts request for ModelGate API compatibility
 */
export function adaptModelGateRequest(request: any, endpoint: string): any {
  const adapted = { ...request };

  if (endpoint.includes('/chat/completions')) {
    // ModelGate text API adaptations
    
    // Handle input field (ModelGate uses 'input' instead of 'messages' in some cases)
    if (adapted.messages) {
      // Keep messages format for chat completions - this is standard
      // No adaptation needed for standard chat completions
    }

    // Ensure model name is valid
    if (adapted.model && !MODELGATE_MODELS.text.includes(adapted.model)) {
      console.warn(`Model ${adapted.model} may not be supported by ModelGate. Consider using: ${MODELGATE_MODELS.text.slice(0, 5).join(', ')}`);
    }

    // Remove unsupported parameters
    delete adapted.response_format; // ModelGate may not support this
    delete adapted.logit_bias; // May not be supported
    delete adapted.presence_penalty; // May not be supported
    delete adapted.frequency_penalty; // May not be supported

  } else if (endpoint.includes('/images/generations')) {
    // ModelGate image API adaptations
    
    // Map standard OpenAI parameters to ModelGate format
    if (adapted.prompt) {
      // Keep prompt as is
    }
    
    if (adapted.size) {
      // ModelGate supports specific sizes, validate
      const supportedSizes = [
        '1024x1024', '2048x2048', '2304x1728', '1728x2304',
        '2560x1440', '1440x2560', '2496x1664', '1664x2496',
        '3024x1296', '1296x3024'
      ];
      
      if (!supportedSizes.includes(adapted.size)) {
        console.warn(`Size ${adapted.size} may not be supported. Using 1024x1024 as fallback.`);
        adapted.size = '1024x1024';
      }
    }

    // Map n to number_results
    if (adapted.n) {
      adapted.number_results = adapted.n;
      delete adapted.n;
    }

    // Set default output format
    if (!adapted.output_format) {
      adapted.output_format = 'png';
    }

    // Set default output type
    if (!adapted.output_type) {
      adapted.output_type = 'base64'; // Recommended for China users
    }

    // Ensure model is valid for image generation
    if (adapted.model && !MODELGATE_MODELS.image.includes(adapted.model)) {
      console.warn(`Image model ${adapted.model} may not be supported. Using volcengine/doubao-seedream-4-0 as fallback.`);
      adapted.model = 'volcengine/doubao-seedream-4-0';
    }

    // Remove unsupported OpenAI parameters
    delete adapted.quality;
    delete adapted.style;
    delete adapted.user;
  }

  return adapted;
}

/**
 * Adapts ModelGate response to standard format
 */
export function adaptModelGateResponse(response: any, endpoint: string): any {
  if (endpoint.includes('/chat/completions')) {
    // ModelGate text response is usually standard OpenAI format
    return response;
  } else if (endpoint.includes('/images/generations')) {
    // ModelGate image response adaptation
    if (response.data && Array.isArray(response.data)) {
      // Ensure each item has the expected format
      response.data = response.data.map((item: any) => ({
        url: item.url || undefined,
        b64_json: item.b64_json || undefined,
        revised_prompt: item.revised_prompt || undefined
      }));
    }
    return response;
  }
  
  return response;
}

/**
 * Gets the correct base URL for different ModelGate endpoints
 */
export function getModelGateBaseUrl(endpoint: string): string {
  if (endpoint.includes('/images/generations')) {
    return 'https://mg.aid.pub'; // Images use different base
  }
  return 'https://mg.aid.pub/v1'; // Text APIs use /v1
}

/**
 * Handles ModelGate-specific errors
 */
export function handleModelGateError(error: any, endpoint: string): string {
  const errorMessage = error?.message?.error?.message || error?.message || error?.error || 'Unknown error';
  
  // Handle timeout and abort errors specifically
  if (errorMessage.includes('aborted') || errorMessage.includes('AbortError') || errorMessage.includes('timeout')) {
    return 'Request timeout. ModelGate image generation can take up to 3 minutes. Please wait and try again, or try a simpler prompt.';
  }
  
  // Common ModelGate error patterns
  if (errorMessage.includes('model not found') || errorMessage.includes('model not supported')) {
    if (endpoint.includes('/images/generations')) {
      return `Model not supported for image generation. Try: ${MODELGATE_MODELS.image.join(', ')}`;
    } else {
      return `Model not supported for text generation. Try: ${MODELGATE_MODELS.text.slice(0, 5).join(', ')}`;
    }
  }
  
  if (errorMessage.includes('insufficient balance') || errorMessage.includes('余额不足')) {
    return 'Insufficient balance. Please top up your ModelGate account.';
  }
  
  if (errorMessage.includes('rate limit') || errorMessage.includes('too many requests')) {
    return 'Rate limit exceeded. Please wait and try again.';
  }
  
  if (errorMessage.includes('invalid api key') || errorMessage.includes('unauthorized')) {
    return 'Invalid API key. Please check your ModelGate API key.';
  }
  
  if (errorMessage.includes('500') && errorMessage.includes('This operation was aborted')) {
    return 'Request processing may have completed on server but response was interrupted. Please check if the image was generated successfully.';
  }
  
  return errorMessage;
}