/**
 * Built-in API Service Management Endpoint
 * Handles built-in API service configuration and switching
 * Validates: Requirements 1.1, 1.2, 3.2, 5.1
 */

import { NextResponse } from "next/server";
import { noStoreHeaders } from "@/lib/ai";
import { getBuiltInAPIService } from "@/lib/built-in-api-service";
import {
  getBuiltInRuntimeSettings,
  sanitizeServiceCatalog,
  getSubtaskPresets,
  getUserServiceUsageStats,
} from "@/lib/built-in-api-service/db";
import { requireAdminSession } from "@/app/api/admin/_auth";
import {
  requireServicePrincipal,
  ServicePrincipal,
  ServicePrincipalError,
} from "@/lib/auth/service-principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

const GET_ADMIN_ACTIONS = new Set([
  "system-stats",
  "export-usage",
  "service-health",
  "error-recovery-stats",
  "health",
]);
const POST_ADMIN_ACTIONS = new Set([
  "add-user",
  "remove-user",
  "recover-from-error",
  "reset-error-recovery",
]);

const principalMatchesClaim = (principal: ServicePrincipal, claimed?: string | null) => {
  if (!claimed) return true;
  const normalized = normalizeIdentifier(claimed);
  return (
    normalized === normalizeIdentifier(principal.userId) ||
    Boolean(principal.email && normalized === normalizeIdentifier(principal.email))
  );
};

const principalErrorResponse = (error: unknown) => {
  if (error instanceof ServicePrincipalError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status, headers: noStoreHeaders() }
    );
  }
  return null;
};

