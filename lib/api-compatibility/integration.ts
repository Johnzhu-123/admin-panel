// Integration layer for the API compatibility system with existing image generation API
// Validates: Requirements 所有需求

import { APICompatibilityManager } from './manager';
import { PerformanceOptimizer } from './components/performance-optimizer';
import {
  APIProvider,
  ImageGenerationRequest,
  ImageGenerationResponse,
  AuthenticationType,
  APIErrorImpl
} from './types';
import { 
  MODELGATE_CONFIG, 
  adaptModelGateRequest, 
  adaptModelGateResponse, 
  getModelGateBaseUrl,
  handleModelGateError,
  MODELGATE_MODELS
} from './providers/modelgate';
import { 
  geminiBusiness2ApiConfig, 
  isGeminiBusiness2Api 
} from './providers/gemini-business2api';

// Import image editing integration layer
import { apiIntegrationLayer } from '../image-editing/api-integration-layer';
import { 
  EditRequest, 
  EditResponse, 
  EnhancedImageRequest,
  EnhancedImageResponse 
} from '../image-editing/types';

// Global compatibility manager instance
let compatibilityManager: APICompatibilityManager | null = null;
let performanceOptimizer: PerformanceOptimizer | null = null;

/**
 * Initializes the API compatibility system
 * Should be called once during application startup
 */
export function initializeCompatibilitySystem(): void {
  if (!compatibilityManager) {
    compatibilityManager = new APICompatibilityManager();
    performanceOptimizer = new PerformanceOptimizer();
  }
}

/**
 * Gets the compatibility manager instance
 * Initializes if not already done
 */
export function getCompatibilityManager(): APICompatibilityManager {
  if (!compatibilityManager) {
    initializeCompatibilitySystem();
  }
  return compatibilityManager!;
}

/**
 * Gets the performance optimizer instance
 * Initializes if not already done
 */
export function getPerformanceOptimizer(): PerformanceOptimizer {
  if (!performanceOptimizer) {
    initializeCompatibilitySystem();
  }
  return performanceOptimizer!;
}

/**
 * Enhanced image generation with full compatibility support
 * Drop-in replacement for existing image generation logic
 * 🔧 ENHANCED: 添加userId支持用于请求队列管理
 */
export async function generateImageWithCompatibility(
  prompt: string,
  apiKey: string,
  baseUrl: string,
  options: {
    model?: string;
    size?: string;
    quality?: string;
    response_format?: string;
    n?: number;
    authType?: AuthenticationType;
    customHeaders?: Record<string, string>;
    providerId?: string;
    providerName?: string;
    userId?: string; // 🔧 NEW: 用于请求队列管理
  } = {}
): Promise<ImageGenerationResponse> {
  const manager = getCompatibilityManager();
  const optimizer = getPerformanceOptimizer();
  
  // Create provider configuration
  const provider: APIProvider = {
    id: options.providerId || generateProviderIdFromUrl(baseUrl),
    name: options.providerName || extractProviderNameFromUrl(baseUrl),
    baseUrl: baseUrl,
    apiKey: apiKey,
    authType: options.authType || 'bearer',
    customHeaders: options.customHeaders
  };

  // Create request
  const request: ImageGenerationRequest = {
    prompt: prompt,
    model: options.model,
    size: options.size,
    quality: options.quality,
    response_format: options.response_format,
    n: options.n || 1
  };

  // Check cache first
  const cachedResponse = optimizer.getCachedResponse(request, provider);
  if (cachedResponse) {
    return cachedResponse;
  }

  // Start performance tracking
  const requestId = generateRequestId();
  optimizer.startRequestTracking(requestId);

  try {
    // 🔧 NEW: 创建包含userId的请求上下文
    const context: any = {
      provider,
      request,
      startTime: new Date(),
      attemptCount: 0,
      previousErrors: [],
      userId: options.userId // 传递userId
    };
    
    // Generate image with compatibility handling
    const response = await manager.generateImage(request, provider, context);
    
    // Cache successful response
    optimizer.cacheResponse(request, provider, response);
    
    // End performance tracking
    optimizer.endRequestTracking(requestId, true);
    
    return response;
  } catch (error) {
    // End performance tracking
    optimizer.endRequestTracking(requestId, false);
    
    throw error;
  }
}

