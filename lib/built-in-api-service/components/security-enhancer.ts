/**
 * Security Enhancer for Built-in API Service
 * Implements additional security measures and protection mechanisms
 * Validates: Requirements 2.5, 3.3
 */

import { logSecurityEvent } from './audit-logger';

export interface SecurityConfig {
  maxRequestsPerMinute: number;
  maxRequestsPerHour: number;
  maxRequestsPerDay: number;
  maxPromptLength: number;
  maxConcurrentRequests: number;
  suspiciousPatternThreshold: number;
  ipWhitelist?: string[];
  userAgentBlacklist?: string[];
  enableRateLimiting: boolean;
  enableAnomalyDetection: boolean;
  enableInputSanitization: boolean;
}

export interface RateLimitEntry {
  userId: string;
  requests: number;
  firstRequest: Date;
  lastRequest: Date;
  blocked: boolean;
  blockReason?: string;
}

export interface SecurityThreat {
  type: 'rate_limit' | 'suspicious_pattern' | 'invalid_input' | 'unauthorized_access' | 'anomaly';
  severity: 'low' | 'medium' | 'high' | 'critical';
  userId?: string;
  details: any;
  timestamp: Date;
  blocked: boolean;
  action: string;
}

export class SecurityEnhancer {
  private rateLimitMap = new Map<string, RateLimitEntry>();
  private suspiciousPatterns: RegExp[] = [];
  private securityThreats: SecurityThreat[] = [];
  private blockedUsers = new Set<string>();
  private blockedIPs = new Set<string>();
  
  private config: SecurityConfig;
  private cleanupInterval: NodeJS.Timeout;