export async function GET(req: Request) {
  try {
    const principal = await requireServicePrincipal(req);
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const claimedUserId = url.searchParams.get('userId');
    if (!principalMatchesClaim(principal, claimedUserId)) {
      return NextResponse.json(
        { error: "Claimed user does not match the authenticated principal" },
        { status: 403, headers: noStoreHeaders() }
      );
    }
    const userId = principal.userId;

    if (action && GET_ADMIN_ACTIONS.has(action)) {
      const unauthorized = await requireAdminSession();
      if (unauthorized) return unauthorized;
    }

    if (action === 'runtime-settings') {
      const runtimeSettings = await getBuiltInRuntimeSettings();
      // 新 schema: 每类返回 { displayName, description, defaultSubtaskId, subtasks: { ... 不含 apiKey ... } }
      const sanitizedCatalog = sanitizeServiceCatalog(runtimeSettings.serviceCatalog, {
        includeKeyMask: false,
      });
      return NextResponse.json(
        {
          settings: {
            serviceGatewayUrl: runtimeSettings.serviceGatewayUrl,
            updatePageUrl: runtimeSettings.updatePageUrl || "",
            downloadChannels: runtimeSettings.downloadChannels || [],
            serviceCatalog: sanitizedCatalog,
            subtaskPresets: getSubtaskPresets(),
          },
        },
        { headers: noStoreHeaders() }
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

        const runtimeSettings = await getBuiltInRuntimeSettings();
        const sanitizedCatalogForConfig = sanitizeServiceCatalog(
          runtimeSettings.serviceCatalog,
          { includeKeyMask: false }
        );
        const categories: Record<
          string,
          {
            displayName: string;
            defaultSubtaskId: string;
            baseUrl: string;
            model: string;
            models: string[]; // 🔧 NEW (2026-05 #21): 该分类全部模型聚合
            isEnabled: boolean;
            subtasks: Array<{
              id: string;
              displayName: string;
              baseUrl: string;
              model: string;
              models: string[]; // 🔧 NEW (2026-05 #21): 该子任务的模型列表
              isEnabled: boolean;
            }>;
          }
        > = {};
        for (const [category, cfg] of Object.entries(sanitizedCatalogForConfig)) {
          const defaultSubtaskId = cfg.defaultSubtaskId;
          const defaultSubtask =
            cfg.subtasks[defaultSubtaskId] ||
            Object.values(cfg.subtasks)[0];
          // 🔧 NEW (2026-05 #21): 把该分类所有子任务的 models 聚合（默认子任务排首位、去重）
          const aggregatedModels: string[] = [];
          const seenModels = new Set<string>();
          const orderedSubtasks = Object.values(cfg.subtasks).sort((a, b) =>
            a.id === defaultSubtaskId ? -1 : b.id === defaultSubtaskId ? 1 : 0
          );
          for (const s of orderedSubtasks) {
            const list = Array.isArray(s.models) ? s.models : [];
            const candidates = list.length ? list : (s.model ? [s.model] : []);
            for (const m of candidates) {
              const t = (m || '').trim();
              if (!t || seenModels.has(t)) continue;
              seenModels.add(t);
              aggregatedModels.push(t);
            }
          }
          categories[category] = {
            displayName: cfg.displayName,
            defaultSubtaskId,
            baseUrl: defaultSubtask?.baseUrl || '',
            model: defaultSubtask?.model || '',
            models: aggregatedModels,
            isEnabled: defaultSubtask?.isEnabled ?? false,
            subtasks: Object.values(cfg.subtasks).map((subtask) => ({
              id: subtask.id,
              displayName: subtask.displayName,
              baseUrl: subtask.baseUrl,
              model: subtask.model,
              models: Array.isArray(subtask.models) && subtask.models.length
                ? subtask.models
                : (subtask.model ? [subtask.model] : []),
              isEnabled: subtask.isEnabled,
            })),
          };
        }
        return NextResponse.json(
          {
            config: {
              id: builtInOption.id,
              name: builtInOption.name,
              // ⚠️ 不再返回顶层 provider/baseUrl/model（已废弃）：
              // 真值由 categories[*].subtasks[defaultSubtaskId].{baseUrl,model} 提供，
              // 早期 SERVICE_CONFIGS 里硬编码的 gemini/zeabur 网关只会引发误解。
              serviceGatewayUrl: runtimeSettings.serviceGatewayUrl || undefined,
              updatePageUrl: runtimeSettings.updatePageUrl || undefined,
              downloadChannels: runtimeSettings.downloadChannels || [],
              categories,
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
        const serviceUsage = await getUserServiceUsageStats(user.userId || userId, user.email);
        const serviceDailyUsed = serviceUsage.reduce((sum, item) => sum + (item.dailyUsage || 0), 0);
        const serviceMonthlyUsed = serviceUsage.reduce((sum, item) => sum + (item.monthlyUsage || 0), 0);
        const dailyRequests = user.permissions?.quotaLimits?.dailyRequests ?? 0;
        const monthlyRequests = user.permissions?.quotaLimits?.monthlyRequests ?? 0;
        return NextResponse.json(
          {
            user: {
              group: resolveUserGroup(dailyRequests),
              dailyRequests,
              monthlyRequests,
              dailyUsed: serviceDailyUsed || quotaUsage?.dailyRequests || 0,
              monthlyUsed: serviceMonthlyUsed || quotaUsage?.monthlyRequests || 0,
              serviceUsage,
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
    const authError = principalErrorResponse(error);
    if (authError) return authError;
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
  try {
    const principal = await requireServicePrincipal(req);
    const body = await req.json();
    const { userId: claimedUserId, action, serviceId, customConfig } = body;
    const isAdminAction = POST_ADMIN_ACTIONS.has(action);
    if (!isAdminAction && !principalMatchesClaim(principal, claimedUserId)) {
      return NextResponse.json(
        { error: "Claimed user does not match the authenticated principal" },
        { status: 403, headers: noStoreHeaders() }
      );
    }
    const userId =
      typeof claimedUserId === "string" && isAdminAction
        ? claimedUserId
        : principal.userId;

    if (isAdminAction) {
      const unauthorized = await requireAdminSession();
      if (unauthorized) return unauthorized;
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
    const authError = principalErrorResponse(error);
    if (authError) return authError;
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