/**
 * Enhanced compatibility detection for a provider
 * Useful for setup and configuration
 */
export async function detectProviderCompatibility(
  baseUrl: string,
  apiKey: string,
  options: {
    authType?: AuthenticationType;
    customHeaders?: Record<string, string>;
    providerId?: string;
    providerName?: string;
  } = {}
) {
  const manager = getCompatibilityManager();
  
  const provider: APIProvider = {
    id: options.providerId || generateProviderIdFromUrl(baseUrl),
    name: options.providerName || extractProviderNameFromUrl(baseUrl),
    baseUrl: baseUrl,
    apiKey: apiKey,
    authType: options.authType || 'bearer',
    customHeaders: options.customHeaders
  };

  return await manager.detectCompatibility(provider);
}

/**
 * Gets error analytics for monitoring
 */
export function getErrorAnalytics() {
  const manager = getCompatibilityManager();
  return manager.getErrorAnalytics();
}

/**
 * Gets performance metrics for monitoring
 */
export function getPerformanceMetrics() {
  const optimizer = getPerformanceOptimizer();
  return optimizer.getPerformanceMetrics();
}

/**
 * Gets cache statistics for monitoring
 */
export function getCacheStatistics() {
  const optimizer = getPerformanceOptimizer();
  return optimizer.getCacheStatistics();
}

/**
 * Clears all caches (useful for testing or memory management)
 */
export function clearAllCaches(): void {
  const manager = getCompatibilityManager();
  const optimizer = getPerformanceOptimizer();
  
  manager.clearCaches();
  optimizer.clearAllCaches();
}

/**
 * Updates provider configuration
 */
export function updateProviderConfiguration(providerId: string, config: any): void {
  const manager = getCompatibilityManager();
  manager.updateProviderConfig(providerId, config);
}

/**
 * Converts existing API parameters to compatibility system format
 * Helper for migrating existing code
 */
export function convertLegacyParameters(legacyParams: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  authHeader?: string;
  customHeaders?: Record<string, string>;
}): {
  provider: APIProvider;
  authType: AuthenticationType;
} {
  const baseUrl = legacyParams.baseUrl || 'https://api.openai.com/v1';
  
  // Determine auth type from legacy authHeader
  let authType: AuthenticationType = 'bearer';
  if (legacyParams.authHeader === 'x-api-key') {
    authType = 'api_key';
  } else if (legacyParams.authHeader === 'api-key' || legacyParams.customHeaders) {
    authType = 'custom_header';
  }

  const provider: APIProvider = {
    id: generateProviderIdFromUrl(baseUrl),
    name: extractProviderNameFromUrl(baseUrl),
    baseUrl: baseUrl,
    apiKey: legacyParams.apiKey,
    authType: authType,
    customHeaders: legacyParams.customHeaders
  };

  return { provider, authType };
}

/**
 * Handles compatibility errors with user-friendly messages
 * Helper for error handling in UI
 */
