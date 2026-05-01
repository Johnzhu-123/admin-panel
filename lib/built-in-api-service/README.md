# Built-in API Service

A secure, permission-based system that allows authorized users to use maintainer-provided API keys without exposing them to the frontend.

## Features

- 🔐 **Secure API Key Management**: API keys are stored server-side only, never exposed to frontend
- 👥 **User Authorization**: Permission-based access control for built-in services
- 🔄 **One-Click Switching**: Easy switching between built-in and custom API configurations
- 📊 **Usage Tracking**: Monitor API usage and quota limits
- 🏥 **Health Monitoring**: Real-time service health and availability checking
- 🔧 **Backward Compatible**: Existing users continue to work with custom APIs

## Quick Start

### 1. Environment Setup

Set up environment variables for built-in services:

```bash
# Gemini API (recommended)
GEMINI_BUILT_IN_API_KEY=your_gemini_api_key_here

# Optional: Other providers
OPENAI_BUILT_IN_API_KEY=your_openai_api_key_here
CLAUDE_BUILT_IN_API_KEY=your_claude_api_key_here
```

### 2. Initialize the Service

```typescript
import { getBuiltInAPIService } from '@/lib/built-in-api-service';

const builtInService = getBuiltInAPIService();
await builtInService.initialize();
```

### 3. Add Authorized Users

```typescript
// Admin operation: Add a user with permissions
await builtInService.addAuthorizedUser('user123', {
  canUseBuiltInServices: true,
  allowedServices: ['gemini-built-in'],
  quotaLimits: {
    dailyRequests: 50,
    monthlyRequests: 1000,
    concurrentRequests: 3
  },
  grantedAt: new Date(),
  grantedBy: 'admin'
});
```

### 4. Use Built-in Services

```typescript
// Check if user is authorized
const isAuthorized = await builtInService.checkUserAuthorization('user123');

if (isAuthorized) {
  // Switch to built-in service
  const result = await builtInService.switchToBuiltInService('user123', 'gemini-built-in');
  
  if (result.success) {
    // Generate image using built-in service
    const imageResult = await builtInService.proxyImageGeneration({
      userId: 'user123',
      serviceId: 'gemini-built-in',
      prompt: 'A beautiful landscape',
      size: '1024x1024'
    });
  }
}
```

## API Integration

### Image Generation API

The built-in service integrates with the existing image generation API. Add `useBuiltInService: true` and `userId` to your request:

```typescript
const response = await fetch('/api/ai/image', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'A beautiful sunset',
    useBuiltInService: true,
    userId: 'user123',
    // ... other parameters
  })
});
```

### Built-in Service Management API

Use the management API for service configuration:

```typescript
// Get available services
const services = await fetch('/api/ai/built-in-service?action=services&userId=user123');

// Switch to built-in service
const switchResult = await fetch('/api/ai/built-in-service', {
  method: 'POST',
  body: JSON.stringify({
    action: 'switch-to-built-in',
    userId: 'user123',
    serviceId: 'gemini-built-in'
  })
});

// Get service status
const status = await fetch('/api/ai/built-in-service?action=status&userId=user123');
```

## Configuration

### Built-in Services

Default built-in services are configured in `config.ts`:

```typescript
export const BUILT_IN_SERVICES = {
  'gemini-built-in': {
    id: 'gemini-built-in',
    name: 'Built-in Gemini Service',
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1',
    model: 'gemini-1.5-flash',
    isEnabled: true,
    // ... quota and rate limits
  }
};
```

### User Permissions

Permissions are stored in `.kiro/built-in-api-service/permissions.json`:

```json
[
  {
    "userId": "user123",
    "email": "user@example.com",
    "permissions": {
      "canUseBuiltInServices": true,
      "allowedServices": ["gemini-built-in"],
      "quotaLimits": {
        "dailyRequests": 50,
        "monthlyRequests": 1000,
        "concurrentRequests": 3
      },
      "grantedAt": "2024-01-01T00:00:00.000Z",
      "grantedBy": "admin"
    },
    "status": "active"
  }
]
```

## Security Features

- **API Key Isolation**: Keys are never sent to frontend
- **Permission-Based Access**: Only authorized users can access built-in services
- **Quota Management**: Configurable usage limits per user
- **Rate Limiting**: Prevent abuse with configurable rate limits
- **Audit Logging**: Track all permission changes and usage

## Monitoring

### Health Checks

```typescript
const health = await builtInService.getSystemHealthStatus();
console.log('System healthy:', health.isHealthy);
console.log('Service status:', health.services);
```

### Usage Statistics

```typescript
const usage = builtInService.getUsageStatistics('user123');
console.log('Total requests:', usage.totalRequests);
console.log('Success rate:', usage.successfulRequests / usage.totalRequests);
```

### Configuration Summary

```typescript
const summary = await builtInService.getConfigurationSummary();
console.log('Available services:', summary.availableServices);
console.log('Active users:', summary.activeUsers);
```

## Error Handling

The system provides detailed error information:

```typescript
try {
  await builtInService.proxyImageGeneration(request);
} catch (error) {
  if (error.code === 'PERMISSION_DENIED') {
    // Handle permission error
  } else if (error.code === 'SERVICE_UNAVAILABLE') {
    // Handle service unavailability
  } else if (error.code === 'QUOTA_EXCEEDED') {
    // Handle quota exceeded
  }
}
```

## File Structure

```
lib/built-in-api-service/
├── index.ts                 # Main exports
├── manager.ts              # Main service manager
├── types.ts                # Type definitions
├── interfaces.ts           # Interface definitions
├── config.ts               # Configuration constants
├── components/             # Core components
│   ├── user-authorization-verifier.ts
│   ├── permission-manager.ts
│   ├── service-config-manager.ts
│   ├── api-proxy-layer.ts
│   ├── service-manager.ts
│   └── configuration-storage.ts
└── examples/               # Usage examples
    └── usage-example.ts
```

## Development

### Running Examples

```bash
# Run the usage examples
npx tsx lib/built-in-api-service/examples/usage-example.ts
```

### Testing

The system includes comprehensive property-based and unit tests. See the tasks.md file for testing requirements.

## Troubleshooting

### Common Issues

1. **"Service not available"**: Check environment variables are set
2. **"Permission denied"**: Ensure user is added to authorized users list
3. **"Quota exceeded"**: Check user's quota limits and usage
4. **"Service unavailable"**: Verify API keys are valid and service is healthy

### Debug Mode

Enable debug logging:

```typescript
// Set environment variable
process.env.BUILT_IN_API_DEBUG = 'true';
```

### Health Check

```bash
curl "http://localhost:3000/api/ai/built-in-service?action=health"
```

## Contributing

When adding new features:

1. Update type definitions in `types.ts`
2. Add interface methods in `interfaces.ts`
3. Implement in appropriate component
4. Add tests following the property-based testing approach
5. Update documentation

## License

This built-in API service system is part of the larger application and follows the same license terms.