  constructor(config?: Partial<SecurityConfig>) {
    this.config = {
      maxRequestsPerMinute: 10,
      maxRequestsPerHour: 100,
      maxRequestsPerDay: 500,
      maxPromptLength: 10000,
      maxConcurrentRequests: 5,
      suspiciousPatternThreshold: 3,
      enableRateLimiting: true,
      enableAnomalyDetection: true,
      enableInputSanitization: true,
      ...config
    };

    // Initialize suspicious patterns
    this.initializeSuspiciousPatterns();

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldEntries();
    }, 60 * 1000); // Every minute
  }

  /**
   * Initialize patterns that might indicate malicious activity
   */
  private initializeSuspiciousPatterns(): void {
    this.suspiciousPatterns = [
      // SQL injection patterns
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b)/i,
      
      // Script injection patterns
      /<script[^>]*>.*?<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi,
      
      // Command injection patterns
      /(\||;|&|`|\$\(|\${)/,
      
      // Path traversal patterns
      /\.\.[\/\\]/,
      
      // Excessive repetition (potential DoS)
      /(.)\1{50,}/,
      
      // Suspicious keywords
      /\b(hack|exploit|vulnerability|payload|malware|virus)\b/i,
      
      // Excessive special characters
      /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]{20,}/
    ];
  }

  /**
   * Validate and secure a request
   */
  async validateRequest(request: {
    userId: string;
    serviceId: string;
    prompt: string;
    metadata?: {
      ipAddress?: string;
      userAgent?: string;
      sessionId?: string;
    };
  }): Promise<{
    isValid: boolean;
    reason?: string;
    threat?: SecurityThreat;
    sanitizedPrompt?: string;
  }> {
    try {
      // 1. Check if user is blocked
      if (this.blockedUsers.has(request.userId)) {
        const threat = this.createThreat('unauthorized_access', 'high', request.userId, {
          reason: 'User is blocked',
          userId: request.userId
        }, true, 'Request blocked - user is blacklisted');

        return {
          isValid: false,
          reason: 'User is blocked due to security violations',
          threat
        };
      }

      // 2. Check IP blocking
      if (request.metadata?.ipAddress && this.blockedIPs.has(request.metadata.ipAddress)) {
        const threat = this.createThreat('unauthorized_access', 'high', request.userId, {
          reason: 'IP address is blocked',
          ipAddress: request.metadata.ipAddress
        }, true, 'Request blocked - IP is blacklisted');

        return {
          isValid: false,
          reason: 'IP address is blocked due to security violations',
          threat
        };
      }

      // 3. Rate limiting
      if (this.config.enableRateLimiting) {
        const rateLimitResult = this.checkRateLimit(request.userId);
        if (!rateLimitResult.allowed) {
          const threat = this.createThreat('rate_limit', 'medium', request.userId, {
            reason: rateLimitResult.reason,
            requestCount: rateLimitResult.requestCount,
            timeWindow: rateLimitResult.timeWindow
          }, true, 'Request blocked - rate limit exceeded');

          return {
            isValid: false,
            reason: rateLimitResult.reason,
            threat
          };
        }
      }

      // 4. Input validation and sanitization
      if (this.config.enableInputSanitization) {
        const sanitizationResult = this.sanitizeInput(request.prompt, request.userId);
        if (!sanitizationResult.isValid) {
          return {
            isValid: false,
            reason: sanitizationResult.reason,
            threat: sanitizationResult.threat
          };
        }

        // 5. Suspicious pattern detection
        const patternResult = this.detectSuspiciousPatterns(sanitizationResult.sanitizedPrompt, request.userId);
        if (!patternResult.isValid) {
          return {
            isValid: false,
            reason: patternResult.reason,
            threat: patternResult.threat
          };
        }

        // 6. Anomaly detection
        if (this.config.enableAnomalyDetection) {
          const anomalyResult = this.detectAnomalies(request, sanitizationResult.sanitizedPrompt);
          if (!anomalyResult.isValid) {
            return {
              isValid: false,
              reason: anomalyResult.reason,
              threat: anomalyResult.threat
            };
          }
        }

        return {
          isValid: true,
          sanitizedPrompt: sanitizationResult.sanitizedPrompt
        };
      }

      return { isValid: true };

    } catch (error) {
      console.error('Error in security validation:', error);
      
      const threat = this.createThreat('anomaly', 'high', request.userId, {
        error: error instanceof Error ? error.message : 'Unknown error',
        request: {
          userId: request.userId,
          serviceId: request.serviceId,
          promptLength: request.prompt.length
        }
      }, true, 'Request blocked - security validation error');

      return {
        isValid: false,
        reason: 'Security validation failed',
        threat
      };
    }
  }

  /**
   * Check rate limiting for a user
   */
  private checkRateLimit(userId: string): {
    allowed: boolean;
    reason?: string;
    requestCount?: number;
    timeWindow?: string;
  } {
    const now = new Date();
    let entry = this.rateLimitMap.get(userId);

    if (!entry) {
      // First request for this user
      entry = {
        userId,
        requests: 1,
        firstRequest: now,
        lastRequest: now,
        blocked: false
      };
      this.rateLimitMap.set(userId, entry);
      return { allowed: true };
    }

    // Update last request time
    entry.lastRequest = now;

    // Check different time windows
    const timeSinceFirst = now.getTime() - entry.firstRequest.getTime();
    
    // Per minute check
    if (timeSinceFirst < 60 * 1000) {
      entry.requests++;
      if (entry.requests > this.config.maxRequestsPerMinute) {
        entry.blocked = true;
        entry.blockReason = 'Rate limit exceeded (per minute)';
        
        logSecurityEvent('rate_limit_exceeded', userId, {
          timeWindow: 'minute',
          requestCount: entry.requests,
          limit: this.config.maxRequestsPerMinute
        });

        return {
          allowed: false,
          reason: `Rate limit exceeded: ${entry.requests} requests in the last minute (limit: ${this.config.maxRequestsPerMinute})`,
          requestCount: entry.requests,
          timeWindow: 'minute'
        };
      }
    } else if (timeSinceFirst < 60 * 60 * 1000) {
      // Per hour check
      if (entry.requests > this.config.maxRequestsPerHour) {
        entry.blocked = true;
        entry.blockReason = 'Rate limit exceeded (per hour)';
        
        logSecurityEvent('rate_limit_exceeded', userId, {
          timeWindow: 'hour',
          requestCount: entry.requests,
          limit: this.config.maxRequestsPerHour
        });

        return {
          allowed: false,
          reason: `Rate limit exceeded: ${entry.requests} requests in the last hour (limit: ${this.config.maxRequestsPerHour})`,
          requestCount: entry.requests,
          timeWindow: 'hour'
        };
      }
    } else if (timeSinceFirst < 24 * 60 * 60 * 1000) {
      // Per day check
      if (entry.requests > this.config.maxRequestsPerDay) {
        entry.blocked = true;
        entry.blockReason = 'Rate limit exceeded (per day)';
        
        logSecurityEvent('rate_limit_exceeded', userId, {
          timeWindow: 'day',
          requestCount: entry.requests,
          limit: this.config.maxRequestsPerDay
        });

        return {
          allowed: false,
          reason: `Rate limit exceeded: ${entry.requests} requests in the last day (limit: ${this.config.maxRequestsPerDay})`,
          requestCount: entry.requests,
          timeWindow: 'day'
        };
      }
    } else {
      // Reset counter for new time window
      entry.requests = 1;
      entry.firstRequest = now;
      entry.blocked = false;
      entry.blockReason = undefined;
    }

    return { allowed: true };
  }

  /**
   * Sanitize input to remove potentially harmful content
   */
  private sanitizeInput(prompt: string, userId: string): {
    isValid: boolean;
    sanitizedPrompt: string;
    reason?: string;
    threat?: SecurityThreat;
  } {
    // Check prompt length
    if (prompt.length > this.config.maxPromptLength) {
      const threat = this.createThreat('invalid_input', 'medium', userId, {
        reason: 'Prompt too long',
        promptLength: prompt.length,
        maxLength: this.config.maxPromptLength
      }, true, 'Request blocked - prompt exceeds maximum length');

      return {
        isValid: false,
        sanitizedPrompt: '',
        reason: `Prompt too long: ${prompt.length} characters (limit: ${this.config.maxPromptLength})`,
        threat
      };
    }

    // Basic sanitization
    let sanitized = prompt
      // Remove null bytes
      .replace(/\0/g, '')
      // Remove excessive whitespace
      .replace(/\s{10,}/g, ' ')
      // Remove control characters (except newlines and tabs)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      // Trim
      .trim();

    // Check for empty prompt after sanitization
    if (sanitized.length === 0) {
      const threat = this.createThreat('invalid_input', 'low', userId, {
        reason: 'Empty prompt after sanitization',
        originalLength: prompt.length
      }, true, 'Request blocked - empty prompt after sanitization');

      return {
        isValid: false,
        sanitizedPrompt: '',
        reason: 'Prompt is empty after security sanitization',
        threat
      };
    }

    return {
      isValid: true,
      sanitizedPrompt: sanitized
    };
  }

  /**
   * Detect suspicious patterns in input
   */
  private detectSuspiciousPatterns(prompt: string, userId: string): {
    isValid: boolean;
    reason?: string;
    threat?: SecurityThreat;
  } {
    const detectedPatterns: string[] = [];

    for (let i = 0; i < this.suspiciousPatterns.length; i++) {
      const pattern = this.suspiciousPatterns[i];
      if (pattern.test(prompt)) {
        detectedPatterns.push(`Pattern ${i + 1}`);
      }
    }

    if (detectedPatterns.length >= this.config.suspiciousPatternThreshold) {
      const threat = this.createThreat('suspicious_pattern', 'high', userId, {
        reason: 'Multiple suspicious patterns detected',
        detectedPatterns,
        patternCount: detectedPatterns.length,
        threshold: this.config.suspiciousPatternThreshold,
        promptSample: prompt.substring(0, 200) + (prompt.length > 200 ? '...' : '')
      }, true, 'Request blocked - suspicious patterns detected');

      // Temporarily block user after multiple suspicious patterns
      this.temporarilyBlockUser(userId, 'Multiple suspicious patterns detected');

      return {
        isValid: false,
        reason: `Suspicious patterns detected in prompt (${detectedPatterns.length} patterns)`,
        threat
      };
    }

    // Log single pattern detections as warnings
    if (detectedPatterns.length > 0) {
      logSecurityEvent('suspicious_pattern_detected', userId, {
        detectedPatterns,
        patternCount: detectedPatterns.length,
        promptSample: prompt.substring(0, 100) + '...'
      });
    }

    return { isValid: true };
  }

  /**
   * Detect anomalies in request patterns
   */
  private detectAnomalies(request: any, sanitizedPrompt: string): {
    isValid: boolean;
    reason?: string;
    threat?: SecurityThreat;
  } {
    const anomalies: string[] = [];

    // Check for unusual prompt characteristics
    const wordCount = sanitizedPrompt.split(/\s+/).length;
    const charCount = sanitizedPrompt.length;
    const avgWordLength = wordCount > 0 ? charCount / wordCount : 0;

    // Detect extremely long words (potential encoded data)
    if (avgWordLength > 50) {
      anomalies.push('Unusually long average word length');
    }

    // Detect excessive repetition
    const uniqueWords = new Set(sanitizedPrompt.toLowerCase().split(/\s+/));
    const repetitionRatio = uniqueWords.size / wordCount;
    if (repetitionRatio < 0.3 && wordCount > 10) {
      anomalies.push('High repetition ratio');
    }

    // Detect unusual character distribution
    const specialCharCount = (sanitizedPrompt.match(/[^a-zA-Z0-9\s]/g) || []).length;
    const specialCharRatio = specialCharCount / charCount;
    if (specialCharRatio > 0.3) {
      anomalies.push('High special character ratio');
    }

    // Check for rapid-fire requests (same user, similar prompts)
    const recentSimilarRequests = this.checkForSimilarRecentRequests(request.userId, sanitizedPrompt);
    if (recentSimilarRequests > 3) {
      anomalies.push('Multiple similar requests in short time');
    }

    if (anomalies.length >= 2) {
      const threat = this.createThreat('anomaly', 'medium', request.userId, {
        reason: 'Multiple anomalies detected',
        anomalies,
        promptStats: {
          wordCount,
          charCount,
          avgWordLength: avgWordLength.toFixed(2),
          repetitionRatio: repetitionRatio.toFixed(2),
          specialCharRatio: specialCharRatio.toFixed(2)
        }
      }, true, 'Request blocked - anomalous behavior detected');

      return {
        isValid: false,
        reason: `Anomalous request pattern detected (${anomalies.length} anomalies)`,
        threat
      };
    }

    return { isValid: true };
  }

  /**
   * Check for similar recent requests from the same user
   */
  private checkForSimilarRecentRequests(userId: string, prompt: string): number {
    // This is a simplified implementation
    // In a real system, you'd store recent requests and compare them
    const promptHash = this.simpleHash(prompt.toLowerCase().trim());
    
    // For now, return 0 (no similar requests found)
    // In a full implementation, this would check against stored recent requests
    return 0;
  }

  /**
   * Simple hash function for comparing prompts
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Create a security threat record
   */
  private createThreat(
    type: SecurityThreat['type'],
    severity: SecurityThreat['severity'],
    userId: string | undefined,
    details: any,
    blocked: boolean,
    action: string
  ): SecurityThreat {
    const threat: SecurityThreat = {
      type,
      severity,
      userId,
      details,
      timestamp: new Date(),
      blocked,
      action
    };

    this.securityThreats.push(threat);

    // Keep only recent threats (last 1000)
    if (this.securityThreats.length > 1000) {
      this.securityThreats = this.securityThreats.slice(-1000);
    }

    // Log security event
    logSecurityEvent(`security_threat_${type}`, userId, {
      severity,
      details,
      blocked,
      action
    });

    return threat;
  }

  /**
   * Temporarily block a user
   */
  private temporarilyBlockUser(userId: string, reason: string): void {
    this.blockedUsers.add(userId);
    
    // Unblock after 1 hour
    setTimeout(() => {
      this.blockedUsers.delete(userId);
      console.log(`🔓 User ${userId} has been unblocked after temporary suspension`);
    }, 60 * 60 * 1000);

    console.log(`🚫 User ${userId} temporarily blocked: ${reason}`);
    
    logSecurityEvent('user_temporarily_blocked', userId, {
      reason,
      duration: '1 hour'
    });
  }

  /**
   * Block an IP address
   */
  blockIP(ipAddress: string, reason: string): void {
    this.blockedIPs.add(ipAddress);
    
    console.log(`🚫 IP ${ipAddress} blocked: ${reason}`);
    
    logSecurityEvent('ip_address_blocked', undefined, {
      ipAddress,
      reason
    });
  }

  /**
   * Unblock a user
   */
  unblockUser(userId: string): void {
    this.blockedUsers.delete(userId);
    console.log(`🔓 User ${userId} has been unblocked`);
    
    logSecurityEvent('user_unblocked', userId, {
      action: 'manual_unblock'
    });
  }

  /**
   * Unblock an IP address
   */
  unblockIP(ipAddress: string): void {
    this.blockedIPs.delete(ipAddress);
    console.log(`🔓 IP ${ipAddress} has been unblocked`);
    
    logSecurityEvent('ip_address_unblocked', undefined, {
      ipAddress,
      action: 'manual_unblock'
    });
  }

  /**
   * Get security statistics
   */
  getSecurityStatistics(): {
    totalThreats: number;
    threatsByType: { [type: string]: number };
    threatsBySeverity: { [severity: string]: number };
    blockedUsers: number;
    blockedIPs: number;
    recentThreats: SecurityThreat[];
    rateLimitedUsers: number;
  } {
    const threatsByType: { [type: string]: number } = {};
    const threatsBySeverity: { [severity: string]: number } = {};

    this.securityThreats.forEach(threat => {
      threatsByType[threat.type] = (threatsByType[threat.type] || 0) + 1;
      threatsBySeverity[threat.severity] = (threatsBySeverity[threat.severity] || 0) + 1;
    });

    const rateLimitedUsers = Array.from(this.rateLimitMap.values())
      .filter(entry => entry.blocked).length;

    const recentThreats = this.securityThreats
      .filter(threat => Date.now() - threat.timestamp.getTime() < 24 * 60 * 60 * 1000)
      .slice(-10);

    return {
      totalThreats: this.securityThreats.length,
      threatsByType,
      threatsBySeverity,
      blockedUsers: this.blockedUsers.size,
      blockedIPs: this.blockedIPs.size,
      recentThreats,
      rateLimitedUsers
    };
  }

  /**
   * Clean up old entries
   */
  private cleanupOldEntries(): void {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Clean up old rate limit entries
    let cleanedRateLimit = 0;
    for (const [userId, entry] of this.rateLimitMap.entries()) {
      if (entry.lastRequest < oneDayAgo) {
        this.rateLimitMap.delete(userId);
        cleanedRateLimit++;
      }
    }

    // Clean up old security threats
    const oldThreatCount = this.securityThreats.length;
    this.securityThreats = this.securityThreats.filter(
      threat => threat.timestamp > oneDayAgo
    );
    const cleanedThreats = oldThreatCount - this.securityThreats.length;

    if (cleanedRateLimit > 0 || cleanedThreats > 0) {
      console.log(`🧹 Security cleanup: removed ${cleanedRateLimit} rate limit entries, ${cleanedThreats} old threats`);
    }
  }

  /**
   * Update security configuration
   */
  updateConfig(newConfig: Partial<SecurityConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('Security configuration updated:', newConfig);
  }

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.rateLimitMap.clear();
    this.securityThreats = [];
    this.blockedUsers.clear();
    this.blockedIPs.clear();
    
    console.log('🧹 Security enhancer destroyed');
  }
}

// Global security enhancer instance
let globalSecurityEnhancer: SecurityEnhancer | null = null;

export function getSecurityEnhancer(): SecurityEnhancer {
  if (!globalSecurityEnhancer) {
    globalSecurityEnhancer = new SecurityEnhancer({
      maxRequestsPerMinute: 15,
      maxRequestsPerHour: 150,
      maxRequestsPerDay: 1000,
      maxPromptLength: 8000,
      maxConcurrentRequests: 3,
      suspiciousPatternThreshold: 2,
      enableRateLimiting: true,
      enableAnomalyDetection: true,
      enableInputSanitization: true
    });
  }
  
  return globalSecurityEnhancer;
}

export function resetSecurityEnhancer(): void {
  if (globalSecurityEnhancer) {
    globalSecurityEnhancer.destroy();
    globalSecurityEnhancer = null;
  }
}