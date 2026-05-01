/**
 * Built-in API Service Management Endpoint
 * Handles built-in API service configuration and switching
 * Validates: Requirements 1.1, 1.2, 3.2, 5.1
 */

import { NextResponse } from "next/server";
import { noStoreHeaders } from "@/lib/ai";
import { getBuiltInAPIService } from "@/lib/built-in-api-service";
import { getBuiltInServiceConfig } from "@/lib/built-in-api-service/config";
import { getBuiltInRuntimeSettings } from "@/lib/built-in-api-service/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const normalizeRemoteBase = (base?: string) =>
  (base || "").trim().replace(/\/+$/, "");

const BUILT_IN_PROXY_HEADER = "x-built-in-service-server-url";

const normalizeIdentifier = (value?: string) => (value || "").trim().toLowerCase();

const findUserByIdentifier = (
  users: Array<{
    userId?: string;
    email?: string;
    permissions?: {
      quotaLimits?: {
        dailyRequests?: number;
        monthlyRequests?: number;
      };
    };
  }>,
  identifier: string
) => {
  const normalized = normalizeIdentifier(identifier);
  return users.find((user) => {
    const userId = normalizeIdentifier(user.userId);
    const email = normalizeIdentifier(user.email);
    return userId === normalized || (email && email === normalized);
  });
};

const shouldRefreshCache = (url: URL) => {
  const value = (url.searchParams.get("refresh") || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
};

const getRemoteServiceBase = (req: Request) => {
  const fromHeader = normalizeRemoteBase(req.headers.get(BUILT_IN_PROXY_HEADER) || "");
  if (fromHeader && process.env.ELECTRON_DESKTOP === "1") {
    return fromHeader;
  }
  const raw =
    process.env.BUILT_IN_SERVICE_SERVER_URL ||
    process.env.NEXT_PUBLIC_BUILT_IN_SERVICE_SERVER_URL ||
    "";
  const normalized = normalizeRemoteBase(raw);
  if (!normalized) return "";
  if (process.env.ELECTRON_DESKTOP !== "1") return "";
  return normalized;
};

const proxyToRemote = async (req: Request) => {
  const remoteBase = getRemoteServiceBase(req);
  if (!remoteBase) return null;

  const incoming = new URL(req.url);
  const targetUrl = `${remoteBase}${incoming.pathname}${incoming.search}`;
  const method = req.method || "GET";
  const bodyText = method === "GET" || method === "HEAD" ? undefined : await req.text();

  const response = await fetch(targetUrl, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(req.headers.get(BUILT_IN_PROXY_HEADER)
        ? { [BUILT_IN_PROXY_HEADER]: req.headers.get(BUILT_IN_PROXY_HEADER) || "" }
        : {}),
    },
    body: bodyText,
    cache: "no-store",
  });

  const text = await response.text();
  try {
    const data = text ? JSON.parse(text) : {};
    return NextResponse.json(data, {
      status: response.status,
      headers: noStoreHeaders(),
    });
  } catch {
    return new NextResponse(text, {
      status: response.status,
      headers: noStoreHeaders(),
    });
  }
};

