/**
 * Performance Monitor
 * Comprehensive performance monitoring for built-in API services
 * Validates: Requirements 6.5, 7.2
 */

import { recordFailureLog } from '../../diagnostics';

export interface PerformanceMetrics {
  requestId: string;
  userId: string;
  serviceId: string;
  timestamp: Date;
  
  // Timing metrics
  totalTime: number;
  authTime: number;
  proxyTime: number;
  responseTime: number;
  
  // Resource metrics
  memoryUsage: number;
  cpuUsage?: number;
  
  // Request metrics
  requestSize: number;
  responseSize: number;
  
  // Status
  success: boolean;
  errorType?: string;
  statusCode?: number;
}

export interface SystemHealthMetrics {
  timestamp: Date;
  
  // Service health
  activeServices: number;
  healthyServices: number;
  unhealthyServices: number;
  
  // Request metrics
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  
  // Resource usage
  memoryUsage: number;
  activeConnections: number;
  
  // Error rates
  errorRate: number;
  timeoutRate: number;
  
  // Performance thresholds
  slowRequestCount: number; // Requests > 5s
  verySlowRequestCount: number; // Requests > 10s
}

export interface AlertThresholds {
  maxResponseTime: number; // ms
  maxErrorRate: number; // percentage
  maxMemoryUsage: number; // MB
  maxActiveRequests: number;
  minSuccessRate: number; // percentage
}

export class PerformanceMonitor {
  private metrics: PerformanceMetrics[] = [];
  private systemHealthHistory: SystemHealthMetrics[] = [];
  private alertThresholds: AlertThresholds;
  private alertCallbacks: ((alert: PerformanceAlert) => void)[] = [];
  
  // Performance tracking
  private activeRequests = new Map<string, {
    startTime: number;
    authStartTime?: number;
    proxyStartTime?: number;
    userId: string;
    serviceId: string;
  }>();
  
  constructor(thresholds?: Partial<AlertThresholds>) {
    this.alertThresholds = {
      maxResponseTime: 10000, // 10 seconds
      maxErrorRate: 10, // 10%
      maxMemoryUsage: 512, // 512 MB
      maxActiveRequests: 100,
      minSuccessRate: 95, // 95%
      ...thresholds
    };
    
    // Start system health monitoring
    this.startSystemHealthMonitoring();
    
    // Clean up old metrics periodically
    setInterval(() => this.cleanupOldMetrics(), 60 * 60 * 1000); // Every hour
  }

  /**
   * Start tracking a request
   */
  startRequest(requestId: string, userId: string, serviceId: string): void {
    this.activeRequests.set(requestId, {
      startTime: Date.now(),
      userId,
      serviceId
    });
  }

  /**
   * Mark authentication phase start
   */
  startAuth(requestId: string): void {
    const request = this.activeRequests.get(requestId);
    if (request) {
      request.authStartTime = Date.now();
    }
  }

  /**
   * Mark proxy phase start
   */
  startProxy(requestId: string): void {
    const request = this.activeRequests.get(requestId);
    if (request) {
      request.proxyStartTime = Date.now();
    }
  }

  /**
   * Complete request tracking
   */
  completeRequest(
    requestId: string,
    success: boolean,
    requestSize: number,
    responseSize: number,
    errorType?: string,
    statusCode?: number
  ): void {
    const request = this.activeRequests.get(requestId);
    if (!request) {
      console.warn(`Request ${requestId} not found in active requests`);
      return;
    }

    const endTime = Date.now();
    const totalTime = endTime - request.startTime;
    const authTime = request.authStartTime ? 
      (request.proxyStartTime || endTime) - request.authStartTime : 0;
    const proxyTime = request.proxyStartTime ? 
      endTime - request.proxyStartTime : 0;

    const metrics: PerformanceMetrics = {
      requestId,
      userId: request.userId,
      serviceId: request.serviceId,
      timestamp: new Date(),
      totalTime,
      authTime,
      proxyTime,
      responseTime: totalTime,
      memoryUsage: this.getCurrentMemoryUsage(),
      requestSize,
      responseSize,
      success,
      errorType,
      statusCode
    };

    this.metrics.push(metrics);
    this.activeRequests.delete(requestId);

    // Check for performance alerts
    this.checkPerformanceAlerts(metrics);

    // Log performance metrics
    this.logPerformanceMetrics(metrics);

    // Keep only recent metrics (last 10000)
    if (this.metrics.length > 10000) {
      this.metrics = this.metrics.slice(-10000);
    }
  }

