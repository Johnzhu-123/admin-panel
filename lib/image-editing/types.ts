/**
 * Core data structures and interfaces for AI image editing enhancement
 * Extends existing PPT generation application with mask-based editing capabilities
 */

// Basic geometric types
export interface Point {
  x: number;
  y: number;
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

// Mask-related types
export interface Mask {
  id?: string; // Optional ID for tracking masks
  type: 'brush' | 'rectangle' | 'circle' | 'bitmap';
  coordinates?: Point[]; // For vector masks (brush, rectangle, circle)
  bounds: Rectangle;
  opacity?: number;
  data?: string; // base64 encoded mask data for bitmap masks
  format?: 'base64' | 'png' | 'imagedata';
  imageData?: ImageData; // Canvas ImageData for the mask (legacy)
}

export interface OptimizedMask {
  originalMask: Mask;
  optimizedData: string; // base64 encoded optimized mask
  format: 'png' | 'base64';
  resolution: ImageSize;
  compressionRatio: number;
}

// Edit region and instruction types
export interface EditRegion {
  mask: Mask;
  instruction: string;
  priority: number;
  stylePreservation: boolean;
}

export interface RegionInstruction {
  regionId: string;
  instruction: string;
  stylePreservation: boolean;
}

// Request and response types
export interface EditRequest {
  originalImage: string; // base64
  regions: EditRegion[];
  globalOptions: {
    highFidelity: boolean;
    stylePreservation: boolean;
    qualityLevel: 'standard' | 'high';
  };
  provider?: string;
}

export interface ProcessedRegion {
  regionId: string;
  success: boolean;
  editedData?: string; // base64 image data for this region
  error?: string;
  processingTime: number;
}

export interface EditResponse {
  editedImage: string; // base64
  regions: ProcessedRegion[];
  metadata: {
    processingTime: number;
    provider: string;
    fallbackUsed: boolean;
  };
}

// Provider capability types
export interface ProviderCapabilities {
  supportsNativeEditing: boolean;
  supportsBatchEditing: boolean;
  maxImageSize: ImageSize;
  supportedMaskFormats: string[];
  highFidelitySupport: boolean;
}

export interface ProviderAdapter {
  capabilities: ProviderCapabilities;
  adaptRequest(request: EditRequest): ProviderSpecificRequest;
  adaptResponse(response: ProviderSpecificResponse): EditResponse;
  handleError(error: ProviderError): APIError;
}

// Provider-specific types (generic interfaces)
export interface ProviderSpecificRequest {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  body: any;
}

export interface ProviderSpecificResponse {
  provider: string;
  data: any;
  headers: Record<string, string>;
  status: number;
}

export interface ProviderError {
  provider: string;
  code: string;
  message: string;
  details?: any;
}

// Error handling types
export interface APIError {
  code: string;
  message: string;
  provider?: string;
  recoverable: boolean;
  suggestedActions: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// Execution planning types
export interface ExecutionPlan {
  type: 'batch' | 'sequential';
  regions: EditRegion[];
  provider: string;
  estimatedTime: number;
  fallbackPlan?: ExecutionPlan;
}

export interface RegionAnalysis {
  totalArea: number;
  averageComplexity: number;
  hasOverlappingRegions: boolean;
  hasStylePreservation: boolean;
  priorityGroups: Record<number, EditRegion[]>;
  regionCount: number;
}

export interface EditResult {
  regionId: string;
  success: boolean;
  editedImage?: string;
  error?: APIError;
  metadata: {
    processingTime: number;
    provider: string;
  };
}

export interface RecoveryPlan {
  failedRegions: string[];
  successfulRegions: string[];
  suggestedActions: RecoveryAction[];
}

export interface FailureAnalysis {
  hasRecoverableErrors: boolean;
  hasProviderSpecificErrors: boolean;
  hasComplexityIssues: boolean;
}

export interface RecoveryAction {
  type: 'retry' | 'alternative_provider' | 'simplified_request' | 'manual_intervention';
  description: string;
  estimatedSuccess: number; // 0-1 probability
  regionIds: string[];
}

// Canvas and UI types
export interface CanvasState {
  image: string; // base64
  masks: Mask[];
  activeTool: 'brush' | 'rectangle' | 'circle' | 'none';
  zoom: number;
  pan: Point;
}

export interface ToolOptions {
  brushSize?: number;
  opacity?: number;
  color?: string;
}

// Prompt engineering types
export interface PromptOptions {
  highFidelity: boolean;
  stylePreservation: boolean;
  provider: string;
  qualityLevel: 'standard' | 'high';
}

export interface HighFidelityOptions {
  preventOverInterpretation: boolean;
  maintainOriginalStyle: boolean;
  focusOnMaskedRegions: boolean;
  preserveUnmaskedAreas: boolean;
}

// Performance and optimization types
export interface OptimizationOptions {
  maxImageSize: ImageSize;
  compressionLevel: number;
  tileSize?: ImageSize;
  cacheResults: boolean;
}

export interface PerformanceMetrics {
  processingTime: number;
  memoryUsage: number;
  apiCalls: number;
  cacheHits: number;
  cacheMisses: number;
}

// Fallback strategy types
export interface FallbackOption {
  type: 'retry' | 'alternative_provider' | 'simplified_request' | 'manual_intervention';
  description: string;
  estimatedSuccess: number; // 0-1 probability
}

export interface FallbackStrategy {
  canRecover(error: APIError): boolean;
  recover(error: APIError, context: EditContext): Promise<EditResponse>;
  fallbackOptions(error: APIError): FallbackOption[];
}

export interface EditContext {
  originalRequest: EditRequest;
  attemptCount: number;
  previousErrors: APIError[];
  availableProviders: string[];
}

// Composition and quality types
export interface CompositionPlan {
  results: EditResult[];
  blendingStrategies: BlendingStrategy[];
  overlappingPairs: string[][];
  qualityThreshold: number;
}

export interface BlendingStrategy {
  resultId: string;
  blendMode: 'direct_replace' | 'alpha_blend' | 'multiply' | 'overlay';
  opacity: number;
  featherRadius: number;
  order: number;
}

export interface QualityCheck {
  passed: boolean;
  score: number; // 0-1
  issues: string[];
}

// Progress tracking types
export interface ProgressState {
  sessionId: string;
  totalRegions: number;
  completedRegions: number;
  failedRegions: number;
  currentRegion?: string;
  startTime: number;
  lastUpdateTime: number;
  estimatedTimeRemaining: number;
  canContinue: boolean;
}

export interface ContinuationData {
  sessionId: string;
  originalRequest: EditRequest;
  completedResults: EditResult[];
  remainingRegions: EditRegion[];
  progressState: ProgressState;
}

// Integration types for existing systems
export interface ExistingImageRequest {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  style?: string;
  response_format?: string;
}

export interface EnhancedImageRequest extends ExistingImageRequest {
  // Editing-specific fields
  originalImage?: string;
  masks?: Mask[];
  editInstructions?: string[];
  editingMode?: 'generate' | 'edit';
  highFidelity?: boolean;
  stylePreservation?: boolean;
}

// Backward compatibility types
export interface LegacyImageResponse {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface EnhancedImageResponse extends LegacyImageResponse {
  // Enhanced fields for editing
  editedImage?: string;
  imageBase64?: string; // For backward compatibility with existing frontend code
  regions?: ProcessedRegion[];
  metadata?: {
    processingTime: number;
    provider: string;
    fallbackUsed: boolean;
    editingMode: 'generate' | 'edit';
  };
}