export function handleCompatibilityError(error: any): {
  userMessage: string;
  technicalDetails: string;
  suggestions: string[];
  canRetry: boolean;
} {
  if (error instanceof APIErrorImpl) {
    switch (error.type) {
      case 'path_error':
        return {
          userMessage: 'API endpoint not found. The service URL may be incorrect.',
          technicalDetails: `Path error: ${error.message}`,
          suggestions: [
            'Check if the base URL is correct',
            'Verify the API service is running',
            'Try removing /v1 from the base URL if present'
          ],
          canRetry: true
        };

      case 'auth_error':
        return {
          userMessage: 'Authentication failed. Please check your API key.',
          technicalDetails: `Auth error: ${error.message}`,
          suggestions: [
            'Verify your API key is correct',
            'Check if the API key has expired',
            'Ensure you have sufficient quota/credits'
          ],
          canRetry: false
        };

      case 'content_policy':
        return {
          userMessage: 'Content was rejected by safety policies. Try a different prompt.',
          technicalDetails: `Content policy: ${error.message}`,
          suggestions: [
            'Use more general or neutral language',
            'Avoid potentially sensitive topics',
            'Try describing the image differently'
          ],
          canRetry: true
        };

      case 'rate_limit':
        return {
          userMessage: 'Rate limit exceeded. Please wait before trying again.',
          technicalDetails: `Rate limit: ${error.message}`,
          suggestions: [
            'Wait a few minutes before retrying',
            'Consider upgrading your API plan',
            'Reduce the frequency of requests'
          ],
          canRetry: true
        };

      case 'network_error':
        return {
          userMessage: 'Network connection failed. Please check your internet connection.',
          technicalDetails: `Network error: ${error.message}`,
          suggestions: [
            'Check your internet connection',
            'Verify the service is accessible',
            'Try again in a few moments'
          ],
          canRetry: true
        };

      case 'format_error':
        return {
          userMessage: 'Response format not supported. The service may be incompatible.',
          technicalDetails: `Format error: ${error.message}`,
          suggestions: [
            'Try a different response format',
            'Contact the API provider for support',
            'Use a different API service'
          ],
          canRetry: true
        };

      default:
        return {
          userMessage: 'An unexpected error occurred. Please try again.',
          technicalDetails: `Unknown error: ${error.message}`,
          suggestions: [
            'Try again in a few moments',
            'Check the service status',
            'Contact support if the problem persists'
          ],
          canRetry: true
        };
    }
  }

  // Handle non-APIError cases
  return {
    userMessage: 'An unexpected error occurred. Please try again.',
    technicalDetails: error?.message || String(error),
    suggestions: [
      'Try again in a few moments',
      'Check your internet connection',
      'Contact support if the problem persists'
    ],
    canRetry: true
  };
}

/**
 * Generates a provider ID from URL
 * Private helper function
 */
function generateProviderIdFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    // Remove common prefixes
    const cleanHostname = hostname
      .replace(/^(api\.|www\.)/, '')
      .replace(/\.(com|org|net|io|ai|co)$/, '');
    
    return cleanHostname || 'unknown-provider';
  } catch {
    return 'unknown-provider';
  }
}

/**
 * Extracts provider name from URL
 * Private helper function
 */
function extractProviderNameFromUrl(url: string): string {
  const id = generateProviderIdFromUrl(url);
  
  // Capitalize first letter
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ');
}

/**
 * Generates a unique request ID
 * Private helper function
 */
function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Enhanced OpenAI compatibility for third-party APIs
 * Specifically handles ModelGate and other providers
 */
export async function enhanceOpenAICompatibility(
  requestConfig: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: any;
  },
  context: {
    provider?: string;
    baseUrl?: string;
    operation?: string;
  }
): Promise<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}> {
  const enhanced = { ...requestConfig };
  
  // Detect if this is ModelGate
  const isModelGate = context.baseUrl?.includes('mg.aid.pub') || 
                     context.provider === 'modelgate' ||
                     enhanced.url.includes('mg.aid.pub');
  
  if (isModelGate) {
    // Apply ModelGate-specific enhancements
    
    // Fix URL for different endpoints
    if (context.operation === 'images/generations' || enhanced.url.includes('/images/generations')) {
      // ModelGate uses different base URL for images
      enhanced.url = enhanced.url.replace('https://mg.aid.pub/v1', 'https://mg.aid.pub/api/v1');
    }
    
    // Adapt request body
    if (enhanced.body) {
      enhanced.body = adaptModelGateRequest(enhanced.body, enhanced.url);
    }
    
    // Ensure proper headers
    enhanced.headers = {
      ...enhanced.headers,
      'Content-Type': 'application/json'
    };
    
    // Fix authorization header format if needed
    if (enhanced.headers.Authorization && !enhanced.headers.Authorization.startsWith('Bearer ')) {
      const apiKey = enhanced.headers.Authorization.replace(/^Bearer\s+/, '');
      enhanced.headers.Authorization = `Bearer ${apiKey}`;
    }
  }
  
  return enhanced;
}

