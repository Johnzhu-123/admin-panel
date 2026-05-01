// Third-Party API Compatibility System
// Main entry point for the API compatibility framework

export * from './types';
export * from './interfaces';

// Export specific implementations
export { PathNormalizer } from './components/path-normalizer';
export { AuthenticationHandler } from './components/auth-handler';
export { ResponseFormatAdapter } from './components/response-format-adapter';
export { NetworkDiagnostics } from './components/network-diagnostics';
export { FallbackStrategyImpl } from './components/fallback-strategy';
export { ConfigurationManagerImpl } from './components/configuration-manager';
export { ErrorMonitorImpl } from './components/error-monitor';
export { ContentPolicyHandler } from './components/content-policy-handler';
export { PerformanceOptimizer } from './components/performance-optimizer';

// Main compatibility manager instance
export { APICompatibilityManager } from './manager';