export async function GET(req: Request) {
  const proxied = await proxyToRemote(req);
  if (proxied) return proxied;

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const userId = url.searchParams.get('userId');

    if (action === 'runtime-settings') {
      const runtimeSettings = await getBuiltInRuntimeSettings();
      const catalog = runtimeSettings.serviceCatalog || {};
      const sanitizedCatalog: Record<string, { baseUrl: string; model: string; isEnabled: boolean; updatedAt?: string }> = {};
      for (const category of Object.keys(catalog)) {
        const cfg = (catalog as Record<string, { baseUrl?: string; model?: string; isEnabled?: boolean; updatedAt?: string }>)[category];
        if (!cfg) continue;
        sanitizedCatalog[category] = {
          baseUrl: cfg.baseUrl || '',
          model: cfg.model || '',
          isEnabled: cfg.isEnabled === true,
          updatedAt: cfg.updatedAt,
        };
      }
      return NextResponse.json(
        {
          settings: {
            serviceGatewayUrl: runtimeSettings.serviceGatewayUrl,
            iopaintUrls: runtimeSettings.iopaintUrls,
            iopaintUrl: runtimeSettings.iopaintUrls[0] || "",
            updatePageUrl: runtimeSettings.updatePageUrl || "",
            downloadChannels: runtimeSettings.downloadChannels || [],
            serviceCatalog: sanitizedCatalog,
          },
        },
        { headers: noStoreHeaders() }
      );
    }

    if (!userId) {
      return NextResponse.json(
        { error: "Missing userId parameter" },
        { status: 400, headers: noStoreHeaders() }
      );
    }

    const builtInService = getBuiltInAPIService();
    await builtInService.initialize();
    if (shouldRefreshCache(url)) {
      builtInService.clearCaches();
    }

    const resolveUserGroup = (dailyRequests: number) => {
      if (dailyRequests >= 500) return 'VIP';
      if (dailyRequests >= 200) return '高级';
      return '基础';
    };

    switch (action) {
      case 'status':
        // Get current service status
        const status = await builtInService.getCurrentServiceStatus(userId);
        return NextResponse.json({ status }, { headers: noStoreHeaders() });

      case 'services':
        // Get available services
        const services = await builtInService.getAvailableServices(userId);
        return NextResponse.json({ services }, { headers: noStoreHeaders() });

      case 'authorization':
        // Check authorization
        const isAuthorized = await builtInService.checkUserAuthorization(userId);
        return NextResponse.json({ isAuthorized }, { headers: noStoreHeaders() });

      case 'config': {
        // Get built-in service config summary for UI (no apiKey)
        const isAuthorized = await builtInService.checkUserAuthorization(userId);
        if (!isAuthorized) {
          return NextResponse.json({ config: null }, { headers: noStoreHeaders() });
        }

        const status = await builtInService.getCurrentServiceStatus(userId);
        const services = await builtInService.getAvailableServices(userId);
        const activeId = status?.isUsingBuiltIn ? status.currentService?.id : null;
        const builtInOption =
          (activeId && services.find((service) => service.id === activeId)) ||
          services.find((service) => service.isBuiltIn && service.isAvailable);

        if (!builtInOption) {
          return NextResponse.json({ config: null }, { headers: noStoreHeaders() });
        }

        const config = getBuiltInServiceConfig(builtInOption.id);
        if (!config) {
          return NextResponse.json({ config: null }, { headers: noStoreHeaders() });
        }

        const runtimeSettings = await getBuiltInRuntimeSettings();
        return NextResponse.json(
          {
            config: {
              id: config.id,
              name: config.name,
              provider: config.provider,
              baseUrl: config.baseUrl,
              model: config.model,
              serviceGatewayUrl: runtimeSettings.serviceGatewayUrl || undefined,
              iopaintUrl: runtimeSettings.iopaintUrls[0] || undefined,
              iopaintUrls: runtimeSettings.iopaintUrls,
              updatePageUrl: runtimeSettings.updatePageUrl || undefined,
              downloadChannels: runtimeSettings.downloadChannels || [],
            },
          },
          { headers: noStoreHeaders() }
        );
      }

      case 'user-summary': {
        // Get current user permission summary
        const isAuthorized = await builtInService.checkUserAuthorization(userId);
        if (!isAuthorized) {
          return NextResponse.json({ user: null }, { headers: noStoreHeaders() });
        }
        const users = await builtInService.getAllAuthorizedUsers();
        const user = findUserByIdentifier(users, userId);
        if (!user) {
          return NextResponse.json({ user: null }, { headers: noStoreHeaders() });
        }
        // 🔧 UPDATED: Now using await for async getUserQuotaUsage
        const quotaUsage = await builtInService.getUserQuotaUsage(userId);
        const dailyRequests = user.permissions?.quotaLimits?.dailyRequests ?? 0;
        const monthlyRequests = user.permissions?.quotaLimits?.monthlyRequests ?? 0;
        return NextResponse.json(
          {
            user: {
              group: resolveUserGroup(dailyRequests),
              dailyRequests,
              monthlyRequests,
              dailyUsed: quotaUsage?.dailyRequests ?? 0,
              monthlyUsed: quotaUsage?.monthlyRequests ?? 0,
            },
          },
          { headers: noStoreHeaders() }
        );
      }

      case 'usage':
        // Get usage statistics
        const usage = builtInService.getUsageStatistics(userId);
        return NextResponse.json({ usage }, { headers: noStoreHeaders() });

      case 'system-stats':
        // Get system-wide statistics (admin only)
        const systemStats = builtInService.getSystemStatistics();
        return NextResponse.json({ systemStats }, { headers: noStoreHeaders() });

      case 'quota-usage':
        // Get user quota usage
        // 🔧 UPDATED: Now using await for async getUserQuotaUsage
        const quotaUsage = await builtInService.getUserQuotaUsage(userId);
        return NextResponse.json({ quotaUsage }, { headers: noStoreHeaders() });

      case 'export-usage':
        // Export usage data (admin only)
        const startDate = url.searchParams.get('startDate') ? new Date(url.searchParams.get('startDate')!) : undefined;
        const endDate = url.searchParams.get('endDate') ? new Date(url.searchParams.get('endDate')!) : undefined;
        const exportData = builtInService.exportUsageData(startDate, endDate);
        return NextResponse.json({ exportData }, { headers: noStoreHeaders() });

      case 'service-health':
        // Check specific service health
        const serviceId = url.searchParams.get('serviceId');
        if (!serviceId) {
          return NextResponse.json(
            { error: "Missing serviceId parameter for health check" },
            { status: 400, headers: noStoreHeaders() }
          );
        }
        const serviceHealth = await builtInService.checkServiceHealth(serviceId);
        return NextResponse.json({ serviceHealth }, { headers: noStoreHeaders() });

      case 'error-recovery-stats':
        // Get error recovery statistics
        const recoveryStats = builtInService.getErrorRecoveryStats();
        return NextResponse.json({ recoveryStats }, { headers: noStoreHeaders() });

      case 'health':
        // Get system health
        const health = await builtInService.getSystemHealthStatus();
        return NextResponse.json({ health }, { headers: noStoreHeaders() });

      default:
        return NextResponse.json(
          { error: "Invalid action parameter" },
          { status: 400, headers: noStoreHeaders() }
        );
    }
  } catch (error) {
    console.error('Built-in service GET error:', error);
    return NextResponse.json(
      { 
        error: "Built-in service request failed",
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}

export async function POST(req: Request) {
  const proxied = await proxyToRemote(req);
  if (proxied) return proxied;

  try {
    const body = await req.json();
    const { userId, action, serviceId, customConfig } = body;

    if (!userId) {
      return NextResponse.json(
        { error: "Missing userId" },
        { status: 400, headers: noStoreHeaders() }
      );
    }

    const builtInService = getBuiltInAPIService();
    await builtInService.initialize();

    switch (action) {
      case 'switch-to-built-in':
        if (!serviceId) {
          return NextResponse.json(
            { error: "Missing serviceId for built-in service switch" },
            { status: 400, headers: noStoreHeaders() }
          );
        }
        
        const builtInResult = await builtInService.switchToBuiltInService(userId, serviceId);
        return NextResponse.json({ result: builtInResult }, { headers: noStoreHeaders() });

      case 'switch-to-custom':
        if (!customConfig) {
          return NextResponse.json(
            { error: "Missing customConfig for custom service switch" },
            { status: 400, headers: noStoreHeaders() }
          );
        }
        
        const customResult = await builtInService.switchToCustomService(userId, customConfig);
        return NextResponse.json({ result: customResult }, { headers: noStoreHeaders() });

      case 'add-user':
        // Admin function to add authorized user
        const { permissions } = body;
        if (!permissions) {
          return NextResponse.json(
            { error: "Missing permissions for user addition" },
            { status: 400, headers: noStoreHeaders() }
          );
        }
        
        await builtInService.addAuthorizedUser(userId, permissions);
        builtInService.clearCaches();
        return NextResponse.json(
          { message: "User added successfully" },
          { headers: noStoreHeaders() }
        );

      case 'remove-user':
        // Admin function to remove authorized user
        await builtInService.removeAuthorizedUser(userId);
        builtInService.clearCaches();
        return NextResponse.json(
          { message: "User removed successfully" },
          { headers: noStoreHeaders() }
        );

      case 'recover-from-error':
        // Attempt error recovery
        const { error, context } = body;
        if (!error || !context) {
          return NextResponse.json(
            { error: "Missing error or context for recovery" },
            { status: 400, headers: noStoreHeaders() }
          );
        }
        
        const recoveryResult = await builtInService.recoverFromError(error, context);
        return NextResponse.json({ recoveryResult }, { headers: noStoreHeaders() });

      case 'fallback-to-custom':
        // Fallback to custom API
        const { originalRequest } = body;
        const fallbackResult = await builtInService.fallbackToCustomAPI(userId, originalRequest);
        return NextResponse.json({ fallbackResult }, { headers: noStoreHeaders() });

      case 'reset-error-recovery':
        // Reset error recovery tracking
        const { targetServiceId } = body;
        builtInService.resetErrorRecovery(userId, targetServiceId);
        return NextResponse.json(
          { message: "Error recovery tracking reset successfully" },
          { headers: noStoreHeaders() }
        );

      default:
        return NextResponse.json(
          { error: "Invalid action" },
          { status: 400, headers: noStoreHeaders() }
        );
    }
  } catch (error) {
    console.error('Built-in service POST error:', error);
    return NextResponse.json(
      { 
        error: "Built-in service operation failed",
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}
