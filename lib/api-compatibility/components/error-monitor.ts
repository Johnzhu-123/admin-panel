import { ErrorMonitor } from '../interfaces';
import {
  APIError,
  ErrorAnalytics,
  ErrorType,
} from '../types';

/**
 * Error trend data for analysis
 */
interface ErrorTrend {
  timestamp: Date;
  errorType: ErrorType;
  provider: string;
  count: number;
}

/**
 * Error pattern analysis result
 */
interface ErrorPattern {
  pattern: string;
  frequency: number;
  errorType: ErrorType;
  providers: string[];
  firstSeen: Date;
  lastSeen: Date;
  examples: string[];
}

/**
 * Provider performance metrics
 */
interface ProviderMetrics {
  providerId: string;
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  averageLatency: number;
  lastUpdated: Date;
  errorsByType: Record<ErrorType, number>;
}

/**
 * Error monitoring and analysis implementation
 * Provides comprehensive error tracking, analysis, and reporting capabilities
 */
export class ErrorMonitorImpl implements ErrorMonitor {
  private errors: APIError[] = [];
  private errorTrends: ErrorTrend[] = [];
  private providerMetrics: Map<string, ProviderMetrics> = new Map();
  private maxErrorHistory: number = 10000; // Keep last 10k errors
  private maxTrendHistory: number = 1000; // Keep last 1k trend points

  constructor(maxErrorHistory?: number, maxTrendHistory?: number) {
    if (maxErrorHistory) this.maxErrorHistory = maxErrorHistory;
    if (maxTrendHistory) this.maxTrendHistory = maxTrendHistory;
  }

  /**
   * Record an API error
   */
  recordError(error: APIError): void {
    // Add timestamp if not present
    if (!error.timestamp) {
      error.timestamp = new Date();
    }

    // Store the error
    this.errors.push({ ...error });

    // Maintain error history limit
    if (this.errors.length > this.maxErrorHistory) {
      this.errors.splice(0, this.errors.length - this.maxErrorHistory);
    }

    // Update trends
    this.updateErrorTrends(error);

    // Update provider metrics
    this.updateProviderMetrics(error);
  }

  /**
   * Get comprehensive error analytics
   */
  getAnalytics(): ErrorAnalytics {
    const now = new Date();
    const totalErrors = this.errors.length;

    // Calculate error counts by type
    const errorsByType: Record<ErrorType, number> = {} as any;
    const errorsByProvider: Record<string, number> = {};

    this.errors.forEach(error => {
      errorsByType[error.type] = (errorsByType[error.type] || 0) + 1;
      errorsByProvider[error.provider] = (errorsByProvider[error.provider] || 0) + 1;
    });

    // Calculate success rate (simplified - assumes we track successful requests too)
    const totalRequests = this.getTotalRequestCount();
    const successRate = totalRequests > 0 ? (totalRequests - totalErrors) / totalRequests : 1;

    // Calculate average latency from provider metrics
    const averageLatency = this.calculateAverageLatency();

    return {
      totalErrors,
      errorsByType,
      errorsByProvider,
      successRate: Math.max(0, Math.min(1, successRate)),
      averageLatency,
      lastUpdated: now,
    };
  }

  /**
   * Get errors by type
   */
  getErrorsByType(errorType: string): APIError[] {
    return this.errors.filter(error => error.type === errorType);
  }

  /**
   * Get errors by provider
   */
  getErrorsByProvider(providerId: string): APIError[] {
    return this.errors.filter(error => error.provider === providerId);
  }

  /**
   * Clear all error history
   */
  clearErrors(): void {
    this.errors = [];
    this.errorTrends = [];
    this.providerMetrics.clear();
  }

