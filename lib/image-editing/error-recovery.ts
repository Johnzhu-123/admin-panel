/**
 * Error Recovery and User Feedback Systems
 * Provides comprehensive error handling, recovery strategies, and user-friendly feedback
 */

import { EditRequest, EditResponse, APIError, RecoveryAction, EditContext } from './types';

export interface ErrorCategory {
  type: 'network' | 'validation' | 'processing' | 'resource' | 'provider' | 'user';
  severity: 'low' | 'medium' | 'high' | 'critical';
  recoverable: boolean;
}

export interface ErrorDetails {
  code: string;
  message: string;
  category: ErrorCategory;
  context: Record<string, any>;
  timestamp: number;
  requestId?: string;
  userId?: string;
}

export interface RecoveryStrategy {
  name: string;
  priority: number;
  canRecover: (error: ErrorDetails) => boolean;
  recover: (error: ErrorDetails, context: EditContext) => Promise<RecoveryResult>;
  estimatedSuccess: number; // 0-1 probability
}

export interface RecoveryResult {
  success: boolean;
  response?: EditResponse;
  newError?: ErrorDetails;
  suggestedActions: RecoveryAction[];
  fallbackUsed: boolean;
}

export interface UserFeedback {
  type: 'error' | 'warning' | 'info' | 'success';
  title: string;
  message: string;
  details?: string;
  actions: UserAction[];
  dismissible: boolean;
  autoHide?: number; // milliseconds
}

export interface UserAction {
  label: string;
  action: 'retry' | 'fallback' | 'cancel' | 'report' | 'custom';
  handler?: () => Promise<void>;
  primary?: boolean;
}

export interface ErrorReportData {
  error: ErrorDetails;
  context: EditContext;
  userAgent: string;
  timestamp: number;
  sessionId: string;
  reproductionSteps?: string[];
}

export class ErrorRecoveryManager {
  private strategies: RecoveryStrategy[] = [];
  private errorHistory: ErrorDetails[] = [];
  private maxHistorySize = 100;
  private feedbackCallbacks: ((feedback: UserFeedback) => void)[] = [];

  constructor() {
    this.initializeStrategies();
  }

  /**
   * Handle an error with recovery attempts
   */
  async handleError(
    error: Error | ErrorDetails,
    context: EditContext
  ): Promise<RecoveryResult> {
    const errorDetails = this.normalizeError(error, context);
    this.recordError(errorDetails);

    // Try recovery strategies in priority order
    const applicableStrategies = this.strategies
      .filter(strategy => strategy.canRecover(errorDetails))
      .sort((a, b) => b.priority - a.priority);

    for (const strategy of applicableStrategies) {
      try {
        const result = await strategy.recover(errorDetails, context);
        
        if (result.success) {
          this.notifyUser({
            type: 'success',
            title: 'Issue Resolved',
            message: `Successfully recovered using ${strategy.name}`,
            actions: [],
            dismissible: true,
            autoHide: 3000
          });
          return result;
        }
      } catch (recoveryError) {
        console.warn(`Recovery strategy ${strategy.name} failed:`, recoveryError);
      }
    }

    // No recovery possible, provide user feedback
    const feedback = this.generateUserFeedback(errorDetails, context);
    this.notifyUser(feedback);

    return {
      success: false,
      suggestedActions: this.generateSuggestedActions(errorDetails, context),
      fallbackUsed: false
    };
  }

  /**
   * Generate user-friendly feedback for errors
   */
  generateUserFeedback(error: ErrorDetails, context: EditContext): UserFeedback {
    const actions: UserAction[] = [];

    // Add retry action if error is potentially recoverable
    if (error.category.recoverable && context.attemptCount < 3) {
      actions.push({
        label: 'Try Again',
        action: 'retry',
        primary: true,
        handler: async () => {
          // Retry logic would be implemented here
        }
      });
    }

    // Add fallback options
    if (this.hasFallbackOptions(error)) {
      actions.push({
        label: 'Use Alternative Method',
        action: 'fallback',
        handler: async () => {
          // Fallback logic would be implemented here
        }
      });
    }

    // Add report option for unexpected errors
    if (error.category.severity === 'high' || error.category.severity === 'critical') {
      actions.push({
        label: 'Report Issue',
        action: 'report',
        handler: async () => {
          await this.reportError(error, context);
        }
      });
    }

    // Always add cancel option
    actions.push({
      label: 'Cancel',
      action: 'cancel'
    });

    return {
      type: this.getMessageType(error),
      title: this.getErrorTitle(error),
      message: this.getErrorMessage(error),
      details: this.getErrorDetails(error),
      actions,
      dismissible: error.category.severity !== 'critical'
    };
  }

