/**
 * Audit Logger
 * Detailed logging system for built-in API services
 * Validates: Requirements 4.5, 7.4
 */

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug' | 'audit';
  category: 'auth' | 'service' | 'request' | 'config' | 'system' | 'security';
  event: string;
  userId?: string;
  serviceId?: string;
  requestId?: string;
  details: Record<string, any>;
  metadata?: {
    userAgent?: string;
    ipAddress?: string;
    sessionId?: string;
    correlationId?: string;
  };
}

export interface LogFilter {
  level?: string[];
  category?: string[];
  userId?: string;
  serviceId?: string;
  startDate?: Date;
  endDate?: Date;
  searchText?: string;
}

export class AuditLogger {
  private logs: AuditLogEntry[] = [];
  private maxLogs: number;
  private logLevel: string;
  private enabledCategories: Set<string>;
  private logCallbacks: ((entry: AuditLogEntry) => void)[] = [];

  constructor(options?: {
    maxLogs?: number;
    logLevel?: string;
    enabledCategories?: string[];
  }) {
    this.maxLogs = options?.maxLogs || 10000;
    this.logLevel = options?.logLevel || 'info';
    this.enabledCategories = new Set(options?.enabledCategories || [
      'auth', 'service', 'request', 'config', 'system', 'security'
    ]);

    // Clean up old logs periodically
    setInterval(() => this.cleanupOldLogs(), 60 * 60 * 1000); // Every hour
  }

  /**
   * Log authentication events
   */
  logAuth(event: string, userId: string, details: Record<string, any>, metadata?: any): void {
    this.log('info', 'auth', event, { userId, ...details }, metadata);
  }

  /**
   * Log service events
   */
  logService(event: string, serviceId: string, details: Record<string, any>, metadata?: any): void {
    this.log('info', 'service', event, { serviceId, ...details }, metadata);
  }

  /**
   * Log request events
   */
  logRequest(
    level: 'info' | 'warn' | 'error',
    event: string,
    requestId: string,
    userId?: string,
    serviceId?: string,
    details?: Record<string, any>,
    metadata?: any
  ): void {
    this.log(level, 'request', event, { 
      requestId, 
      userId, 
      serviceId, 
      ...details 
    }, metadata);
  }

  /**
   * Log configuration changes
   */
  logConfig(event: string, userId: string, details: Record<string, any>, metadata?: any): void {
    this.log('audit', 'config', event, { userId, ...details }, metadata);
  }

  /**
   * Log system events
   */
  logSystem(level: 'info' | 'warn' | 'error', event: string, details: Record<string, any>): void {
    this.log(level, 'system', event, details);
  }

  /**
   * Log security events
   */
  logSecurity(event: string, userId?: string, details?: Record<string, any>, metadata?: any): void {
    this.log('audit', 'security', event, { userId, ...details }, metadata);
  }

  /**
   * Core logging method
   */
  private log(
    level: 'info' | 'warn' | 'error' | 'debug' | 'audit',
    category: 'auth' | 'service' | 'request' | 'config' | 'system' | 'security',
    event: string,
    details: Record<string, any>,
    metadata?: any
  ): void {
    // Check if logging is enabled for this level and category
    if (!this.shouldLog(level, category)) {
      return;
    }

    const entry: AuditLogEntry = {
      id: this.generateLogId(),
      timestamp: new Date(),
      level,
      category,
      event,
      userId: details.userId,
      serviceId: details.serviceId,
      requestId: details.requestId,
      details: this.sanitizeDetails(details),
      metadata: metadata ? this.sanitizeMetadata(metadata) : undefined
    };

    // Add to logs array
    this.logs.push(entry);

    // Maintain max logs limit
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Trigger callbacks
    this.logCallbacks.forEach(callback => {
      try {
        callback(entry);
      } catch (error) {
        console.error('Error in log callback:', error);
      }
    });

    // Console logging
    this.logToConsole(entry);
  }

