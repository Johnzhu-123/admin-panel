// Path normalization component for third-party API compatibility

import { PathNormalizer as IPathNormalizer } from '../interfaces';
import { ValidationResult } from '../types';

export class PathNormalizer implements IPathNormalizer {
  /**
   * Normalizes API paths to ensure proper /v1 prefix handling
   * Validates: Requirements 1.1, 1.2, 1.3, 1.4
   */
  normalizePath(baseUrl: string, endpoint: string): string {
    if (!baseUrl || typeof baseUrl !== 'string') {
      throw new Error('Base URL is required and must be a string');
    }

    const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
    const trimmedEndpoint = (endpoint || '').trim();

    // Handle absolute URLs in endpoint
    if (/^https?:\/\//i.test(trimmedEndpoint)) {
      return this.normalizeAbsoluteUrl(trimmedEndpoint);
    }

    // Normalize the base URL first
    const normalizedBase = this.normalizeBaseUrl(trimmedBase);
    
    // Handle endpoint path
    if (!trimmedEndpoint) {
      return normalizedBase;
    }

    const cleanEndpoint = trimmedEndpoint.startsWith('/') ? trimmedEndpoint : `/${trimmedEndpoint}`;
    
    // If endpoint already starts with /v1, combine with root base
    if (/^\/v1/i.test(cleanEndpoint)) {
      const rootBase = normalizedBase.replace(/\/v1(?:beta|alpha)?$/i, '');
      return `${rootBase}${cleanEndpoint}`;
    }

    return `${normalizedBase}${cleanEndpoint}`;
  }

  /**
   * Detects duplicate /v1 paths in URLs
   * Validates: Requirements 1.1, 1.2
   */
  detectDuplicatePaths(url: string): boolean {
    if (!url || typeof url !== 'string') {
      return false;
    }

    const trimmed = url.trim();
    
    // Check for various duplicate patterns
    const duplicatePatterns = [
      /\/v1.*\/v1/i,           // /v1.../v1
      /\/v\/v1/i,              // /v/v1
      /\/V\/v1/i,              // /V/v1
      /\/V1.*\/v1/i,           // /V1.../v1
      /\/v1beta.*\/v1/i,       // /v1beta.../v1
      /\/v1alpha.*\/v1/i,      // /v1alpha.../v1
    ];

    // Also check for standalone /V1 pattern (should be /v1)
    const standaloneV1Pattern = /\/V1(?![a-z])/;
    
    return duplicatePatterns.some(pattern => pattern.test(trimmed)) || 
           standaloneV1Pattern.test(trimmed);
  }

  /**
   * Validates URL structure and provides suggestions
   * Validates: Requirements 1.4
   */
  validateUrl(url: string): ValidationResult {
    const result: ValidationResult = {
      isValid: true,
      issues: [],
      suggestedFix: undefined
    };

    if (!url || typeof url !== 'string') {
      result.isValid = false;
      result.issues.push('URL is required and must be a string');
      return result;
    }

    const trimmed = url.trim();

    // Check for valid URL format
    try {
      new URL(trimmed);
    } catch {
      result.isValid = false;
      result.issues.push('Invalid URL format');
      result.suggestedFix = 'Ensure URL starts with http:// or https://';
      return result;
    }

    // Check for duplicate paths
    if (this.detectDuplicatePaths(trimmed)) {
      result.isValid = false;
      result.issues.push('Duplicate /v1 paths detected');
      result.suggestedFix = this.normalizePath(trimmed, '');
    }

    // Check for common issues
    if (trimmed.includes('//v1')) {
      result.issues.push('Double slash before /v1 detected');
      if (!result.suggestedFix) {
        result.suggestedFix = trimmed.replace(/\/\/v1/g, '/v1');
      }
    }

    if (trimmed.endsWith('/v1/')) {
      result.issues.push('Trailing slash after /v1 detected');
      if (!result.suggestedFix) {
        result.suggestedFix = trimmed.replace(/\/v1\/$/, '/v1');
      }
    }

    // Check for unsupported protocols
    if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) {
      result.isValid = false;
      result.issues.push('Only HTTP and HTTPS protocols are supported');
    }

    return result;
  }

  /**
   * Normalizes base URL to ensure proper /v1 handling
   * Private helper method
   */
  private normalizeBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, '');
    
    // Check for incorrect duplicate path patterns first
    if (this.detectDuplicatePaths(trimmed)) {
      return this.fixDuplicatePaths(trimmed);
    }
    
    // Check if already contains /v1 path
    const v1Match = trimmed.match(/\/v1(?:beta|alpha)?(?:\/|$)/i);
    if (v1Match && v1Match.index !== undefined) {
      // If already contains /v1, remove trailing slash and return
      const end = v1Match.index + v1Match[0].length;
      const sliceEnd = v1Match[0].endsWith('/') ? end - 1 : end;
      return trimmed.slice(0, sliceEnd);
    }
    
    return `${trimmed}/v1`;
  }

  /**
   * Normalizes absolute URLs
   * Private helper method
   */
  private normalizeAbsoluteUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      
      // Check if pathname already has proper /v1 structure
      if (this.detectDuplicatePaths(pathname)) {
        // Fix duplicate paths in pathname
        const fixedPath = this.fixDuplicatePaths(pathname);
        urlObj.pathname = fixedPath;
      } else if (!pathname.includes('/v1')) {
        // Add /v1 if not present
        const normalizedPath = this.normalizeBaseUrl(pathname.replace(/\/+$/, '') || '');
        urlObj.pathname = normalizedPath;
      }
      
      return urlObj.toString();
    } catch {
      // If URL parsing fails, return original
      return url;
    }
  }

  /**
   * Fixes duplicate paths in a pathname
   * Private helper method
   */
  private fixDuplicatePaths(pathname: string): string {
    // Remove duplicate /v1 patterns
    let fixed = pathname;
    
    // Fix /v/v1 -> /v1
    fixed = fixed.replace(/\/v\/v1/gi, '/v1');
    
    // Fix /V/v1 -> /v1
    fixed = fixed.replace(/\/V\/v1/gi, '/v1');
    
    // Fix /V1 -> /v1
    fixed = fixed.replace(/\/V1(?![a-z])/gi, '/v1');
    
    // Fix multiple /v1 occurrences - keep only the first one
    const v1Matches = fixed.match(/\/v1(?:beta|alpha)?/gi);
    if (v1Matches && v1Matches.length > 1) {
      const firstV1 = v1Matches[0];
      const beforeFirst = fixed.substring(0, fixed.indexOf(firstV1));
      const afterLast = fixed.substring(fixed.lastIndexOf(v1Matches[v1Matches.length - 1]) + v1Matches[v1Matches.length - 1].length);
      fixed = beforeFirst + firstV1 + afterLast;
    }
    
    return fixed;
  }
}