/**
 * Process response from third-party APIs with compatibility handling
 */
export function processCompatibilityResponse(
  response: any,
  context: {
    provider?: string;
    baseUrl?: string;
    operation?: string;
  }
): any {
  // Detect if this is ModelGate
  const isModelGate = context.baseUrl?.includes('mg.aid.pub') || 
                     context.provider === 'modelgate';
  
  if (isModelGate) {
    return adaptModelGateResponse(response, context.operation || '');
  }
  
  return response;
}

/**
 * Handle errors from third-party APIs with provider-specific logic
 */
export function handleProviderError(
  error: any,
  context: {
    provider?: string;
    baseUrl?: string;
    operation?: string;
  }
): string {
  // Detect if this is ModelGate
  const isModelGate = context.baseUrl?.includes('mg.aid.pub') || 
                     context.provider === 'modelgate';
  
  if (isModelGate) {
    return handleModelGateError(error, context.operation || '');
  }
  
  // Generic error handling for other providers
  const errorMessage = error?.message?.error?.message || 
                      error?.message || 
                      error?.error || 
                      'Unknown error';
  
  return errorMessage;
}

/**
 * Get recommended models for a provider
 */
export function getRecommendedModels(
  context: {
    provider?: string;
    baseUrl?: string;
    type?: 'text' | 'image' | 'vision';
  }
): string[] {
  // Detect if this is ModelGate
  const isModelGate = context.baseUrl?.includes('mg.aid.pub') || 
                     context.provider === 'modelgate';
  
  if (isModelGate) {
    switch (context.type) {
      case 'text':
        return MODELGATE_MODELS.text.slice(0, 10); // Return top 10
      case 'image':
        return MODELGATE_MODELS.image;
      case 'vision':
        return MODELGATE_MODELS.vision.slice(0, 5);
      default:
        return MODELGATE_MODELS.text.slice(0, 5);
    }
  }
  
  // Default recommendations for unknown providers
  return [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-3.5-turbo',
    'claude-3-5-sonnet-20241022',
    'gemini-1.5-flash'
  ];
}
/**
 * Enhanced image editing with full compatibility support
 * Integrates editing capabilities with existing API compatibility system
 */
export async function editImageWithCompatibility(
  editRequest: EditRequest,
  options: {
    authType?: AuthenticationType;
    customHeaders?: Record<string, string>;
    providerId?: string;
    providerName?: string;
  } = {}
): Promise<EditResponse> {
  const manager = getCompatibilityManager();
  const optimizer = getPerformanceOptimizer();
  
  // Create provider configuration from edit request
  const provider: APIProvider = {
    id: options.providerId || editRequest.provider || 'openai',
    name: options.providerName || (editRequest.provider || 'OpenAI'),
    baseUrl: getProviderBaseUrl(editRequest.provider || 'openai'),
    apiKey: getProviderApiKey(editRequest.provider || 'openai'),
    authType: options.authType || 'bearer',
    customHeaders: options.customHeaders
  };

  // Check cache first (for editing, we might want to cache based on image + regions hash)
  const cacheKey = generateEditCacheKey(editRequest);
  const cachedResponse = optimizer.getCachedEditResponse(cacheKey);
  if (cachedResponse) {
    return cachedResponse;
  }

  // Start performance tracking
  const requestId = generateRequestId();
  optimizer.startRequestTracking(requestId);

  try {
    // Process edit request with compatibility handling
    const response = await apiIntegrationLayer.processEditRequest(editRequest);
    
    // Cache successful response
    optimizer.cacheEditResponse(cacheKey, response);
    
    // End performance tracking
    optimizer.endRequestTracking(requestId, true);
    
    return response;
  } catch (error) {
    // End performance tracking
    optimizer.endRequestTracking(requestId, false);
    
    // Handle editing-specific errors with compatibility system
    const compatibilityError = handleEditingCompatibilityError(error, provider, editRequest);
    throw compatibilityError;
  }
}