  /**
   * Check if logging should occur for this level and category
   */
  private shouldLog(level: string, category: string): boolean {
    // Check category filter
    if (!this.enabledCategories.has(category)) {
      return false;
    }

    // Check log level
    const levels = ['debug', 'info', 'warn', 'error', 'audit'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const entryLevelIndex = levels.indexOf(level);

    return entryLevelIndex >= currentLevelIndex;
  }

  /**
   * Sanitize log details to remove sensitive information
   */
  private sanitizeDetails(details: Record<string, any>): Record<string, any> {
    const sanitized = { ...details };
    
    // Remove or mask sensitive fields
    const sensitiveFields = ['password', 'apiKey', 'token', 'secret', 'key'];
    
    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '***REDACTED***';
      }
    }

    // Truncate long strings
    for (const [key, value] of Object.entries(sanitized)) {
      if (typeof value === 'string' && value.length > 1000) {
        sanitized[key] = value.substring(0, 1000) + '...[truncated]';
      }
    }

    return sanitized;
  }

  /**
   * Sanitize metadata
   */
  private sanitizeMetadata(metadata: any): any {
    if (!metadata || typeof metadata !== 'object') {
      return metadata;
    }

    const sanitized = { ...metadata };
    
    // Mask IP addresses (keep first 3 octets)
    if (sanitized.ipAddress) {
      const parts = sanitized.ipAddress.split('.');
      if (parts.length === 4) {
        sanitized.ipAddress = `${parts[0]}.${parts[1]}.${parts[2]}.***`;
      }
    }

    return sanitized;
  }

  /**
   * Log to console with appropriate formatting
   */
  private logToConsole(entry: AuditLogEntry): void {
    const timestamp = entry.timestamp.toISOString();
    const prefix = `[${timestamp}] [${entry.level.toUpperCase()}] [${entry.category.toUpperCase()}]`;
    const message = `${prefix} ${entry.event}`;
    
    const contextInfo = [];
    if (entry.userId) contextInfo.push(`User: ${entry.userId}`);
    if (entry.serviceId) contextInfo.push(`Service: ${entry.serviceId}`);
    if (entry.requestId) contextInfo.push(`Request: ${entry.requestId}`);
    
    const fullMessage = contextInfo.length > 0 ? 
      `${message} | ${contextInfo.join(' | ')}` : message;

    switch (entry.level) {
      case 'error':
        console.error(fullMessage, entry.details);
        break;
      case 'warn':
        console.warn(fullMessage, entry.details);
        break;
      case 'audit':
        console.log(`🔍 ${fullMessage}`, entry.details);
        break;
      case 'debug':
        console.debug(fullMessage, entry.details);
        break;
      default:
        console.log(fullMessage, entry.details);
    }
  }

  /**
   * Generate unique log ID
   */
  private generateLogId(): string {
    return `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clean up old logs
   */
  private cleanupOldLogs(): void {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const oldCount = this.logs.length;
    
    // Keep logs from last 24 hours or last 1000 logs, whichever is more
    this.logs = this.logs.filter(log => 
      log.timestamp > oneDayAgo || this.logs.indexOf(log) >= this.logs.length - 1000
    );

    const cleanedCount = oldCount - this.logs.length;
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} old audit logs`);
    }
  }

  /**
   * Query logs with filters
   */
  queryLogs(filter?: LogFilter, limit?: number): AuditLogEntry[] {
    let filteredLogs = [...this.logs];

    if (filter) {
      // Filter by level
      if (filter.level && filter.level.length > 0) {
        filteredLogs = filteredLogs.filter(log => filter.level!.includes(log.level));
      }

      // Filter by category
      if (filter.category && filter.category.length > 0) {
        filteredLogs = filteredLogs.filter(log => filter.category!.includes(log.category));
      }

      // Filter by user ID
      if (filter.userId) {
        filteredLogs = filteredLogs.filter(log => log.userId === filter.userId);
      }

      // Filter by service ID
      if (filter.serviceId) {
        filteredLogs = filteredLogs.filter(log => log.serviceId === filter.serviceId);
      }

      // Filter by date range
      if (filter.startDate) {
        filteredLogs = filteredLogs.filter(log => log.timestamp >= filter.startDate!);
      }

      if (filter.endDate) {
        filteredLogs = filteredLogs.filter(log => log.timestamp <= filter.endDate!);
      }

      // Filter by search text
      if (filter.searchText) {
        const searchLower = filter.searchText.toLowerCase();
        filteredLogs = filteredLogs.filter(log => 
          log.event.toLowerCase().includes(searchLower) ||
          JSON.stringify(log.details).toLowerCase().includes(searchLower)
        );
      }
    }

    // Sort by timestamp (newest first)
    filteredLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Apply limit
    if (limit && limit > 0) {
      filteredLogs = filteredLogs.slice(0, limit);
    }

    return filteredLogs;
  }

  /**
   * Get log statistics
   */
  getLogStatistics(timeRange?: { start: Date; end: Date }): {
    totalLogs: number;
    logsByLevel: { [level: string]: number };
    logsByCategory: { [category: string]: number };
    recentErrors: AuditLogEntry[];
    topUsers: { userId: string; count: number }[];
    topServices: { serviceId: string; count: number }[];
  } {
    let logs = this.logs;

    if (timeRange) {
      logs = logs.filter(log => 
        log.timestamp >= timeRange.start && log.timestamp <= timeRange.end
      );
    }

    // Count by level
    const logsByLevel: { [level: string]: number } = {};
    logs.forEach(log => {
      logsByLevel[log.level] = (logsByLevel[log.level] || 0) + 1;
    });

    // Count by category
    const logsByCategory: { [category: string]: number } = {};
    logs.forEach(log => {
      logsByCategory[log.category] = (logsByCategory[log.category] || 0) + 1;
    });

    // Get recent errors
    const recentErrors = logs
      .filter(log => log.level === 'error')
      .slice(0, 10);

    // Get top users
    const userCounts = new Map<string, number>();
    logs.forEach(log => {
      if (log.userId) {
        userCounts.set(log.userId, (userCounts.get(log.userId) || 0) + 1);
      }
    });
    const topUsers = Array.from(userCounts.entries())
      .map(([userId, count]) => ({ userId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Get top services
    const serviceCounts = new Map<string, number>();
    logs.forEach(log => {
      if (log.serviceId) {
        serviceCounts.set(log.serviceId, (serviceCounts.get(log.serviceId) || 0) + 1);
      }
    });
    const topServices = Array.from(serviceCounts.entries())
      .map(([serviceId, count]) => ({ serviceId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalLogs: logs.length,
      logsByLevel,
      logsByCategory,
      recentErrors,
      topUsers,
      topServices
    };
  }

  /**
   * Export logs for external analysis
   */
  exportLogs(filter?: LogFilter): {
    logs: AuditLogEntry[];
    exportedAt: Date;
    filter?: LogFilter;
  } {
    const logs = this.queryLogs(filter);
    
    // Remove sensitive data from export
    const sanitizedLogs = logs.map(log => ({
      ...log,
      id: log.id.replace(/log-\d+-/, 'log-***-'),
      userId: log.userId ? log.userId.replace(/.{3}$/, '***') : undefined,
      details: this.sanitizeDetails(log.details)
    }));

    return {
      logs: sanitizedLogs,
      exportedAt: new Date(),
      filter
    };
  }

  /**
   * Add log callback
   */
  onLog(callback: (entry: AuditLogEntry) => void): void {
    this.logCallbacks.push(callback);
  }

  /**
   * Remove log callback
   */
  removeLogCallback(callback: (entry: AuditLogEntry) => void): void {
    const index = this.logCallbacks.indexOf(callback);
    if (index > -1) {
      this.logCallbacks.splice(index, 1);
    }
  }

  /**
   * Update logging configuration
   */
  updateConfig(config: {
    logLevel?: string;
    enabledCategories?: string[];
    maxLogs?: number;
  }): void {
    if (config.logLevel) {
      this.logLevel = config.logLevel;
    }

    if (config.enabledCategories) {
      this.enabledCategories = new Set(config.enabledCategories);
    }

    if (config.maxLogs) {
      this.maxLogs = config.maxLogs;
      
      // Trim logs if necessary
      if (this.logs.length > this.maxLogs) {
        this.logs = this.logs.slice(-this.maxLogs);
      }
    }

    console.log('Updated audit logger configuration:', {
      logLevel: this.logLevel,
      enabledCategories: Array.from(this.enabledCategories),
      maxLogs: this.maxLogs
    });
  }

  /**
   * Clear all logs
   */
  clearLogs(): void {
    const count = this.logs.length;
    this.logs = [];
    console.log(`🗑️ Cleared ${count} audit logs`);
  }

  /**
   * Get current configuration
   */
  getConfig(): {
    logLevel: string;
    enabledCategories: string[];
    maxLogs: number;
    currentLogCount: number;
  } {
    return {
      logLevel: this.logLevel,
      enabledCategories: Array.from(this.enabledCategories),
      maxLogs: this.maxLogs,
      currentLogCount: this.logs.length
    };
  }
}

// Global audit logger instance
let globalAuditLogger: AuditLogger | null = null;

export function getAuditLogger(): AuditLogger {
  if (!globalAuditLogger) {
    globalAuditLogger = new AuditLogger({
      maxLogs: 10000,
      logLevel: 'info',
      enabledCategories: ['auth', 'service', 'request', 'config', 'system', 'security']
    });

    // Set up integration with diagnostics system
    globalAuditLogger.onLog((entry) => {
      // Only log errors and security events to diagnostics
      if (entry.level === 'error' || entry.category === 'security') {
        // Import recordFailureLog dynamically to avoid circular dependencies
        import('../../diagnostics').then(({ recordFailureLog }) => {
          recordFailureLog({
            provider: 'built-in-audit-logger',
            operation: entry.event,
            url: 'internal://audit-logger',
            status: null,
            requestBody: { 
              category: entry.category, 
              level: entry.level,
              userId: entry.userId,
              serviceId: entry.serviceId
            },
            responseBody: JSON.stringify(entry.details)
          });
        }).catch((error) => {
          console.error('Failed to log to diagnostics system:', error);
        });
      }
    });
  }

  return globalAuditLogger;
}

export function resetAuditLogger(): void {
  globalAuditLogger = null;
}

// Convenience functions for common logging scenarios
export function logUserAuth(userId: string, event: string, success: boolean, details?: any): void {
  const logger = getAuditLogger();
  logger.logAuth(`user_auth_${event}`, userId, {
    success,
    ...details
  });
}

export function logServiceAccess(userId: string, serviceId: string, event: string, success: boolean, details?: any): void {
  const logger = getAuditLogger();
  logger.logService(`service_access_${event}`, serviceId, {
    userId,
    success,
    ...details
  });
}

export function logConfigChange(userId: string, configType: string, changes: any): void {
  const logger = getAuditLogger();
  logger.logConfig(`config_change_${configType}`, userId, {
    changes,
    timestamp: new Date().toISOString()
  });
}

export function logSecurityEvent(event: string, userId?: string, details?: any): void {
  const logger = getAuditLogger();
  logger.logSecurity(`security_${event}`, userId, {
    severity: 'high',
    ...details
  });
}

export function logAPIRequest(
  requestId: string,
  userId: string,
  serviceId: string,
  success: boolean,
  responseTime: number,
  details?: any
): void {
  const logger = getAuditLogger();
  logger.logRequest(
    success ? 'info' : 'error',
    'api_request_completed',
    requestId,
    userId,
    serviceId,
    {
      success,
      responseTime,
      ...details
    }
  );
}