  /**
   * Export error logs as JSON string
   */
  exportErrorLogs(): string {
    const exportData = {
      errors: this.errors,
      trends: this.errorTrends,
      metrics: Array.from(this.providerMetrics.entries()).map(([id, metrics]) => ({
        providerId: id,
        ...metrics,
      })),
      exportedAt: new Date(),
    };

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Get error trends over time
   */
  getErrorTrends(timeRange?: { start: Date; end: Date }): ErrorTrend[] {
    let trends = this.errorTrends;

    if (timeRange) {
      trends = trends.filter(trend => 
        trend.timestamp >= timeRange.start && trend.timestamp <= timeRange.end
      );
    }

    return trends.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Analyze error patterns
   */
  analyzeErrorPatterns(): ErrorPattern[] {
    const patterns: Map<string, ErrorPattern> = new Map();

    this.errors.forEach(error => {
      // Extract patterns from error messages
      const messagePatterns = this.extractMessagePatterns(error.message);
      
      messagePatterns.forEach(pattern => {
        const key = `${error.type}:${pattern}`;
        
        if (!patterns.has(key)) {
          patterns.set(key, {
            pattern,
            frequency: 0,
            errorType: error.type,
            providers: [],
            firstSeen: error.timestamp,
            lastSeen: error.timestamp,
            examples: [],
          });
        }

        const patternData = patterns.get(key)!;
        patternData.frequency++;
        patternData.lastSeen = error.timestamp;
        
        if (!patternData.providers.includes(error.provider)) {
          patternData.providers.push(error.provider);
        }
        
        if (patternData.examples.length < 5) {
          patternData.examples.push(error.message);
        }
      });
    });

    return Array.from(patterns.values())
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 20); // Return top 20 patterns
  }

  /**
   * Get provider performance metrics
   */
  getProviderMetrics(providerId?: string): ProviderMetrics[] {
    if (providerId) {
      const metrics = this.providerMetrics.get(providerId);
      return metrics ? [metrics] : [];
    }

    return Array.from(this.providerMetrics.values())
      .sort((a, b) => b.totalErrors - a.totalErrors);
  }

  /**
   * Get error statistics for a time period
   */
  getErrorStatistics(timeRange: { start: Date; end: Date }): {
    totalErrors: number;
    errorsByHour: Record<string, number>;
    topErrorTypes: Array<{ type: ErrorType; count: number }>;
    topProviders: Array<{ provider: string; count: number }>;
  } {
    const errorsInRange = this.errors.filter(error => 
      error.timestamp >= timeRange.start && error.timestamp <= timeRange.end
    );

    const errorsByHour: Record<string, number> = {};
    const errorTypeCount: Record<ErrorType, number> = {} as any;
    const providerCount: Record<string, number> = {};

    errorsInRange.forEach(error => {
      // Group by hour
      const hour = new Date(error.timestamp);
      hour.setMinutes(0, 0, 0);
      const hourKey = hour.toISOString();
      errorsByHour[hourKey] = (errorsByHour[hourKey] || 0) + 1;

      // Count by type
      errorTypeCount[error.type] = (errorTypeCount[error.type] || 0) + 1;

      // Count by provider
      providerCount[error.provider] = (providerCount[error.provider] || 0) + 1;
    });

    const topErrorTypes = Object.entries(errorTypeCount)
      .map(([type, count]) => ({ type: type as ErrorType, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topProviders = Object.entries(providerCount)
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalErrors: errorsInRange.length,
      errorsByHour,
      topErrorTypes,
      topProviders,
    };
  }

  /**
   * Generate error report
   */
  generateErrorReport(timeRange?: { start: Date; end: Date }): string {
    const analytics = this.getAnalytics();
    const patterns = this.analyzeErrorPatterns();
    const metrics = this.getProviderMetrics();

    let report = '# API Compatibility Error Report\n\n';
    report += `Generated at: ${new Date().toISOString()}\n\n`;

    // Overall statistics
    report += '## Overall Statistics\n\n';
    report += `- Total Errors: ${analytics.totalErrors}\n`;
    report += `- Success Rate: ${(analytics.successRate * 100).toFixed(2)}%\n`;
    report += `- Average Latency: ${analytics.averageLatency.toFixed(2)}ms\n\n`;

    // Errors by type
    report += '## Errors by Type\n\n';
    Object.entries(analytics.errorsByType)
      .sort(([, a], [, b]) => b - a)
      .forEach(([type, count]) => {
        const percentage = ((count / analytics.totalErrors) * 100).toFixed(1);
        report += `- ${type}: ${count} (${percentage}%)\n`;
      });
    report += '\n';

    // Errors by provider
    report += '## Errors by Provider\n\n';
    Object.entries(analytics.errorsByProvider)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .forEach(([provider, count]) => {
        const percentage = ((count / analytics.totalErrors) * 100).toFixed(1);
        report += `- ${provider}: ${count} (${percentage}%)\n`;
      });
    report += '\n';

    // Top error patterns
    report += '## Top Error Patterns\n\n';
    patterns.slice(0, 10).forEach((pattern, index) => {
      report += `${index + 1}. **${pattern.errorType}**: ${pattern.pattern}\n`;
      report += `   - Frequency: ${pattern.frequency}\n`;
      report += `   - Providers: ${pattern.providers.join(', ')}\n`;
      report += `   - First seen: ${pattern.firstSeen.toISOString()}\n`;
      report += `   - Last seen: ${pattern.lastSeen.toISOString()}\n\n`;
    });

    // Provider performance
    report += '## Provider Performance\n\n';
    metrics.slice(0, 10).forEach(metric => {
      report += `### ${metric.providerId}\n`;
      report += `- Error Rate: ${(metric.errorRate * 100).toFixed(2)}%\n`;
      report += `- Total Errors: ${metric.totalErrors}\n`;
      report += `- Average Latency: ${metric.averageLatency.toFixed(2)}ms\n`;
      report += `- Last Updated: ${metric.lastUpdated.toISOString()}\n\n`;
    });

    return report;
  }

  private updateErrorTrends(error: APIError): void {
    const now = new Date();
    const hourKey = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());

    // Find or create trend entry for this hour
    let trend = this.errorTrends.find(t => 
      t.timestamp.getTime() === hourKey.getTime() &&
      t.errorType === error.type &&
      t.provider === error.provider
    );

    if (!trend) {
      trend = {
        timestamp: hourKey,
        errorType: error.type,
        provider: error.provider,
        count: 0,
      };
      this.errorTrends.push(trend);
    }

    trend.count++;

    // Maintain trend history limit
    if (this.errorTrends.length > this.maxTrendHistory) {
      this.errorTrends.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      this.errorTrends.splice(0, this.errorTrends.length - this.maxTrendHistory);
    }
  }

  private updateProviderMetrics(error: APIError): void {
    if (!this.providerMetrics.has(error.provider)) {
      this.providerMetrics.set(error.provider, {
        providerId: error.provider,
        totalRequests: 0,
        totalErrors: 0,
        errorRate: 0,
        averageLatency: 0,
        lastUpdated: new Date(),
        errorsByType: {} as Record<ErrorType, number>,
      });
    }

    const metrics = this.providerMetrics.get(error.provider)!;
    metrics.totalErrors++;
    metrics.totalRequests++; // Simplified - in reality, we'd track successful requests separately
    metrics.errorRate = metrics.totalErrors / metrics.totalRequests;
    metrics.lastUpdated = new Date();
    metrics.errorsByType[error.type] = (metrics.errorsByType[error.type] || 0) + 1;

    // Update latency if available
    if (error.networkInfo?.details?.latency) {
      const currentLatency = metrics.averageLatency;
      const newLatency = error.networkInfo.details.latency;
      metrics.averageLatency = (currentLatency + newLatency) / 2;
    }
  }

  private extractMessagePatterns(message: string): string[] {
    const patterns: string[] = [];
    const lowerMessage = message.toLowerCase();

    // Common error patterns
    const commonPatterns = [
      /timeout/i,
      /connection\s+refused/i,
      /not\s+found/i,
      /unauthorized/i,
      /forbidden/i,
      /rate\s+limit/i,
      /quota\s+exceeded/i,
      /invalid\s+request/i,
      /bad\s+request/i,
      /internal\s+server\s+error/i,
      /service\s+unavailable/i,
      /content\s+policy/i,
      /authentication\s+failed/i,
      /certificate/i,
      /ssl/i,
      /tls/i,
    ];

    commonPatterns.forEach(pattern => {
      if (pattern.test(lowerMessage)) {
        patterns.push(pattern.source.replace(/\\s\+/g, ' ').replace(/[\\^$]/g, ''));
      }
    });

    // If no common patterns found, use first few words
    if (patterns.length === 0) {
      const words = lowerMessage.split(/\s+/).slice(0, 3).join(' ');
      if (words.length > 0) {
        patterns.push(words);
      }
    }

    return patterns;
  }

  private getTotalRequestCount(): number {
    // Simplified calculation - in a real implementation, 
    // we would track successful requests separately
    return Array.from(this.providerMetrics.values())
      .reduce((total, metrics) => total + metrics.totalRequests, 0);
  }

  private calculateAverageLatency(): number {
    const metrics = Array.from(this.providerMetrics.values());
    if (metrics.length === 0) return 0;

    const totalLatency = metrics.reduce((sum, metric) => sum + metric.averageLatency, 0);
    return totalLatency / metrics.length;
  }
}