  /**
   * Get current memory usage in MB
   */
  private getCurrentMemoryUsage(): number {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      const usage = process.memoryUsage();
      return Math.round(usage.heapUsed / 1024 / 1024);
    }
    return 0;
  }

  /**
   * Log performance metrics
   */
  private logPerformanceMetrics(metrics: PerformanceMetrics): void {
    const { requestId, userId, serviceId, totalTime, success, errorType } = metrics;
    
    if (success) {
      console.log(`📊 Performance: ${requestId} | User: ${userId} | Service: ${serviceId} | Time: ${totalTime}ms | ✅ SUCCESS`);
    } else {
      console.error(`📊 Performance: ${requestId} | User: ${userId} | Service: ${serviceId} | Time: ${totalTime}ms | ❌ FAILED (${errorType})`);
    }

    // Log detailed timing breakdown for slow requests
    if (totalTime > 5000) {
      console.warn(`🐌 Slow Request: ${requestId} | Total: ${totalTime}ms | Auth: ${metrics.authTime}ms | Proxy: ${metrics.proxyTime}ms`);
    }

    // Log memory usage warnings
    if (metrics.memoryUsage > this.alertThresholds.maxMemoryUsage * 0.8) {
      console.warn(`🧠 High Memory Usage: ${metrics.memoryUsage}MB (${requestId})`);
    }
  }

  /**
   * Check for performance alerts
   */
  private checkPerformanceAlerts(metrics: PerformanceMetrics): void {
    const alerts: PerformanceAlert[] = [];

    // Response time alert
    if (metrics.totalTime > this.alertThresholds.maxResponseTime) {
      alerts.push({
        type: 'high_response_time',
        severity: 'warning',
        message: `High response time: ${metrics.totalTime}ms (threshold: ${this.alertThresholds.maxResponseTime}ms)`,
        metrics,
        timestamp: new Date()
      });
    }

    // Memory usage alert
    if (metrics.memoryUsage > this.alertThresholds.maxMemoryUsage) {
      alerts.push({
        type: 'high_memory_usage',
        severity: 'critical',
        message: `High memory usage: ${metrics.memoryUsage}MB (threshold: ${this.alertThresholds.maxMemoryUsage}MB)`,
        metrics,
        timestamp: new Date()
      });
    }

    // Error alert
    if (!metrics.success) {
      alerts.push({
        type: 'request_error',
        severity: 'error',
        message: `Request failed: ${metrics.errorType || 'Unknown error'}`,
        metrics,
        timestamp: new Date()
      });
    }

    // Trigger alert callbacks
    alerts.forEach(alert => {
      this.alertCallbacks.forEach(callback => {
        try {
          callback(alert);
        } catch (error) {
          console.error('Error in alert callback:', error);
        }
      });
    });
  }

  /**
   * Start system health monitoring
   */
  private startSystemHealthMonitoring(): void {
    setInterval(() => {
      this.collectSystemHealthMetrics();
    }, 60000); // Every minute
  }

  /**
   * Collect system health metrics
   */
  private collectSystemHealthMetrics(): void {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const recentMetrics = this.metrics.filter(m => m.timestamp > oneHourAgo);

    const totalRequests = recentMetrics.length;
    const successfulRequests = recentMetrics.filter(m => m.success).length;
    const failedRequests = totalRequests - successfulRequests;
    
    const totalResponseTime = recentMetrics.reduce((sum, m) => sum + m.totalTime, 0);
    const averageResponseTime = totalRequests > 0 ? totalResponseTime / totalRequests : 0;
    
    const errorRate = totalRequests > 0 ? (failedRequests / totalRequests) * 100 : 0;
    const timeoutRequests = recentMetrics.filter(m => m.totalTime > 30000).length;
    const timeoutRate = totalRequests > 0 ? (timeoutRequests / totalRequests) * 100 : 0;
    
    const slowRequests = recentMetrics.filter(m => m.totalTime > 5000).length;
    const verySlowRequests = recentMetrics.filter(m => m.totalTime > 10000).length;

    const healthMetrics: SystemHealthMetrics = {
      timestamp: now,
      activeServices: 0, // Will be updated by service manager
      healthyServices: 0, // Will be updated by service manager
      unhealthyServices: 0, // Will be updated by service manager
      totalRequests,
      successfulRequests,
      failedRequests,
      averageResponseTime,
      memoryUsage: this.getCurrentMemoryUsage(),
      activeConnections: this.activeRequests.size,
      errorRate,
      timeoutRate,
      slowRequestCount: slowRequests,
      verySlowRequestCount: verySlowRequests
    };

    this.systemHealthHistory.push(healthMetrics);

    // Keep only recent health history (last 24 hours)
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    this.systemHealthHistory = this.systemHealthHistory.filter(h => h.timestamp > oneDayAgo);

    // Check system health alerts
    this.checkSystemHealthAlerts(healthMetrics);

    // Log system health
    console.log(`🏥 System Health: Requests: ${totalRequests}, Success Rate: ${(100 - errorRate).toFixed(1)}%, Avg Response: ${averageResponseTime.toFixed(0)}ms, Memory: ${healthMetrics.memoryUsage}MB`);
  }

  /**
   * Check system health alerts
   */
  private checkSystemHealthAlerts(health: SystemHealthMetrics): void {
    const alerts: PerformanceAlert[] = [];

    // Error rate alert
    if (health.errorRate > this.alertThresholds.maxErrorRate) {
      alerts.push({
        type: 'high_error_rate',
        severity: 'critical',
        message: `High error rate: ${health.errorRate.toFixed(1)}% (threshold: ${this.alertThresholds.maxErrorRate}%)`,
        systemHealth: health,
        timestamp: new Date()
      });
    }

    // Success rate alert
    const successRate = health.totalRequests > 0 ? 
      (health.successfulRequests / health.totalRequests) * 100 : 100;
    if (successRate < this.alertThresholds.minSuccessRate) {
      alerts.push({
        type: 'low_success_rate',
        severity: 'critical',
        message: `Low success rate: ${successRate.toFixed(1)}% (threshold: ${this.alertThresholds.minSuccessRate}%)`,
        systemHealth: health,
        timestamp: new Date()
      });
    }

    // Active requests alert
    if (health.activeConnections > this.alertThresholds.maxActiveRequests) {
      alerts.push({
        type: 'high_active_requests',
        severity: 'warning',
        message: `High active requests: ${health.activeConnections} (threshold: ${this.alertThresholds.maxActiveRequests})`,
        systemHealth: health,
        timestamp: new Date()
      });
    }

    // System memory alert
    if (health.memoryUsage > this.alertThresholds.maxMemoryUsage) {
      alerts.push({
        type: 'high_system_memory',
        severity: 'critical',
        message: `High system memory usage: ${health.memoryUsage}MB (threshold: ${this.alertThresholds.maxMemoryUsage}MB)`,
        systemHealth: health,
        timestamp: new Date()
      });
    }

    // Trigger alert callbacks
    alerts.forEach(alert => {
      this.alertCallbacks.forEach(callback => {
        try {
          callback(alert);
        } catch (error) {
          console.error('Error in system health alert callback:', error);
        }
      });
    });
  }

  /**
   * Clean up old metrics
   */
  private cleanupOldMetrics(): void {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const oldMetricsCount = this.metrics.length;
    this.metrics = this.metrics.filter(m => m.timestamp > oneDayAgo);
    
    const oldHealthCount = this.systemHealthHistory.length;
    this.systemHealthHistory = this.systemHealthHistory.filter(h => h.timestamp > oneDayAgo);

    console.log(`🧹 Cleaned up metrics: ${oldMetricsCount - this.metrics.length} performance metrics, ${oldHealthCount - this.systemHealthHistory.length} health records`);
  }

  /**
   * Get performance statistics
   */
  getPerformanceStatistics(timeRange?: { start: Date; end: Date }): {
    totalRequests: number;
    successRate: number;
    averageResponseTime: number;
    medianResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    errorBreakdown: { [errorType: string]: number };
    slowestRequests: PerformanceMetrics[];
    memoryUsageStats: {
      average: number;
      peak: number;
      current: number;
    };
  } {
    let metrics = this.metrics;
    
    if (timeRange) {
      metrics = metrics.filter(m => 
        m.timestamp >= timeRange.start && m.timestamp <= timeRange.end
      );
    }

    const totalRequests = metrics.length;
    const successfulRequests = metrics.filter(m => m.success).length;
    const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;

    // Response time statistics
    const responseTimes = metrics.map(m => m.totalTime).sort((a, b) => a - b);
    const averageResponseTime = responseTimes.length > 0 ? 
      responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length : 0;
    
    const medianResponseTime = responseTimes.length > 0 ? 
      responseTimes[Math.floor(responseTimes.length / 2)] : 0;
    
    const p95Index = Math.floor(responseTimes.length * 0.95);
    const p95ResponseTime = responseTimes.length > 0 ? responseTimes[p95Index] || 0 : 0;
    
    const p99Index = Math.floor(responseTimes.length * 0.99);
    const p99ResponseTime = responseTimes.length > 0 ? responseTimes[p99Index] || 0 : 0;

    // Error breakdown
    const errorBreakdown: { [errorType: string]: number } = {};
    metrics.filter(m => !m.success).forEach(m => {
      const errorType = m.errorType || 'Unknown';
      errorBreakdown[errorType] = (errorBreakdown[errorType] || 0) + 1;
    });

    // Slowest requests
    const slowestRequests = metrics
      .sort((a, b) => b.totalTime - a.totalTime)
      .slice(0, 10);

    // Memory usage statistics
    const memoryUsages = metrics.map(m => m.memoryUsage);
    const averageMemory = memoryUsages.length > 0 ? 
      memoryUsages.reduce((sum, mem) => sum + mem, 0) / memoryUsages.length : 0;
    const peakMemory = memoryUsages.length > 0 ? Math.max(...memoryUsages) : 0;
    const currentMemory = this.getCurrentMemoryUsage();

    return {
      totalRequests,
      successRate,
      averageResponseTime,
      medianResponseTime,
      p95ResponseTime,
      p99ResponseTime,
      errorBreakdown,
      slowestRequests,
      memoryUsageStats: {
        average: averageMemory,
        peak: peakMemory,
        current: currentMemory
      }
    };
  }

  /**
   * Get system health status
   */
  getSystemHealthStatus(): {
    status: 'healthy' | 'warning' | 'critical';
    currentHealth: SystemHealthMetrics | null;
    healthTrend: 'improving' | 'stable' | 'degrading';
    alerts: PerformanceAlert[];
    uptime: number;
  } {
    const currentHealth = this.systemHealthHistory[this.systemHealthHistory.length - 1] || null;
    
    if (!currentHealth) {
      return {
        status: 'warning',
        currentHealth: null,
        healthTrend: 'stable',
        alerts: [],
        uptime: 0
      };
    }

    // Determine overall status
    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    
    if (currentHealth.errorRate > this.alertThresholds.maxErrorRate ||
        currentHealth.memoryUsage > this.alertThresholds.maxMemoryUsage) {
      status = 'critical';
    } else if (currentHealth.errorRate > this.alertThresholds.maxErrorRate * 0.5 ||
               currentHealth.averageResponseTime > this.alertThresholds.maxResponseTime * 0.5 ||
               currentHealth.activeConnections > this.alertThresholds.maxActiveRequests * 0.8) {
      status = 'warning';
    }

    // Determine health trend
    let healthTrend: 'improving' | 'stable' | 'degrading' = 'stable';
    if (this.systemHealthHistory.length >= 2) {
      const previousHealth = this.systemHealthHistory[this.systemHealthHistory.length - 2];
      const errorRateDiff = currentHealth.errorRate - previousHealth.errorRate;
      const responseTimeDiff = currentHealth.averageResponseTime - previousHealth.averageResponseTime;
      
      if (errorRateDiff < -1 && responseTimeDiff < -100) {
        healthTrend = 'improving';
      } else if (errorRateDiff > 1 || responseTimeDiff > 100) {
        healthTrend = 'degrading';
      }
    }

    // Calculate uptime (simplified - time since first health record)
    const firstHealth = this.systemHealthHistory[0];
    const uptime = firstHealth ? 
      Date.now() - firstHealth.timestamp.getTime() : 0;

    return {
      status,
      currentHealth,
      healthTrend,
      alerts: [], // Would contain recent alerts in a real implementation
      uptime
    };
  }

  /**
   * Add alert callback
   */
  onAlert(callback: (alert: PerformanceAlert) => void): void {
    this.alertCallbacks.push(callback);
  }

  /**
   * Remove alert callback
   */
  removeAlert(callback: (alert: PerformanceAlert) => void): void {
    const index = this.alertCallbacks.indexOf(callback);
    if (index > -1) {
      this.alertCallbacks.splice(index, 1);
    }
  }

  /**
   * Update alert thresholds
   */
  updateAlertThresholds(thresholds: Partial<AlertThresholds>): void {
    this.alertThresholds = { ...this.alertThresholds, ...thresholds };
    console.log('Updated alert thresholds:', this.alertThresholds);
  }

  /**
   * Export performance data
   */
  exportPerformanceData(timeRange?: { start: Date; end: Date }): {
    metrics: PerformanceMetrics[];
    systemHealth: SystemHealthMetrics[];
    exportedAt: Date;
  } {
    let metrics = this.metrics;
    let systemHealth = this.systemHealthHistory;
    
    if (timeRange) {
      metrics = metrics.filter(m => 
        m.timestamp >= timeRange.start && m.timestamp <= timeRange.end
      );
      systemHealth = systemHealth.filter(h => 
        h.timestamp >= timeRange.start && h.timestamp <= timeRange.end
      );
    }

    return {
      metrics: metrics.map(m => ({
        ...m,
        // Remove sensitive data
        requestId: m.requestId.replace(/proxy-\d+-/, 'proxy-***-'),
        userId: m.userId.replace(/.{3}$/, '***')
      })),
      systemHealth,
      exportedAt: new Date()
    };
  }

  /**
   * Get real-time metrics
   */
  getRealTimeMetrics(): {
    activeRequests: number;
    currentMemoryUsage: number;
    recentRequestRate: number; // requests per minute
    recentErrorRate: number;
    recentAverageResponseTime: number;
  } {
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
    const recentMetrics = this.metrics.filter(m => m.timestamp > oneMinuteAgo);

    const recentRequestRate = recentMetrics.length;
    const recentErrors = recentMetrics.filter(m => !m.success).length;
    const recentErrorRate = recentMetrics.length > 0 ? 
      (recentErrors / recentMetrics.length) * 100 : 0;
    
    const recentTotalTime = recentMetrics.reduce((sum, m) => sum + m.totalTime, 0);
    const recentAverageResponseTime = recentMetrics.length > 0 ? 
      recentTotalTime / recentMetrics.length : 0;

    return {
      activeRequests: this.activeRequests.size,
      currentMemoryUsage: this.getCurrentMemoryUsage(),
      recentRequestRate,
      recentErrorRate,
      recentAverageResponseTime
    };
  }
}

