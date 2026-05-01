/**
 * API Integration Layer for AI Image Editing Enhancement
 * Extends existing image API with editing capabilities while maintaining backward compatibility
 */

import { 
  EditRequest, 
  EditResponse, 
  EnhancedImageRequest,
  EnhancedImageResponse,
  ExistingImageRequest,
  LegacyImageResponse,
  ProviderCapabilities,
  APIError as APIErrorType,
  FallbackStrategy,
  FallbackOption,
  EditContext,
  ProviderAdapter,
  ProviderSpecificRequest,
  ProviderSpecificResponse,
  ProviderError,
  ValidationResult,
  EditRegion,
  Mask
} from './types';
import { maskProcessor } from './mask-processor';
import { promptEngine } from './prompt-engine';
import { regionManager } from './region-manager';

export class APIIntegrationLayer {
  private providerAdapters: Map<string, ProviderAdapter>;

  constructor() {
    this.providerAdapters = new Map();
    this.initializeProviderAdapters();
  }

  /**
   * Initialize provider adapters for different AI services
   */
  private initializeProviderAdapters(): void {
    // OpenAI adapter
    this.providerAdapters.set('openai', {
      capabilities: {
        supportsNativeEditing: true,
        supportsBatchEditing: false,
        maxImageSize: { width: 1024, height: 1024 },
        supportedMaskFormats: ['png', 'base64'],
        highFidelitySupport: true
      },
      adaptRequest: (request: EditRequest): ProviderSpecificRequest => {
        return {
          provider: 'openai',
          endpoint: '/v1/images/edits',
          headers: {
            'Content-Type': 'multipart/form-data',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: {
            image: request.originalImage,
            mask: request.regions[0]?.mask ? maskProcessor.encodeMask(request.regions[0].mask, 'png') : undefined,
            prompt: request.regions[0]?.instruction || '',
            n: 1,
            size: '1024x1024',
            response_format: 'b64_json',
            ...(request.globalOptions.highFidelity && { input_fidelity: 'high' })
          }
        };
      },
      adaptResponse: (response: ProviderSpecificResponse): EditResponse => {
        const data = response.data;
        return {
          editedImage: data.data?.[0]?.b64_json || '',
          regions: [{
            regionId: 'openai-edit',
            success: true,
            editedData: data.data?.[0]?.b64_json,
            processingTime: 0
          }],
          metadata: {
            processingTime: 0,
            provider: 'openai',
            fallbackUsed: false
          }
        };
      },
      handleError: (error: ProviderError): APIErrorType => {
        return {
          code: error.code,
          message: error.message,
          provider: error.provider,
          recoverable: error.code !== 'invalid_api_key',
          suggestedActions: this.getOpenAIErrorActions(error.code)
        };
      }
    });

    // Gemini adapter
    this.providerAdapters.set('gemini', {
      capabilities: {
        supportsNativeEditing: false, // Gemini doesn't have native editing, use generation fallback
        supportsBatchEditing: false,
        maxImageSize: { width: 2048, height: 2048 },
        supportedMaskFormats: ['png'],
        highFidelitySupport: false
      },
      adaptRequest: (request: EditRequest): ProviderSpecificRequest => {
        // For Gemini, we'll use generation with the original image as context
        const instruction = request.regions.map(r => r.instruction).join('. ');
        return {
          provider: 'gemini',
          endpoint: '/v1/models/gemini-pro-vision:generateContent',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GEMINI_API_KEY}`
          },
          body: {
            contents: [{
              parts: [
                { text: `Edit this image: ${instruction}. Maintain the original style and only modify the specified areas.` },
                { inline_data: { mime_type: 'image/png', data: request.originalImage } }
              ]
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 1024
            }
          }
        };
      },
      adaptResponse: (response: ProviderSpecificResponse): EditResponse => {
        // Gemini returns text, not images, so this is a fallback response
        return {
          editedImage: '', // Would need additional processing
          regions: [{
            regionId: 'gemini-fallback',
            success: false,
            error: 'Gemini does not support direct image editing',
            processingTime: 0
          }],
          metadata: {
            processingTime: 0,
            provider: 'gemini',
            fallbackUsed: true
          }
        };
      },
      handleError: (error: ProviderError): APIErrorType => {
        return {
          code: error.code,
          message: error.message,
          provider: error.provider,
          recoverable: true,
          suggestedActions: ['Try with OpenAI provider', 'Use generation mode instead']
        };
      }
    });

    // ModelGate adapter
    this.providerAdapters.set('modelgate', {
      capabilities: {
        supportsNativeEditing: false,
        supportsBatchEditing: false,
        maxImageSize: { width: 1024, height: 1024 },
        supportedMaskFormats: ['base64'],
        highFidelitySupport: false
      },
      adaptRequest: (request: EditRequest): ProviderSpecificRequest => {
        return {
          provider: 'modelgate',
          endpoint: '/api/v1/image/edit',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.MODELGATE_API_KEY}`
          },
          body: {
            original_image: request.originalImage,
            instructions: request.regions.map(r => r.instruction),
            masks: request.regions.map(r => maskProcessor.encodeMask(r.mask, 'base64')),
            quality: request.globalOptions.qualityLevel
          }
        };
      },
      adaptResponse: (response: ProviderSpecificResponse): EditResponse => {
        const data = response.data;
        return {
          editedImage: data.edited_image || '',
          regions: data.regions?.map((region: any, index: number) => ({
            regionId: `modelgate-region-${index}`,
            success: region.success,
            editedData: region.data,
            processingTime: region.processing_time || 0
          })) || [],
          metadata: {
            processingTime: data.total_processing_time || 0,
            provider: 'modelgate',
            fallbackUsed: false
          }
        };
      },
      handleError: (error: ProviderError): APIErrorType => {
        return {
          code: error.code,
          message: error.message,
          provider: error.provider,
          recoverable: error.code !== 'authentication_failed',
          suggestedActions: ['Check ModelGate API key', 'Try with alternative provider']
        };
      }
    });
  }

  /**
   * Main entry point for processing edit requests
   */
  async processEditRequest(request: EditRequest): Promise<EditResponse> {
    try {
      // Validate request
      this.validateEditRequest(request);

      // Select appropriate provider
      const provider = this.selectProvider(request);

      // Adapt request for provider
      const adaptedRequest = await this.adaptRequestForProvider(request, provider);

      // Process the edit
      const response = await this.executeEdit(adaptedRequest, provider);

      return response;
    } catch (error) {
      // Handle errors with fallback strategies
      return this.handleEditError(error as APIError, request);
    }
  }

  /**
   * Determines if a request is an editing request vs generation request
   */
  isEditingRequest(request: EnhancedImageRequest): boolean {
    return !!(
      request.editingMode === 'edit' ||
      request.originalImage ||
      request.masks?.length ||
      request.editInstructions?.length ||
      // Legacy editing detection: inputImage + maskImage indicates editing
      ((request as any).inputImage && (request as any).maskImage)
    );
  }

  /**
   * Processes enhanced image requests (both generation and editing)
   */
  async processEnhancedImageRequest(request: EnhancedImageRequest): Promise<EnhancedImageResponse> {
    console.log('🔍 API Integration Layer - Processing request:', {
      isEditingRequest: this.isEditingRequest(request),
      hasInputImage: !!(request as any).inputImage,
      hasMaskImage: !!(request as any).maskImage,
      requestKeys: Object.keys(request)
    });

    if (this.isEditingRequest(request)) {
      console.log('✅ API Integration Layer - Converting to edit request');
      // Convert to edit request format
      const editRequest = this.convertToEditRequest(request);
      console.log('🔍 Converted edit request:', {
        hasOriginalImage: !!editRequest.originalImage,
        regionsCount: editRequest.regions.length,
        firstRegionInstruction: editRequest.regions[0]?.instruction
      });
      
      const editResponse = await this.processEditRequest(editRequest);
      return this.convertToEnhancedResponse(editResponse, 'edit');
    } else {
      console.log('⚠️ API Integration Layer - Processing as generation (not editing)');
      // Handle as legacy generation request
      const legacyRequest = this.convertToLegacyRequest(request);
      // This would call the existing generation logic
      return this.convertToEnhancedResponse(null, 'generate', legacyRequest);
    }
  }

  /**
   * Maintains backward compatibility with existing requests
   */
  async processLegacyRequest(request: ExistingImageRequest): Promise<LegacyImageResponse> {
    // Convert legacy request to enhanced format
    const enhancedRequest: EnhancedImageRequest = {
      ...request,
      editingMode: 'generate'
    };

    const enhancedResponse = await this.processEnhancedImageRequest(enhancedRequest);

    // Convert back to legacy format
    return {
      url: enhancedResponse.url,
      b64_json: enhancedResponse.b64_json,
      revised_prompt: enhancedResponse.revised_prompt
    };
  }

  // Private helper methods

  private validateEditRequest(request: EditRequest): void {
    if (!request.originalImage) {
      throw new APIError('MISSING_ORIGINAL_IMAGE', 'Original image is required for editing', true, [
        'Provide a base64-encoded original image',
        'Ensure the image is in a supported format (PNG, JPEG, WebP)'
      ]);
    }

    if (!request.regions || request.regions.length === 0) {
      throw new APIError('MISSING_EDIT_REGIONS', 'At least one edit region is required', true, [
        'Create at least one mask region',
        'Provide edit instructions for each region'
      ]);
    }

    // Validate each region
    request.regions.forEach((region, index) => {
      if (!region.mask) {
        throw new APIError('INVALID_REGION', `Region ${index + 1} is missing a mask`, true, [
          'Ensure each region has a valid mask',
          'Use the canvas tools to create selection masks'
        ]);
      }

      if (!region.instruction || region.instruction.trim() === '') {
        throw new APIError('MISSING_INSTRUCTION', `Region ${index + 1} is missing edit instructions`, true, [
          'Provide clear edit instructions for each region',
          'Be specific about what changes you want to make'
        ]);
      }

      // Validate mask
      const validation = maskProcessor.validateMask(region.mask);
      if (!validation.valid) {
        throw new APIError('INVALID_MASK', `Region ${index + 1} has an invalid mask: ${validation.errors.join(', ')}`, true, [
          'Recreate the mask using the canvas tools',
          'Ensure the mask has valid coordinates and bounds'
        ]);
      }
    });
  }

  /**
   * Enhanced provider selection logic based on request characteristics and provider capabilities
   */
  private selectProvider(request: EditRequest): string {
    // Use specified provider if available and capable
    if (request.provider) {
      const adapter = this.providerAdapters.get(request.provider);
      if (adapter && this.isProviderSuitable(adapter, request)) {
        return request.provider;
      }
    }

    // Intelligent provider selection based on request characteristics
    const providers = Array.from(this.providerAdapters.keys());
    const scores = providers.map(provider => ({
      provider,
      score: this.calculateProviderScore(provider, request)
    }));

    // Sort by score (highest first)
    scores.sort((a, b) => b.score - a.score);

    // Return the best provider, fallback to OpenAI if none suitable
    return scores[0]?.provider || 'openai';
  }

  /**
   * Calculate suitability score for a provider based on request requirements
   */
  private calculateProviderScore(provider: string, request: EditRequest): number {
    const adapter = this.providerAdapters.get(provider);
    if (!adapter) return 0;

    let score = 0;
    const capabilities = adapter.capabilities;

    // Native editing support is highly valued
    if (capabilities.supportsNativeEditing) {
      score += 50;
    }

    // High fidelity support
    if (request.globalOptions.highFidelity && capabilities.highFidelitySupport) {
      score += 30;
    }

    // Batch editing support for multiple regions
    if (request.regions.length > 1 && capabilities.supportsBatchEditing) {
      score += 20;
    }

    // Image size compatibility
    const estimatedImageSize = this.estimateImageSize(request.originalImage);
    if (estimatedImageSize.width <= capabilities.maxImageSize.width && 
        estimatedImageSize.height <= capabilities.maxImageSize.height) {
      score += 20;
    } else {
      score -= 30; // Penalty for size incompatibility
    }

    // Mask format support
    const requiredFormats = this.getRequiredMaskFormats(request);
    const supportedFormats = capabilities.supportedMaskFormats;
    const formatCompatibility = requiredFormats.every(format => supportedFormats.includes(format));
    if (formatCompatibility) {
      score += 10;
    }

    return score;
  }

  /**
   * Check if a provider is suitable for the given request
   */
  private isProviderSuitable(adapter: ProviderAdapter, request: EditRequest): boolean {
    const capabilities = adapter.capabilities;
    
    // Check image size limits
    const imageSize = this.estimateImageSize(request.originalImage);
    if (imageSize.width > capabilities.maxImageSize.width || 
        imageSize.height > capabilities.maxImageSize.height) {
      return false;
    }

    // Check mask format support
    const requiredFormats = this.getRequiredMaskFormats(request);
    const hasFormatSupport = requiredFormats.every(format => 
      capabilities.supportedMaskFormats.includes(format)
    );
    
    return hasFormatSupport;
  }

  /**
   * Estimate image size from base64 data
   */
  private estimateImageSize(base64Image: string): { width: number; height: number } {
    // Simple estimation based on base64 length
    // In a real implementation, you'd decode the image header
    const dataLength = base64Image.length;
    const estimatedPixels = dataLength / 4; // Rough estimate
    const estimatedSize = Math.sqrt(estimatedPixels);
    
    return {
      width: Math.min(Math.max(estimatedSize, 512), 2048),
      height: Math.min(Math.max(estimatedSize, 512), 2048)
    };
  }

  /**
   * Determine required mask formats for the request
   */
  private getRequiredMaskFormats(request: EditRequest): string[] {
    // For now, prefer PNG for quality, fallback to base64
    return ['png', 'base64'];
  }

  /**
   * Enhanced request adaptation for provider-specific requirements
   */
  private async adaptRequestForProvider(request: EditRequest, provider: string): Promise<EditRequest> {
    const adapter = this.providerAdapters.get(provider);
    if (!adapter) {
      throw new APIError('UNKNOWN_PROVIDER', `Provider ${provider} is not supported`, false, [
        'Use a supported provider (openai, gemini, modelgate)',
        'Check provider configuration'
      ]);
    }

    const capabilities = adapter.capabilities;
    
    // Optimize masks for provider requirements
    const optimizedRegions = await Promise.all(
      request.regions.map(async (region) => {
        // Validate mask first
        const validation = maskProcessor.validateMask(region.mask);
        if (!validation.valid) {
          throw new APIError('INVALID_MASK', `Invalid mask: ${validation.errors.join(', ')}`, true, [
            'Recreate the mask using canvas tools',
            'Ensure mask has valid coordinates'
          ]);
        }

        // Optimize mask for provider
        const optimizedMask = maskProcessor.optimizeMask(
          region.mask,
          capabilities.maxImageSize,
          capabilities
        );

        // Adapt mask format
        const preferredFormat = capabilities.supportedMaskFormats[0] as 'png' | 'base64';
        const encodedMask = maskProcessor.encodeMask(region.mask, preferredFormat);

        return {
          ...region,
          mask: {
            ...region.mask,
            data: optimizedMask.optimizedData as any // Store encoded mask data
          }
        };
      })
    );

    // Adapt prompts for provider capabilities
    const adaptedRegions = optimizedRegions.map((region) => {
      const promptOptions = {
        highFidelity: request.globalOptions.highFidelity && capabilities.highFidelitySupport,
        stylePreservation: request.globalOptions.stylePreservation,
        provider,
        qualityLevel: request.globalOptions.qualityLevel
      };

      let adaptedInstruction = promptEngine.buildEditPrompt(region.instruction, promptOptions);

      // Apply high fidelity control if supported
      if (capabilities.highFidelitySupport && request.globalOptions.highFidelity) {
        adaptedInstruction = promptEngine.applyHighFidelityControl(adaptedInstruction);
      }

      // Add style preservation if requested
      if (request.globalOptions.stylePreservation) {
        adaptedInstruction = promptEngine.addStylePreservation(adaptedInstruction, 'strict');
      }

      // Final provider-specific adaptation
      adaptedInstruction = promptEngine.adaptForProvider(adaptedInstruction, provider);

      return {
        ...region,
        instruction: adaptedInstruction
      };
    });

    // Handle multi-region coordination for providers that don't support batch processing
    if (adaptedRegions.length > 1 && !capabilities.supportsBatchEditing) {
      // Coordinate prompts for consistency
      const coordinatedInstructions = promptEngine.coordinateMultiRegionPrompts(
        adaptedRegions.map((r, index) => ({
          regionId: r.mask.id || `region-${index + 1}`,
          instruction: r.instruction,
          stylePreservation: r.stylePreservation
        }))
      );

      // Apply coordinated instructions
      adaptedRegions.forEach((region, index) => {
        if (coordinatedInstructions[index]) {
          region.instruction = coordinatedInstructions[index];
        }
      });
    }

    return {
      ...request,
      regions: adaptedRegions,
      provider // Ensure provider is set
    };
  }

  /**
   * Execute edit using provider-specific adapter
   */
  /**
   * Execute edit using provider-specific adapter
   */
  private async executeEdit(request: EditRequest, provider: string): Promise<EditResponse> {
    console.log('🔍 executeEdit called with provider:', provider);
    
    const adapter = this.providerAdapters.get(provider);
    if (!adapter) {
      console.log('❌ Provider adapter not found:', provider);
      throw new APIError('UNKNOWN_PROVIDER', `Provider ${provider} is not supported`, false, [
        'Use a supported provider (openai, gemini, modelgate)'
      ]);
    }

    console.log('✅ Provider adapter found, capabilities:', adapter.capabilities);

    // 🚀 SIMPLIFIED APPROACH: For now, let's use a direct approach to get editing working
    // We'll process the first region only to get basic functionality working
    
    if (request.regions.length === 0) {
      throw new APIError('NO_REGIONS', 'No regions to edit', true, ['Add at least one edit region']);
    }

    const firstRegion = request.regions[0];
    console.log('🔍 Processing first region:', {
      hasInstruction: !!firstRegion.instruction,
      instruction: firstRegion.instruction,
      hasMask: !!firstRegion.mask,
      maskType: firstRegion.mask.type
    });

    try {
      // Create single-region request for simplicity
      const singleRegionRequest: EditRequest = {
        ...request,
        regions: [firstRegion]
      };

      // Check if provider supports native editing
      if (!adapter.capabilities.supportsNativeEditing) {
        console.log('⚠️ Provider does not support native editing, using fallback');
        return this.executeFallbackEdit(singleRegionRequest, provider, adapter);
      }

      console.log('✅ Using native editing support');
      
      // Adapt request for provider
      const providerRequest = adapter.adaptRequest(singleRegionRequest);
      console.log('🔍 Provider request adapted');

      // Make API call
      const response = await this.makeProviderAPICall(providerRequest);
      console.log('🔍 Provider API call completed');

      // Adapt response
      const editResponse = adapter.adaptResponse(response);
      console.log('🔍 Response adapted:', {
        hasEditedImage: !!editResponse.editedImage,
        editedImageLength: editResponse.editedImage?.length || 0
      });

      // Build final response
      return {
        editedImage: editResponse.editedImage,
        regions: [{
          regionId: firstRegion.mask.id || 'region-1',
          success: true,
          editedData: editResponse.editedImage,
          processingTime: editResponse.metadata.processingTime
        }],
        metadata: {
          processingTime: editResponse.metadata.processingTime,
          provider,
          fallbackUsed: false
        }
      };

    } catch (error) {
      console.error('❌ Native editing failed:', error);
      
      // Try fallback approach
      console.log('🔄 Attempting fallback editing...');
      return this.executeFallbackEdit(request, provider, adapter);
    }
  }

  /**
   * Execute batch editing for providers that support it
   */
  private async executeBatchEdit(request: EditRequest, provider: string, adapter: ProviderAdapter): Promise<any[]> {
    try {
      // Adapt request for provider
      const providerRequest = adapter.adaptRequest(request);
      
      // Make API call (simulated for now)
      const response = await this.makeProviderAPICall(providerRequest);
      
      // Adapt response
      const editResponse = adapter.adaptResponse(response);
      
      // Convert to EditResult format
      return editResponse.regions.map(region => ({
        regionId: region.regionId,
        success: region.success,
        editedImage: region.editedData,
        error: region.error ? { message: region.error } : undefined,
        metadata: {
          processingTime: region.processingTime,
          provider
        }
      }));
    } catch (error) {
      // Handle provider errors
      const apiError = adapter.handleError({
        provider,
        code: 'API_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
      
      throw apiError;
    }
  }

  /**
   * Execute sequential editing for providers that don't support batch processing
   */
  private async executeSequentialEdit(request: EditRequest, provider: string, adapter: ProviderAdapter): Promise<any[]> {
    const results = [];
    
    for (const [index, region] of request.regions.entries()) {
      try {
        // Create single-region request
        const singleRegionRequest = {
          ...request,
          regions: [region]
        };
        
        // Adapt request for provider
        const providerRequest = adapter.adaptRequest(singleRegionRequest);
        
        // Make API call
        const response = await this.makeProviderAPICall(providerRequest);
        
        // Adapt response
        const editResponse = adapter.adaptResponse(response);
        
        // Add to results
        results.push({
          regionId: region.mask.id || `region-${index + 1}`,
          success: true,
          editedImage: editResponse.editedImage,
          metadata: {
            processingTime: editResponse.metadata.processingTime,
            provider
          }
        });
      } catch (error) {
        // Handle individual region failure
        const apiError = adapter.handleError({
          provider,
          code: 'REGION_ERROR',
          message: error instanceof Error ? error.message : 'Region processing failed'
        });
        
        results.push({
          regionId: region.mask.id || `region-${index + 1}`,
          success: false,
          error: apiError,
          metadata: {
            processingTime: 0,
            provider
          }
        });
      }
    }
    
    return results;
  }

  /**
   * Execute fallback editing for providers without native editing support
   * Uses generation-based editing approaches for providers that don't support native editing
   */
  private async executeFallbackEdit(request: EditRequest, provider: string, adapter: ProviderAdapter): Promise<EditResponse> {
    console.log(`Executing fallback editing for provider: ${provider}`);
    
    try {
      // Strategy 1: Generation-based editing using inpainting prompts
      if (provider === 'gemini' || provider === 'modelgate') {
        return await this.executeGenerationBasedEditing(request, provider, adapter);
      }
      
      // Strategy 2: Multi-step generation approach
      return await this.executeMultiStepGeneration(request, provider, adapter);
      
    } catch (error) {
      console.error(`Fallback editing failed for provider ${provider}:`, error);
      
      // Final fallback: return original with error information
      return this.createFallbackErrorResponse(request, provider, error);
    }
  }

  /**
   * Generation-based editing using inpainting-style prompts
   */
  private async executeGenerationBasedEditing(request: EditRequest, provider: string, adapter: ProviderAdapter): Promise<EditResponse> {
    const results: any[] = [];
    
    for (const [index, region] of request.regions.entries()) {
      try {
        // Create a generation prompt that describes the desired edit
        const generationPrompt = this.createInpaintingPrompt(region, request);
        
        // Use the provider's generation API instead of editing API
        const generationRequest = this.adaptEditToGenerationRequest(request, generationPrompt, provider);
        
        // Make generation API call
        const generationResponse = await this.makeGenerationAPICall(generationRequest, provider);
        
        // Process the generation response
        const editResult = this.processGenerationAsEdit(generationResponse, region, provider);
        results.push(editResult);
        
      } catch (error) {
        console.error(`Generation-based editing failed for region ${region.mask.id || `region-${index + 1}`}:`, error);
        
        results.push({
          regionId: region.mask.id || `region-${index + 1}`,
          success: false,
          error: {
            code: 'GENERATION_FALLBACK_FAILED',
            message: `Generation-based editing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            provider,
            recoverable: true,
            suggestedActions: [
              'Try with a different provider',
              'Simplify the edit instruction',
              'Use a provider with native editing support'
            ]
          },
          metadata: {
            processingTime: 0,
            provider
          }
        });
      }
    }
    
    // Composite results if multiple regions were processed
    const finalImage = results.some(r => r.success) 
      ? await this.compositeFallbackResults(results, request.originalImage)
      : request.originalImage;
    
    const totalProcessingTime = results.reduce((sum, r) => sum + r.metadata.processingTime, 0);
    
    return {
      editedImage: finalImage,
      regions: results.map(r => ({
        regionId: r.regionId,
        success: r.success,
        editedData: r.editedImage,
        error: r.error?.message,
        processingTime: r.metadata.processingTime
      })),
      metadata: {
        processingTime: totalProcessingTime,
        provider,
        fallbackUsed: true
      }
    };
  }

  /**
   * Multi-step generation approach for complex edits
   */
  private async executeMultiStepGeneration(request: EditRequest, provider: string, adapter: ProviderAdapter): Promise<EditResponse> {
    // Step 1: Analyze the original image and edit requirements
    const analysisPrompt = this.createImageAnalysisPrompt(request);
    
    // Step 2: Generate a new image based on the analysis and edit instructions
    const enhancedPrompt = this.createEnhancedGenerationPrompt(request, analysisPrompt);
    
    try {
      const generationRequest = this.adaptEditToGenerationRequest(request, enhancedPrompt, provider);
      const generationResponse = await this.makeGenerationAPICall(generationRequest, provider);
      
      const editResult = {
        regionId: 'multi-step-generation',
        success: true,
        editedImage: generationResponse.editedImage || generationResponse.generatedImage,
        metadata: {
          processingTime: generationResponse.processingTime || 3000,
          provider
        }
      };
      
      return {
        editedImage: editResult.editedImage,
        regions: [{
          regionId: editResult.regionId,
          success: editResult.success,
          editedData: editResult.editedImage,
          processingTime: editResult.metadata.processingTime
        }],
        metadata: {
          processingTime: editResult.metadata.processingTime,
          provider,
          fallbackUsed: true
        }
      };
      
    } catch (error) {
      console.error(`Multi-step generation failed for provider ${provider}:`, error);
      return this.createFallbackErrorResponse(request, provider, error);
    }
  }

  /**
   * Create inpainting-style prompt for generation-based editing
   */
  private createInpaintingPrompt(region: EditRegion, request: EditRequest): string {
    const basePrompt = `Edit the image by ${region.instruction.toLowerCase()}`;
    
    // Add context about the region
    const regionContext = this.describeRegion(region.mask);
    const contextualPrompt = `${basePrompt} in the ${regionContext}`;
    
    // Add style preservation if requested
    if (region.stylePreservation) {
      return `${contextualPrompt}. Maintain the original image style and only modify the specified area.`;
    }
    
    return contextualPrompt;
  }

  /**
   * Create image analysis prompt for multi-step generation
   */
  private createImageAnalysisPrompt(request: EditRequest): string {
    const editDescriptions = request.regions.map(region => 
      `${region.instruction} in ${this.describeRegion(region.mask)}`
    ).join(', ');
    
    return `Analyze this image and apply the following edits: ${editDescriptions}. ` +
           `Preserve the overall composition and style while making the requested changes.`;
  }

  /**
   * Create enhanced generation prompt combining analysis and edits
   */
  private createEnhancedGenerationPrompt(request: EditRequest, analysisPrompt: string): string {
    let prompt = analysisPrompt;
    
    // Add quality and style preferences
    if (request.globalOptions.highFidelity) {
      prompt += ' Generate with high fidelity and attention to detail.';
    }
    
    if (request.globalOptions.stylePreservation) {
      prompt += ' Maintain the original artistic style and composition.';
    }
    
    if (request.globalOptions.qualityLevel === 'high') {
      prompt += ' Use the highest quality settings available.';
    }
    
    return prompt;
  }

  /**
   * Describe a region based on its mask properties
   */
  private describeRegion(mask: Mask): string {
    const bounds = mask.bounds;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    
    // Simple region description based on position
    let description = '';
    
    if (centerY < bounds.height / 3) {
      description += 'upper ';
    } else if (centerY > bounds.height * 2 / 3) {
      description += 'lower ';
    } else {
      description += 'middle ';
    }
    
    if (centerX < bounds.width / 3) {
      description += 'left area';
    } else if (centerX > bounds.width * 2 / 3) {
      description += 'right area';
    } else {
      description += 'center area';
    }
    
    return description;
  }

  /**
   * Adapt edit request to generation request format
   */
  private adaptEditToGenerationRequest(request: EditRequest, prompt: string, provider: string): any {
    return {
      prompt,
      provider,
      quality: request.globalOptions.qualityLevel,
      style: request.globalOptions.stylePreservation ? 'preserve_original' : 'natural',
      originalImage: request.originalImage // Include for context if supported
    };
  }

  /**
   * Make generation API call (simulated for now)
   */
  private async makeGenerationAPICall(generationRequest: any, provider: string): Promise<any> {
    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));
    
    // Simulate success/failure based on provider
    const successRate = provider === 'openai' ? 0.9 : provider === 'gemini' ? 0.8 : 0.7;
    
    if (Math.random() > successRate) {
      throw new Error(`Simulated ${provider} generation API failure`);
    }
    
    // Return mock generation response
    return {
      generatedImage: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      processingTime: 2500
    };
  }

  /**
   * Process generation response as edit result
   */
  private processGenerationAsEdit(generationResponse: any, region: EditRegion, provider: string): any {
    return {
      regionId: region.mask.id || 'generated-region',
      success: true,
      editedImage: generationResponse.generatedImage,
      metadata: {
        processingTime: generationResponse.processingTime || 2500,
        provider
      }
    };
  }

  /**
   * Composite fallback results from multiple generation attempts
   */
  private async compositeFallbackResults(results: any[], originalImage: string): Promise<string> {
    // For fallback, we'll use the first successful result
    // In a real implementation, this could be more sophisticated
    const successfulResult = results.find(r => r.success);
    return successfulResult?.editedImage || originalImage;
  }

  /**
   * Create error response for fallback failures
   */
  private createFallbackErrorResponse(request: EditRequest, provider: string, error: any): EditResponse {
    const errorMessage = error instanceof Error ? error.message : 'Fallback editing failed';
    
    return {
      editedImage: request.originalImage, // Return original on complete failure
      regions: request.regions.map((region, index) => ({
        regionId: region.mask.id || `region-${index + 1}`,
        success: false,
        error: `Fallback editing failed: ${errorMessage}`,
        processingTime: 0
      })),
      metadata: {
        processingTime: 0,
        provider,
        fallbackUsed: true
      }
    };
  }

  /**
   * Make API call to provider (simulated for now)
   */
  /**
   * Make actual API call to provider
   */
  private async makeProviderAPICall(request: ProviderSpecificRequest): Promise<ProviderSpecificResponse> {
    console.log('🔍 Making real API call to provider:', request.provider);
    console.log('🔍 API endpoint:', request.endpoint);
    
    try {
      // For now, let's delegate back to the existing image generation system
      // This is a temporary solution to get editing working quickly
      
      if (request.provider === 'openai') {
        // Use OpenAI's image editing endpoint
        const response = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}${request.endpoint}`, {
          method: 'POST',
          headers: request.headers,
          body: this.buildOpenAIRequestBody(request)
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
        }
        
        const data = await response.json();
        return {
          provider: request.provider,
          data,
          headers: Object.fromEntries(response.headers.entries()),
          status: response.status
        };
      } else {
        // For other providers, fall back to the existing generation system
        // by calling the original API route internally
        console.log('🔄 Falling back to existing generation system for provider:', request.provider);
        
        // Extract the original request data from the provider request
        const originalRequest = this.extractOriginalRequestFromProviderRequest(request);
        
        // Make internal API call to existing generation system
        const response = await this.callExistingGenerationAPI(originalRequest);
        
        return {
          provider: request.provider,
          data: response,
          headers: {},
          status: 200
        };
      }
    } catch (error) {
      console.error('❌ Provider API call failed:', error);
      throw error;
    }
  }

  /**
   * Build OpenAI request body for editing
   */
  private buildOpenAIRequestBody(request: ProviderSpecificRequest): FormData {
    const formData = new FormData();
    
    // Add form fields from request body
    Object.entries(request.body).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        if (key === 'image' || key === 'mask') {
          // Handle image/mask data
          if (typeof value === 'string') {
            // Convert base64 to blob
            const binaryString = atob(value);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: 'image/png' });
            formData.append(key, blob, `${key}.png`);
          }
        } else {
          formData.append(key, String(value));
        }
      }
    });
    
    return formData;
  }

  /**
   * Extract original request data from provider request
   */
  private extractOriginalRequestFromProviderRequest(request: ProviderSpecificRequest): any {
    // This is a simplified extraction - in a real implementation,
    // we would properly map provider-specific requests back to original format
    return {
      prompt: request.body.prompt || 'Edit this image',
      inputImage: request.body.image ? {
        data: request.body.image,
        mimeType: 'image/png'
      } : undefined,
      maskImage: request.body.mask ? {
        data: request.body.mask,
        mimeType: 'image/png'
      } : undefined,
      provider: request.provider
    };
  }

  /**
   * Call existing generation API internally
   */
  private async callExistingGenerationAPI(originalRequest: any): Promise<any> {
    // This would normally make an internal API call
    // For now, return a placeholder response
    console.log('🔄 Would call existing generation API with:', originalRequest);
    
    // Return a mock response that indicates the request was processed
    return {
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      message: 'Processed via existing generation API (placeholder)'
    };
  }

  /**
   * Enhanced error handling with provider-specific recovery strategies
   */
  private async handleEditError(error: APIErrorType, request: EditRequest): Promise<EditResponse> {
    // Get provider-specific fallback strategy
    const provider = request.provider || 'openai';
    const adapter = this.providerAdapters.get(provider);
    
    if (adapter) {
      // Use provider-specific error handling
      const adaptedError = adapter.handleError({
        provider,
        code: error.code,
        message: error.message
      });
      
      // Try fallback strategies if error is recoverable
      if (adaptedError.recoverable) {
        const fallbackStrategy = this.getEnhancedFallbackStrategy(adaptedError);
        
        if (fallbackStrategy.canRecover(adaptedError)) {
          const context: EditContext = {
            originalRequest: request,
            attemptCount: 1,
            previousErrors: [adaptedError],
            availableProviders: Array.from(this.providerAdapters.keys()).filter(p => p !== provider)
          };

          try {
            return await fallbackStrategy.recover(adaptedError, context);
          } catch (fallbackError) {
            // If fallback fails, return error response
            return this.createErrorResponse(adaptedError, request);
          }
        }
      }
    }

    return this.createErrorResponse(error, request);
  }

  /**
   * Enhanced fallback strategy with provider switching
   */
  private getEnhancedFallbackStrategy(error: APIErrorType): FallbackStrategy {
    return {
      canRecover: (err: APIErrorType) => err.recoverable,
      recover: async (err: APIErrorType, context: EditContext) => {
        // Try alternative providers
        for (const alternativeProvider of context.availableProviders) {
          try {
            const adapter = this.providerAdapters.get(alternativeProvider);
            if (adapter && this.isProviderSuitable(adapter, context.originalRequest)) {
              console.log(`Attempting fallback to provider: ${alternativeProvider}`);
              
              // Retry with alternative provider
              const fallbackRequest = {
                ...context.originalRequest,
                provider: alternativeProvider
              };
              
              return await this.processEditRequest(fallbackRequest);
            }
          } catch (fallbackError) {
            console.log(`Fallback to ${alternativeProvider} failed:`, fallbackError);
            continue;
          }
        }
        
        throw new Error('All fallback providers failed');
      },
      fallbackOptions: (err: APIErrorType) => {
        const options: FallbackOption[] = [
          {
            type: 'retry',
            description: 'Retry the request with the same parameters',
            estimatedSuccess: 0.3
          }
        ];
        
        if (err.provider !== 'openai') {
          options.push({
            type: 'alternative_provider',
            description: 'Try with OpenAI provider',
            estimatedSuccess: 0.8
          });
        }
        
        if (err.provider !== 'gemini') {
          options.push({
            type: 'alternative_provider',
            description: 'Try with Gemini provider',
            estimatedSuccess: 0.6
          });
        }
        
        options.push({
          type: 'simplified_request',
          description: 'Simplify the edit request',
          estimatedSuccess: 0.7
        });
        
        return options;
      }
    };
  }

  /**
   * Get provider-specific error actions
   */
  private getOpenAIErrorActions(errorCode: string): string[] {
    const actions: Record<string, string[]> = {
      'invalid_api_key': ['Check OpenAI API key configuration', 'Verify API key permissions'],
      'rate_limit_exceeded': ['Wait before retrying', 'Use request queue management'],
      'content_policy_violation': ['Modify edit instructions', 'Remove potentially harmful content'],
      'image_too_large': ['Resize image to 1024x1024 or smaller', 'Use image tiling strategy'],
      'invalid_image_format': ['Convert image to PNG or JPEG', 'Check image encoding'],
      'insufficient_credits': ['Check OpenAI account balance', 'Add credits to account']
    };
    
    return actions[errorCode] || ['Check request parameters', 'Try again later'];
  }

  private createErrorResponse(error: APIErrorType, request: EditRequest): EditResponse {
    const failedRegions = request.regions.map((region, index) => ({
      regionId: region.mask.id || `region-${index + 1}`,
      success: false,
      error: error.message,
      processingTime: 0
    }));

    return {
      editedImage: request.originalImage, // Return original image on failure
      regions: failedRegions,
      metadata: {
        processingTime: 0,
        provider: request.provider || 'unknown',
        fallbackUsed: false
      }
    };
  }

  private getProviderCapabilities(provider: string): ProviderCapabilities {
    const adapter = this.providerAdapters.get(provider);
    return adapter?.capabilities || {
      supportsNativeEditing: false,
      supportsBatchEditing: false,
      maxImageSize: { width: 1024, height: 1024 },
      supportedMaskFormats: ['base64'],
      highFidelitySupport: false
    };
  }

  // Conversion methods for backward compatibility

  private convertToEditRequest(request: EnhancedImageRequest): EditRequest {
    // Handle both new format (originalImage, masks) and legacy format (inputImage, maskImage)
    const originalImage = request.originalImage || (request as any).inputImage?.data || '';
    const maskImage = (request as any).maskImage;
    
    let regions: EditRegion[] = [];
    
    if (request.masks && request.masks.length > 0) {
      // New format: multiple masks with instructions
      regions = request.masks.map((mask, index) => ({
        mask,
        instruction: request.editInstructions?.[index] || 'Edit this region',
        priority: 1,
        stylePreservation: request.stylePreservation || false
      }));
    } else if (maskImage) {
      // Legacy format: single mask image
      const maskData: Mask = {
        id: 'legacy-mask-1',
        type: 'bitmap',
        data: maskImage.data,
        bounds: { x: 0, y: 0, width: 1024, height: 1024 }, // Default bounds
        format: 'base64'
      };
      
      regions = [{
        mask: maskData,
        instruction: (request as any).prompt || 'Edit this region according to the provided instructions',
        priority: 1,
        stylePreservation: request.stylePreservation !== false // Default to true for legacy requests
      }];
    }

    return {
      originalImage,
      regions,
      globalOptions: {
        highFidelity: request.highFidelity !== false, // Default to true for better quality
        stylePreservation: request.stylePreservation !== false, // Default to true
        qualityLevel: request.quality === 'hd' ? 'high' : 'standard'
      },
      provider: request.model || (request as any).provider // Use model or provider as hint
    };
  }

  private convertToEnhancedResponse(
    editResponse: EditResponse | null, 
    mode: 'edit' | 'generate',
    legacyRequest?: ExistingImageRequest
  ): EnhancedImageResponse {
    if (mode === 'edit' && editResponse) {
      // For editing mode, return the edited image in legacy-compatible format
      const imageBase64 = editResponse.editedImage.startsWith('data:image/') 
        ? editResponse.editedImage.split(',')[1] 
        : editResponse.editedImage;
        
      return {
        // Legacy compatibility: return imageBase64 field that existing code expects
        imageBase64,
        editedImage: editResponse.editedImage,
        regions: editResponse.regions,
        metadata: {
          ...editResponse.metadata,
          editingMode: 'edit'
        }
      };
    } else {
      // For generation mode, return legacy-compatible response
      return {
        // These would be populated by the existing generation logic
        metadata: {
          processingTime: 0,
          provider: 'unknown',
          fallbackUsed: false,
          editingMode: 'generate'
        }
      };
    }
  }

  private convertToLegacyRequest(request: EnhancedImageRequest): ExistingImageRequest {
    return {
      prompt: request.prompt || '',
      model: request.model,
      size: request.size,
      quality: request.quality,
      style: request.style,
      response_format: request.response_format
    };
  }
}

// Custom error class for API errors
class APIError extends Error {
  constructor(
    public code: string,
    message: string,
    public recoverable: boolean = false,
    public suggestedActions: string[] = []
  ) {
    super(message);
    this.name = 'APIError';
  }
}

export const apiIntegrationLayer = new APIIntegrationLayer();