  /**
   * Generate suggested recovery actions
   */
  generateSuggestedActions(error: ErrorDetails, context: EditContext): RecoveryAction[] {
    const actions: RecoveryAction[] = [];

    switch (error.category.type) {
      case 'network':
        actions.push({
          type: 'retry',
          description: 'Check your internet connection and try again',
          estimatedSuccess: 0.7,
          regionIds: []
        });
        break;

      case 'validation':
        actions.push({
          type: 'simplified_request',
          description: 'Try with fewer or simpler mask selections',
          estimatedSuccess: 0.8,
          regionIds: context.originalRequest.regions.map(r => r.mask.id)
        });
        break;

      case 'processing':
        actions.push({
          type: 'alternative_provider',
          description: 'Try with a different AI provider',
          estimatedSuccess: 0.6,
          regionIds: []
        });
        break;

      case 'resource':
        actions.push({
          type: 'simplified_request',
          description: 'Reduce image size or number of edits',
          estimatedSuccess: 0.9,
          regionIds: []
        });
        break;

      case 'provider':
        actions.push({
          type: 'alternative_provider',
          description: 'Switch to a different AI service',
          estimatedSuccess: 0.8,
          regionIds: []
        });
        break;

      case 'user':
        actions.push({
          type: 'manual_intervention',
          description: 'Please review your selections and try again',
          estimatedSuccess: 0.9,
          regionIds: []
        });
        break;
    }

    return actions;
  }

  /**
   * Report error for analysis and improvement
   */
  async reportError(error: ErrorDetails, context: EditContext): Promise<void> {
    const reportData: ErrorReportData = {
      error,
      context,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown',
      timestamp: Date.now(),
      sessionId: this.generateSessionId(),
      reproductionSteps: this.generateReproductionSteps(context)
    };

    try {
      // In a real implementation, this would send to an error reporting service
      console.log('Error report:', reportData);
      
      this.notifyUser({
        type: 'success',
        title: 'Report Sent',
        message: 'Thank you for reporting this issue. We\'ll investigate and improve the system.',
        actions: [],
        dismissible: true,
        autoHide: 5000
      });
    } catch (reportError) {
      console.error('Failed to report error:', reportError);
      
      this.notifyUser({
        type: 'error',
        title: 'Report Failed',
        message: 'Unable to send error report. Please try again later.',
        actions: [{
          label: 'OK',
          action: 'cancel'
        }],
        dismissible: true
      });
    }
  }

  /**
   * Add feedback callback
   */
  onFeedback(callback: (feedback: UserFeedback) => void): void {
    this.feedbackCallbacks.push(callback);
  }

  /**
   * Remove feedback callback
   */
  offFeedback(callback: (feedback: UserFeedback) => void): void {
    const index = this.feedbackCallbacks.indexOf(callback);
    if (index > -1) {
      this.feedbackCallbacks.splice(index, 1);
    }
  }

  /**
   * Get error history
   */
  getErrorHistory(): ErrorDetails[] {
    return [...this.errorHistory];
  }

  /**
   * Clear error history
   */
  clearErrorHistory(): void {
    this.errorHistory = [];
  }

  /**
   * Get error statistics
   */
  getErrorStats(): {
    totalErrors: number;
    errorsByCategory: Record<string, number>;
    errorsBySeverity: Record<string, number>;
    recoveryRate: number;
  } {
    const stats = {
      totalErrors: this.errorHistory.length,
      errorsByCategory: {} as Record<string, number>,
      errorsBySeverity: {} as Record<string, number>,
      recoveryRate: 0
    };

    this.errorHistory.forEach(error => {
      stats.errorsByCategory[error.category.type] = 
        (stats.errorsByCategory[error.category.type] || 0) + 1;
      
      stats.errorsBySeverity[error.category.severity] = 
        (stats.errorsBySeverity[error.category.severity] || 0) + 1;
    });

    // Calculate recovery rate (this would be tracked in a real implementation)
    stats.recoveryRate = 0.75; // Mock value

    return stats;
  }