/**
 * Enhanced image request processing (both generation and editing)
 * Unified entry point for all image operations
 */
export async function processEnhancedImageRequest(
  request: EnhancedImageRequest,
  options: {
    authType?: AuthenticationType;
    customHeaders?: Record<string, string>;
    providerId?: string;
    providerName?: string;
  } = {}
): Promise<EnhancedImageResponse> {
  // Determine if this is an editing or generation request
  const isEditing = apiIntegrationLayer.isEditingRequest(request);
  
  if (isEditing) {
    // Handle as editing request
    const editRequest = convertEnhancedToEditRequest(request);
    const editResponse = await editImageWithCompatibility(editRequest, options);
    return convertEditToEnhancedResponse(editResponse);
  } else {
    // Handle as generation request using existing compatibility system
    const generationResponse = await generateImageWithCompatibility(
      request.prompt || '',
      getProviderApiKey(request.model || 'openai'),
      getProviderBaseUrl(request.model || 'openai'),
      {
        model: request.model,
        size: request.size,
        quality: request.quality,
        response_format: request.response_format,
        n: (request as any).n,
        ...options
      }
    );
    
    return convertGenerationToEnhancedResponse(generationResponse);
  }
}

/**
 * Detects editing compatibility for a provider
 * Extends existing compatibility detection with editing-specific checks
 */
export async function detectEditingCompatibility(
  baseUrl: string,
  apiKey: string,
  options: {
    authType?: AuthenticationType;
    customHeaders?: Record<string, string>;
    providerId?: string;
    providerName?: string;
  } = {}
) {
  // First get basic compatibility
  const basicCompatibility = await detectProviderCompatibility(baseUrl, apiKey, options);
  
  // Add editing-specific compatibility checks
  const provider: APIProvider = {
    id: options.providerId || generateProviderIdFromUrl(baseUrl),
    name: options.providerName || extractProviderNameFromUrl(baseUrl),
    baseUrl: baseUrl,
    apiKey: apiKey,
    authType: options.authType || 'bearer',
    customHeaders: options.customHeaders
  };

  // Check editing capabilities
  const editingCapabilities = await detectProviderEditingCapabilities(provider);
  
  return {
    ...basicCompatibility,
    editing: editingCapabilities
  };
}

/**
 * Handles editing-specific compatibility errors
 */
function handleEditingCompatibilityError(
  error: any,
  provider: APIProvider,
  request: EditRequest
): any {
  // First try standard compatibility error handling
  const standardError = handleCompatibilityError(error);
  
  // Add editing-specific error handling
  if (error?.code === 'MISSING_ORIGINAL_IMAGE') {
    return {
      ...standardError,
      userMessage: 'Original image is required for editing operations.',
      suggestions: [
        'Provide a base64-encoded original image',
        'Ensure the image is in a supported format (PNG, JPEG, WebP)',
        'Check that the image data is not corrupted'
      ]
    };
  }
  
  if (error?.code === 'MISSING_EDIT_REGIONS') {
    return {
      ...standardError,
      userMessage: 'At least one edit region must be specified.',
      suggestions: [
        'Create selection masks using the canvas tools',
        'Provide edit instructions for each region',
        'Ensure masks have valid coordinates'
      ]
    };
  }
  
  if (error?.code === 'INVALID_MASK') {
    return {
      ...standardError,
      userMessage: 'One or more selection masks are invalid.',
      suggestions: [
        'Recreate masks using the canvas tools',
        'Ensure masks have valid coordinates and bounds',
        'Check that mask data is properly formatted'
      ]
    };
  }
  
  if (error?.code === 'PROVIDER_NO_EDITING_SUPPORT') {
    return {
      ...standardError,
      userMessage: 'This provider does not support image editing.',
      suggestions: [
        'Try with OpenAI provider for native editing support',
        'Use generation mode instead of editing',
        'Consider using a different provider'
      ]
    };
  }
  
  return standardError;
}

