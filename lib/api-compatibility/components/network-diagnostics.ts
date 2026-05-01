// Network diagnostics component for third-party API compatibility

import { NetworkDiagnostics as INetworkDiagnostics } from '../interfaces';
import { 
  APIProvider, 
  DiagnosticResult, 
  CertificateInfo, 
  DNSResult, 
  NetworkError,
  NetworkErrorType
} from '../types';

export class NetworkDiagnostics implements INetworkDiagnostics {
  private readonly defaultTimeout = 10000; // 10 seconds
  private readonly dnsServers = ['8.8.8.8', '1.1.1.1', '208.67.222.222']; // Google, Cloudflare, OpenDNS

  /**
   * Tests connection to the API provider
   * Validates: Requirements 5.1, 5.2, 5.3, 5.4
   */
  async testConnection(provider: APIProvider): Promise<DiagnosticResult> {
    if (!provider || !provider.baseUrl) {
      return {
        success: false,
        latency: 0,
        errors: [{
          type: 'CONNECTION',
          message: 'Provider or baseUrl is required',
          details: { provider }
        }],
        suggestions: ['Ensure provider has a valid baseUrl']
      };
    }

    const startTime = Date.now();
    const errors: NetworkError[] = [];
    const suggestions: string[] = [];

    try {
      const url = new URL(provider.baseUrl);
      const hostname = url.hostname;
      const port = url.port ? parseInt(url.port) : (url.protocol === 'https:' ? 443 : 80);

      // Test DNS resolution
      const dnsResult = await this.testDNSResolution(hostname);
      if (!dnsResult.resolved) {
        errors.push({
          type: 'DNS',
          message: `DNS resolution failed for ${hostname}`,
          details: dnsResult
        });
        suggestions.push(`Check if ${hostname} is a valid domain name`);
        suggestions.push('Try using a different DNS server');
      }

      // Test port reachability
      const portReachable = await this.testPortReachability(hostname, port);
      if (!portReachable) {
        errors.push({
          type: 'PORT',
          message: `Port ${port} is not reachable on ${hostname}`,
          details: { hostname, port }
        });
        suggestions.push(`Check if port ${port} is open and accessible`);
        suggestions.push('Verify firewall settings');
      }

      // Test TLS certificate if HTTPS
      if (url.protocol === 'https:') {
        const certInfo = await this.checkTLSCertificate(provider.baseUrl);
        if (!certInfo.valid) {
          errors.push({
            type: 'TLS',
            message: 'TLS certificate validation failed',
            details: certInfo
          });
          suggestions.push('Check TLS certificate validity');
          suggestions.push('Ensure system time is correct');
          if (certInfo.errors) {
            suggestions.push(...certInfo.errors.map(err => `Certificate issue: ${err}`));
          }
        }
      }

      // Test basic HTTP connectivity
      try {
        const response = await this.makeTestRequest(provider.baseUrl);
        if (!response.ok && response.status >= 500) {
          errors.push({
            type: 'CONNECTION',
            message: `Server error: ${response.status} ${response.statusText}`,
            details: { status: response.status, statusText: response.statusText }
          });
          suggestions.push('Server may be experiencing issues');
          suggestions.push('Try again later');
        }
      } catch (fetchError) {
        const errorMessage = fetchError instanceof Error ? fetchError.message : 'Unknown fetch error';
        errors.push({
          type: 'CONNECTION',
          message: `HTTP request failed: ${errorMessage}`,
          details: { error: errorMessage }
        });
        
        if (errorMessage.toLowerCase().includes('timeout')) {
          suggestions.push('Request timed out - check network connectivity');
          suggestions.push('Try increasing timeout value');
        } else if (errorMessage.toLowerCase().includes('network')) {
          suggestions.push('Network connectivity issue detected');
          suggestions.push('Check internet connection');
        } else if (errorMessage.toLowerCase().includes('ssl') || errorMessage.toLowerCase().includes('tls')) {
          suggestions.push('SSL/TLS connection issue');
          suggestions.push('Check certificate configuration');
        }
      }

      const latency = Date.now() - startTime;
      const success = errors.length === 0;

      // Add performance suggestions
      if (latency > 5000) {
        suggestions.push('High latency detected - consider using a closer server');
      }

      return {
        success,
        latency,
        errors,
        suggestions: [...new Set(suggestions)] // Remove duplicates
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        latency: Date.now() - startTime,
        errors: [{
          type: 'CONNECTION',
          message: `Connection test failed: ${errorMessage}`,
          details: { error: errorMessage }
        }],
        suggestions: [
          'Check network connectivity',
          'Verify the API endpoint URL',
          'Check firewall and proxy settings'
        ]
      };
    }
  }