export interface PerformanceAlert {
  type: 'high_response_time' | 'high_memory_usage' | 'request_error' | 
        'high_error_rate' | 'low_success_rate' | 'high_active_requests' | 'high_system_memory';
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  timestamp: Date;
  metrics?: PerformanceMetrics;
  systemHealth?: SystemHealthMetrics;
}

// Global performance monitor instance
let globalPerformanceMonitor: PerformanceMonitor | null = null;

export function getPerformanceMonitor(): PerformanceMonitor {
  if (!globalPerformanceMonitor) {
    globalPerformanceMonitor = new PerformanceMonitor();
    
    // Set up default alert handlers
    globalPerformanceMonitor.onAlert((alert) => {
      // Log to diagnostics system
      recordFailureLog({
        provider: 'built-in-performance-monitor',
        operation: 'performance-alert',
        url: 'internal://performance-monitor',
        status: null,
        requestBody: { alertType: alert.type, severity: alert.severity },
        responseBody: alert.message
      });

      // Log to console based on severity
      switch (alert.severity) {
        case 'critical':
          console.error(`🚨 CRITICAL ALERT: ${alert.message}`);
          break;
        case 'error':
          console.error(`❌ ERROR ALERT: ${alert.message}`);
          break;
        case 'warning':
          console.warn(`⚠️ WARNING ALERT: ${alert.message}`);
          break;
        case 'info':
          console.info(`ℹ️ INFO ALERT: ${alert.message}`);
          break;
      }
    });
  }
  
  return globalPerformanceMonitor;
}

export function resetPerformanceMonitor(): void {
  globalPerformanceMonitor = null;
}