/**
 * Detects provider-specific editing capabilities
 */
async function detectProviderEditingCapabilities(provider: APIProvider) {
  try {
    // Test basic editing endpoint availability
    const testUrl = `${provider.baseUrl}/images/edits`;
    
    // Make a test request (without actual image data)
    const testResponse = await fetch(testUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // Minimal test payload
        prompt: 'test'
      })
    });
    
    // Analyze response to determine capabilities
    const supportsNativeEditing = testResponse.status !== 404;
    const supportsBatchEditing = false; // Most providers don't support this yet
    const supportsHighFidelity = provider.id === 'openai'; // OpenAI specific
    
    return {
      supportsNativeEditing,
      supportsBatchEditing,
      supportsHighFidelity,
      supportedMaskFormats: supportsNativeEditing ? ['png', 'base64'] : ['base64'],
      maxImageSize: {
        width: provider.id === 'openai' ? 1024 : 2048,
        height: provider.id === 'openai' ? 1024 : 2048
      }
    };
  } catch (error) {
    // Return conservative capabilities on detection failure
    return {
      supportsNativeEditing: false,
      supportsBatchEditing: false,
      supportsHighFidelity: false,
      supportedMaskFormats: ['base64'],
      maxImageSize: { width: 1024, height: 1024 }
    };
  }
}

/**
 * Helper functions for editing integration
 */
function generateEditCacheKey(request: EditRequest): string {
  // Create a hash-like key from image and regions
  const imageHash = request.originalImage.substring(0, 32);
  const regionsHash = request.regions.map(r => r.mask.id + r.instruction).join('|');
  return `edit-${imageHash}-${regionsHash.substring(0, 32)}`;
}

function getProviderBaseUrl(provider: string): string {
  const urls: Record<string, string> = {
    'openai': 'https://api.openai.com/v1',
    'gemini': 'https://generativelanguage.googleapis.com/v1',
    'modelgate': 'https://mg.aid.pub/api/v1'
  };
  return urls[provider] || urls['openai'];
}

function getProviderApiKey(provider: string): string {
  const keys: Record<string, string> = {
    'openai': process.env.OPENAI_API_KEY || '',
    'gemini': process.env.GEMINI_API_KEY || '',
    'modelgate': process.env.MODELGATE_API_KEY || ''
  };
  return keys[provider] || keys['openai'];
}

function convertEnhancedToEditRequest(request: EnhancedImageRequest): EditRequest {
  const regions = (request.masks || []).map((mask, index) => ({
    mask,
    instruction: request.editInstructions?.[index] || 'Edit this region',
    priority: 1,
    stylePreservation: request.stylePreservation || false
  }));

  return {
    originalImage: request.originalImage || '',
    regions,
    globalOptions: {
      highFidelity: request.highFidelity || false,
      stylePreservation: request.stylePreservation || false,
      qualityLevel: request.quality === 'hd' ? 'high' : 'standard'
    },
    provider: request.model
  };
}

function convertEditToEnhancedResponse(editResponse: EditResponse): EnhancedImageResponse {
  return {
    editedImage: editResponse.editedImage,
    regions: editResponse.regions,
    metadata: {
      ...editResponse.metadata,
      editingMode: 'edit' as const
    }
  };
}

function convertGenerationToEnhancedResponse(generationResponse: ImageGenerationResponse): EnhancedImageResponse {
  return {
    url: generationResponse.images?.[0]?.url,
    b64_json: generationResponse.images?.[0]?.b64_json,
    revised_prompt: generationResponse.images?.[0]?.revised_prompt,
    metadata: {
      processingTime: 0,
      provider: 'unknown',
      fallbackUsed: false,
      editingMode: 'generate' as const
    }
  };
}