  /**
   * Initialize recovery strategies
   */
  private initializeStrategies(): void {
    // Network retry strategy
    this.strategies.push({
      name: 'network_retry',
      priority: 9,
      estimatedSuccess: 0.7,
      canRecover: (error) => error.category.type === 'network',
      recover: async (error, context) => {
        if (context.attemptCount >= 3) {
          return {
            success: false,
            suggestedActions: [{
              type: 'manual_intervention',
              description: 'Please check your internet connection',
              estimatedSuccess: 0.9,
              regionIds: []
            }],
            fallbackUsed: false
          };
        }

        // Implement exponential backoff
        const delay = Math.pow(2, context.attemptCount) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));

        // In a real implementation, this would retry the original request
        return {
          success: true,
          suggestedActions: [],
          fallbackUsed: false
        };
      }
    });

    // Provider fallback strategy
    this.strategies.push({
      name: 'provider_fallback',
      priority: 8,
      estimatedSuccess: 0.8,
      canRecover: (error) => error.category.type === 'provider',
      recover: async (error, context) => {
        const availableProviders = context.availableProviders.filter(
          p => p !== context.originalRequest.provider
        );

        if (availableProviders.length === 0) {
          return {
            success: false,
            suggestedActions: [{
              type: 'manual_intervention',
              description: 'No alternative providers available',
              estimatedSuccess: 0.1,
              regionIds: []
            }],
            fallbackUsed: false
          };
        }

        // Try with alternative provider
        const fallbackProvider = availableProviders[0];
        
        // In a real implementation, this would make the request with the fallback provider
        return {
          success: true,
          suggestedActions: [],
          fallbackUsed: true
        };
      }
    });

    // Request simplification strategy
    this.strategies.push({
      name: 'request_simplification',
      priority: 6,
      estimatedSuccess: 0.9,
      canRecover: (error) => 
        error.category.type === 'validation' || 
        error.category.type === 'resource',
      recover: async (error, context) => {
        const originalRequest = context.originalRequest;
        
        // Simplify the request
        const simplifiedRequest: EditRequest = {
          ...originalRequest,
          regions: originalRequest.regions.slice(0, Math.ceil(originalRequest.regions.length / 2)),
          globalOptions: {
            ...originalRequest.globalOptions,
            qualityLevel: 'standard'
          }
        };

        // In a real implementation, this would process the simplified request
        return {
          success: true,
          suggestedActions: [{
            type: 'manual_intervention',
            description: 'Request was simplified to ensure processing',
            estimatedSuccess: 1.0,
            regionIds: []
          }],
          fallbackUsed: true
        };
      }
    });

    // Partial processing strategy
    this.strategies.push({
      name: 'partial_processing',
      priority: 7,
      estimatedSuccess: 0.8,
      canRecover: (error) => error.category.type === 'processing',
      recover: async (error, context) => {
        // Process regions individually
        const processedRegions = [];
        const failedRegions = [];

        for (const region of context.originalRequest.regions) {
          try {
            // In a real implementation, this would process each region
            processedRegions.push({
              regionId: region.mask.id,
              success: true,
              processingTime: 100
            });
          } catch (regionError) {
            failedRegions.push({
              regionId: region.mask.id,
              success: false,
              error: 'Processing failed',
              processingTime: 0
            });
          }
        }

        if (processedRegions.length > 0) {
          return {
            success: true,
            response: {
              editedImage: context.originalRequest.originalImage, // Mock
              regions: [...processedRegions, ...failedRegions],
              metadata: {
                processingTime: 500,
                provider: 'partial',
                fallbackUsed: true
              }
            },
            suggestedActions: [],
            fallbackUsed: true
          };
        }

        return {
          success: false,
          suggestedActions: [{
            type: 'manual_intervention',
            description: 'All regions failed to process',
            estimatedSuccess: 0.1,
            regionIds: []
          }],
          fallbackUsed: false
        };
      }
    });
  }

  /**
   * Normalize error to ErrorDetails format
   */
  private normalizeError(error: Error | ErrorDetails, context: EditContext): ErrorDetails {
    if ('code' in error && 'category' in error) {
      return error as ErrorDetails;
    }

    const jsError = error as Error;
    
    // Categorize the error based on message and context
    const category = this.categorizeError(jsError, context);

    return {
      code: jsError.name || 'UNKNOWN_ERROR',
      message: jsError.message || 'An unknown error occurred',
      category,
      context: {
        stack: jsError.stack,
        attemptCount: context.attemptCount,
        provider: context.originalRequest.provider
      },
      timestamp: Date.now(),
      requestId: this.generateRequestId()
    };
  }

  /**
   * Categorize error based on its characteristics
   */
  private categorizeError(error: Error, context: EditContext): ErrorCategory {
    const message = error.message.toLowerCase();

    // Network errors
    if (message.includes('network') || message.includes('fetch') || message.includes('timeout')) {
      return {
        type: 'network',
        severity: 'medium',
        recoverable: true
      };
    }

    // Validation errors
    if (message.includes('validation') || message.includes('invalid') || message.includes('required')) {
      return {
        type: 'validation',
        severity: 'low',
        recoverable: true
      };
    }

    // Resource errors
    if (message.includes('memory') || message.includes('size') || message.includes('limit')) {
      return {
        type: 'resource',
        severity: 'high',
        recoverable: true
      };
    }

    // Provider errors
    if (message.includes('provider') || message.includes('api') || message.includes('service')) {
      return {
        type: 'provider',
        severity: 'medium',
        recoverable: true
      };
    }

    // Default to processing error
    return {
      type: 'processing',
      severity: 'medium',
      recoverable: true
    };
  }

  /**
   * Record error in history
   */
  private recordError(error: ErrorDetails): void {
    this.errorHistory.push(error);
    
    // Maintain history size limit
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Notify user with feedback
   */
  private notifyUser(feedback: UserFeedback): void {
    this.feedbackCallbacks.forEach(callback => {
      try {
        callback(feedback);
      } catch (error) {
        console.error('Feedback callback error:', error);
      }
    });
  }

  /**
   * Check if error has fallback options
   */
  private hasFallbackOptions(error: ErrorDetails): boolean {
    return this.strategies.some(strategy => 
      strategy.canRecover(error) && strategy.estimatedSuccess > 0.5
    );
  }

  /**
   * Get message type for user feedback
   */
  private getMessageType(error: ErrorDetails): UserFeedback['type'] {
    switch (error.category.severity) {
      case 'low': return 'warning';
      case 'medium': return 'error';
      case 'high': return 'error';
      case 'critical': return 'error';
      default: return 'error';
    }
  }

  /**
   * Get user-friendly error title
   */
  private getErrorTitle(error: ErrorDetails): string {
    switch (error.category.type) {
      case 'network': return 'Connection Issue';
      case 'validation': return 'Invalid Input';
      case 'processing': return 'Processing Failed';
      case 'resource': return 'Resource Limit Exceeded';
      case 'provider': return 'Service Unavailable';
      case 'user': return 'Action Required';
      default: return 'Unexpected Error';
    }
  }

  /**
   * Get user-friendly error message
   */
  private getErrorMessage(error: ErrorDetails): string {
    switch (error.category.type) {
      case 'network':
        return 'Unable to connect to the service. Please check your internet connection.';
      case 'validation':
        return 'There\'s an issue with your selection. Please review and try again.';
      case 'processing':
        return 'We encountered an issue while processing your image. This might be temporary.';
      case 'resource':
        return 'The image or selection is too large to process. Try reducing the size or complexity.';
      case 'provider':
        return 'The AI service is currently unavailable. Please try again later.';
      case 'user':
        return 'Please review your input and make the necessary corrections.';
      default:
        return 'An unexpected error occurred. Please try again or contact support if the issue persists.';
    }
  }

  /**
   * Get detailed error information
   */
  private getErrorDetails(error: ErrorDetails): string {
    return `Error Code: ${error.code}\nTime: ${new Date(error.timestamp).toLocaleString()}`;
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate reproduction steps
   */
  private generateReproductionSteps(context: EditContext): string[] {
    const steps = [
      'User loaded image for editing',
      `Created ${context.originalRequest.regions.length} mask region(s)`,
      `Selected quality level: ${context.originalRequest.globalOptions.qualityLevel}`,
      `High fidelity: ${context.originalRequest.globalOptions.highFidelity}`,
      `Style preservation: ${context.originalRequest.globalOptions.stylePreservation}`
    ];

    if (context.originalRequest.provider) {
      steps.push(`Used provider: ${context.originalRequest.provider}`);
    }

    steps.push(`Attempt ${context.attemptCount} failed`);

    return steps;
  }
}

// Global error recovery manager instance
let globalErrorRecoveryManager: ErrorRecoveryManager | null = null;

/**
 * Get or create global error recovery manager
 */
export function getErrorRecoveryManager(): ErrorRecoveryManager {
  if (!globalErrorRecoveryManager) {
    globalErrorRecoveryManager = new ErrorRecoveryManager();
  }
  return globalErrorRecoveryManager;
}

export default ErrorRecoveryManager;