  /**
   * Checks TLS certificate validity
   * Validates: Requirements 5.2
   */
  async checkTLSCertificate(url: string): Promise<CertificateInfo> {
    try {
      const urlObj = new URL(url);
      
      // For browser environment, we can't directly access certificate details
      // We'll use a fetch request to test SSL connectivity
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.defaultTimeout);

      try {
        const response = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          // Disable cache to ensure fresh connection
          cache: 'no-cache'
        });

        clearTimeout(timeoutId);

        // If we can make a successful HTTPS request, certificate is likely valid
        return {
          valid: true,
          subject: urlObj.hostname,
          issuer: 'Unknown (browser environment)',
          validFrom: new Date(0), // Unknown in browser
          validTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // Assume 1 year validity
          errors: []
        };

      } catch (fetchError) {
        clearTimeout(timeoutId);
        
        const errorMessage = fetchError instanceof Error ? fetchError.message : 'Unknown error';
        const errors: string[] = [];

        if (errorMessage.toLowerCase().includes('certificate')) {
          errors.push('Certificate validation failed');
        }
        if (errorMessage.toLowerCase().includes('expired')) {
          errors.push('Certificate has expired');
        }
        if (errorMessage.toLowerCase().includes('self-signed')) {
          errors.push('Self-signed certificate detected');
        }
        if (errorMessage.toLowerCase().includes('hostname')) {
          errors.push('Certificate hostname mismatch');
        }

        return {
          valid: false,
          subject: urlObj.hostname,
          errors: errors.length > 0 ? errors : [errorMessage]
        };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        valid: false,
        errors: [`Certificate check failed: ${errorMessage}`]
      };
    }
  }

  /**
   * Tests port reachability
   * Validates: Requirements 5.3
   */
  async testPortReachability(host: string, port: number): Promise<boolean> {
    try {
      // In browser environment, we can't directly test port connectivity
      // We'll use a fetch request to test if the service is reachable
      const protocol = port === 443 ? 'https' : 'http';
      const testUrl = `${protocol}://${host}:${port}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout for port test

      try {
        const response = await fetch(testUrl, {
          method: 'HEAD',
          signal: controller.signal,
          mode: 'no-cors' // Allow cross-origin requests for connectivity test
        });

        clearTimeout(timeoutId);
        return true; // If we get any response, port is reachable

      } catch (fetchError) {
        clearTimeout(timeoutId);
        
        // In no-cors mode, we might get opaque responses
        // If the error is not a network error, the port might still be reachable
        const errorMessage = fetchError instanceof Error ? fetchError.message : '';
        
        if (errorMessage.toLowerCase().includes('network') || 
            errorMessage.toLowerCase().includes('timeout') ||
            errorMessage.toLowerCase().includes('refused')) {
          return false;
        }
        
        // Other errors might indicate the port is reachable but service is different
        return true;
      }

    } catch (error) {
      return false;
    }
  }

  /**
   * Tests DNS resolution
   * Validates: Requirements 5.3
   */
  async testDNSResolution(hostname: string): Promise<DNSResult> {
    try {
      // In browser environment, we can't directly perform DNS queries
      // We'll use a fetch request to test if the hostname resolves
      const testUrl = `https://${hostname}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        // Use a HEAD request to minimize data transfer
        await fetch(testUrl, {
          method: 'HEAD',
          signal: controller.signal,
          mode: 'no-cors'
        });

        clearTimeout(timeoutId);
        
        return {
          resolved: true,
          addresses: ['Unknown (browser environment)'] // Can't get actual IP in browser
        };

      } catch (fetchError) {
        clearTimeout(timeoutId);
        
        const errorMessage = fetchError instanceof Error ? fetchError.message : 'Unknown error';
        
        // Check if error indicates DNS resolution failure
        if (errorMessage.toLowerCase().includes('dns') ||
            errorMessage.toLowerCase().includes('resolve') ||
            errorMessage.toLowerCase().includes('not found')) {
          return {
            resolved: false,
            error: `DNS resolution failed: ${errorMessage}`
          };
        }

        // Other errors might indicate DNS worked but connection failed
        return {
          resolved: true,
          addresses: ['Unknown (browser environment)'],
          error: `Connection failed after DNS resolution: ${errorMessage}`
        };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        resolved: false,
        error: `DNS test failed: ${errorMessage}`
      };
    }
  }

  /**
   * Makes a test HTTP request to check connectivity
   * Private helper method
   */
  private async makeTestRequest(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'User-Agent': 'API-Compatibility-Diagnostics/1.0'
        }
      });

      clearTimeout(timeoutId);
      return response;

    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Analyzes network error patterns
   * Helper method for error categorization
   */
  analyzeNetworkError(error: Error): NetworkErrorType {
    const message = error.message.toLowerCase();

    if (message.includes('timeout')) {
      return 'TIMEOUT';
    }
    
    if (message.includes('dns') || message.includes('resolve')) {
      return 'DNS';
    }
    
    if (message.includes('certificate') || message.includes('ssl') || message.includes('tls')) {
      return 'TLS';
    }
    
    if (message.includes('port') || message.includes('refused') || message.includes('unreachable')) {
      return 'PORT';
    }
    
    return 'CONNECTION';
  }

  /**
   * Generates diagnostic suggestions based on error patterns
   * Helper method for providing actionable advice
   */
  generateSuggestions(errors: NetworkError[]): string[] {
    const suggestions: string[] = [];
    const errorTypes = new Set(errors.map(e => e.type));

    if (errorTypes.has('DNS')) {
      suggestions.push('Check DNS configuration');
      suggestions.push('Try using public DNS servers (8.8.8.8, 1.1.1.1)');
      suggestions.push('Verify domain name spelling');
    }

    if (errorTypes.has('TLS')) {
      suggestions.push('Check system date and time');
      suggestions.push('Update certificate store');
      suggestions.push('Verify TLS version compatibility');
    }

    if (errorTypes.has('PORT')) {
      suggestions.push('Check firewall settings');
      suggestions.push('Verify port is not blocked by proxy');
      suggestions.push('Confirm service is running on expected port');
    }

    if (errorTypes.has('TIMEOUT')) {
      suggestions.push('Check network connectivity');
      suggestions.push('Increase timeout values');
      suggestions.push('Try from different network location');
    }

    if (errorTypes.has('CONNECTION')) {
      suggestions.push('Verify API endpoint URL');
      suggestions.push('Check proxy settings');
      suggestions.push('Test with different network connection');
    }

    return suggestions;
  }

  /**
   * Performs comprehensive network health check
   * Combines multiple diagnostic tests
   */
  async performHealthCheck(provider: APIProvider): Promise<{
    overall: 'healthy' | 'degraded' | 'unhealthy';
    score: number; // 0-100
    details: DiagnosticResult;
    recommendations: string[];
  }> {
    const diagnosticResult = await this.testConnection(provider);
    
    let score = 100;
    let overall: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    const recommendations: string[] = [];

    // Deduct points for each error type
    const errorTypeCounts = diagnosticResult.errors.reduce((counts, error) => {
      counts[error.type] = (counts[error.type] || 0) + 1;
      return counts;
    }, {} as Record<NetworkErrorType, number>);

    // Scoring system
    if (errorTypeCounts.DNS) score -= 30;
    if (errorTypeCounts.TLS) score -= 25;
    if (errorTypeCounts.PORT) score -= 20;
    if (errorTypeCounts.TIMEOUT) score -= 15;
    if (errorTypeCounts.CONNECTION) score -= 10;

    // Latency penalty
    if (diagnosticResult.latency > 10000) score -= 20;
    else if (diagnosticResult.latency > 5000) score -= 10;
    else if (diagnosticResult.latency > 2000) score -= 5;

    // Determine overall health
    if (score >= 80) {
      overall = 'healthy';
    } else if (score >= 50) {
      overall = 'degraded';
      recommendations.push('Some network issues detected - monitor closely');
    } else {
      overall = 'unhealthy';
      recommendations.push('Significant network issues - immediate attention required');
    }

    // Add specific recommendations
    recommendations.push(...this.generateSuggestions(diagnosticResult.errors));
    recommendations.push(...diagnosticResult.suggestions);

    return {
      overall,
      score: Math.max(0, score),
      details: diagnosticResult,
      recommendations: [...new Set(recommendations)] // Remove duplicates
    };
  }

  /**
   * Tests multiple endpoints for comparison
   * Useful for identifying provider-specific vs general network issues
   */
  async compareEndpoints(providers: APIProvider[]): Promise<{
    results: Array<{ provider: APIProvider; result: DiagnosticResult }>;
    analysis: {
      bestPerforming: APIProvider | null;
      worstPerforming: APIProvider | null;
      averageLatency: number;
      commonIssues: string[];
    };
  }> {
    const results = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        result: await this.testConnection(provider)
      }))
    );

    // Analysis
    const successfulResults = results.filter(r => r.result.success);
    const bestPerforming = successfulResults.length > 0 
      ? successfulResults.reduce((best, current) => 
          current.result.latency < best.result.latency ? current : best
        ).provider
      : null;

    const worstPerforming = results.length > 0
      ? results.reduce((worst, current) => 
          current.result.latency > worst.result.latency ? current : worst
        ).provider
      : null;

    const averageLatency = results.length > 0
      ? results.reduce((sum, r) => sum + r.result.latency, 0) / results.length
      : 0;

    // Find common issues
    const allErrors = results.flatMap(r => r.result.errors);
    const errorCounts = allErrors.reduce((counts, error) => {
      counts[error.message] = (counts[error.message] || 0) + 1;
      return counts;
    }, {} as Record<string, number>);

    const commonIssues = Object.entries(errorCounts)
      .filter(([, count]) => count > 1)
      .map(([message]) => message);

    return {
      results,
      analysis: {
        bestPerforming,
        worstPerforming,
        averageLatency,
        commonIssues
      }
    };
  }
}