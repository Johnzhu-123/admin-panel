import { requireAdminSession } from "@/app/api/admin/_auth";
﻿/**
 * Admin Dashboard API
 * Provides data for the admin dashboard interface
 */

import { NextResponse } from "next/server";
import { noStoreHeaders } from "@/lib/ai";
import { getBuiltInAPIService } from "@/lib/built-in-api-service";
import { getDatabaseStats } from "@/lib/built-in-api-service/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getQuotaPreset = (userType: string) => {
  const normalized = String(userType || "basic").toLowerCase();
  if (normalized === "vip") {
    return { dailyRequests: 500, monthlyRequests: 15000, concurrentRequests: 20 };
  }
  if (normalized === "premium" || normalized === "advanced") {
    return { dailyRequests: 200, monthlyRequests: 5000, concurrentRequests: 10 };
  }
  return { dailyRequests: 50, monthlyRequests: 1000, concurrentRequests: 3 };
};

const parseUserIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .map((item) => String(item || '').trim())
    .filter((item): item is string => Boolean(item));
  return Array.from(new Set(cleaned));
};

export async function GET(req: Request) {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    console.log(`[Dashboard API] Received request: action=${action}`);

    const builtInService = getBuiltInAPIService();

    try {
      await builtInService.initialize();
      console.log('[Dashboard API] Service initialized successfully');
    } catch (initError) {
      console.error('[Dashboard API] Initialization error:', initError);
      // Continue anyway - some features may still work
    }

    switch (action) {
      case 'overview':
        // Get dashboard overview data
        try {
          const overview = await getDashboardOverview(builtInService);
          console.log('[Dashboard API] Overview data retrieved successfully');
          return NextResponse.json({ overview }, { headers: noStoreHeaders() });
        } catch (overviewError) {
          console.error('[Dashboard API] Overview error:', overviewError);
          // Return default data instead of failing
          return NextResponse.json({
            overview: {
              totalUsers: 0,
              activeUsers: 0,
              totalServices: 0,
              availableServices: 0,
              systemHealth: false,
              totalRequests: 0,
              successRate: 0,
              averageResponseTime: 0,
              requestsLast24h: 0,
              averageResponseTimeLast24h: 0,
              lastUpdated: new Date().toISOString()
            }
          }, { headers: noStoreHeaders() });
        }

      case 'users':
        // Get all users with detailed information
        try {
          const users = await getAllUsersWithStats(builtInService);
          return NextResponse.json({ users }, { headers: noStoreHeaders() });
        } catch (usersError) {
          console.error('[Dashboard API] Users error:', usersError);
          return NextResponse.json({ users: [] }, { headers: noStoreHeaders() });
        }

      case 'usage-stats':
        // Get usage statistics
        try {
          const usageStats = await getUsageStatistics(builtInService);
          return NextResponse.json({ usageStats }, { headers: noStoreHeaders() });
        } catch (statsError) {
          console.error('[Dashboard API] Stats error:', statsError);
          return NextResponse.json({
            usageStats: {
              daily: [],
              hourly: [],
              serviceBreakdown: [],
              summary: {
                totalRequests: 0,
                successRate: 100,
                averageResponseTime: 0,
                activeUsers: 0,
                requestsLast24h: 0,
                averageResponseTimeLast24h: 0,
              }
            }
          }, { headers: noStoreHeaders() });
        }

      case 'system-health':
        // Get system health metrics
        try {
          const health = await builtInService.getSystemHealthStatus();
          return NextResponse.json({ health }, { headers: noStoreHeaders() });
        } catch (healthError) {
          console.error('[Dashboard API] Health error:', healthError);
          return NextResponse.json({
            health: {
              isHealthy: false,
              services: {},
              permissions: false,
              storage: false,
              lastChecked: new Date()
            }
          }, { headers: noStoreHeaders() });
        }

      default:
        return NextResponse.json(
          { error: "Invalid action parameter" },
          { status: 400, headers: noStoreHeaders() }
        );
    }
  } catch (error) {
    console.error('[Dashboard API] Fatal error:', error);
    return NextResponse.json(
      {
        error: "Dashboard request failed",
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: "Please check Vercel logs for more details"
      },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}

export async function POST(req: Request) {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    const body = await req.json();
    const { action, userId, userData } = body;

    console.log('[Dashboard POST] Action:', action, 'UserId:', userId);
    console.log('[Dashboard POST] UserData:', JSON.stringify(userData, null, 2));

    const builtInService = getBuiltInAPIService();

    try {
      await builtInService.initialize();
      console.log('[Dashboard POST] Service initialized successfully');
    } catch (initError) {
      console.error('[Dashboard POST] Initialization error:', initError);
      throw new Error(`Service initialization failed: ${initError instanceof Error ? initError.message : 'Unknown error'}`);
    }

    switch (action) {
      case 'batch-upsert-users':
        try {
          const users = Array.isArray(body?.users) ? body.users : [];
          if (!users.length) {
            return NextResponse.json(
              { error: "users is required and must be a non-empty array" },
              { status: 400, headers: noStoreHeaders() }
            );
          }

          const { updateUserStatus } = await import('@/lib/built-in-api-service/db');
          const errors: string[] = [];
          let success = 0;

          for (const raw of users) {
            try {
              const userId = String(raw?.userId || raw?.email || '').trim();
              if (!userId) throw new Error('missing userId/email');

              const email = String(raw?.email || userId).trim();
              const name = String(raw?.name || email).trim();
              const userType = String(raw?.userType || 'basic');
              const status = String(raw?.status || 'active').toLowerCase() === 'suspended' ? 'suspended' : 'active';
              const quota = getQuotaPreset(userType);

              await builtInService.addAuthorizedUser(userId, {
                name,
                email,
                canUseBuiltInServices: true,
                allowedServices: ['gemini-built-in'],
                quotaLimits: quota,
                grantedAt: new Date().toISOString(),
                grantedBy: 'admin',
              });
              await autoEnableBuiltInService(builtInService, userId);
              if (status === 'suspended') {
                await updateUserStatus(userId, 'suspended');
              }
              success++;
            } catch (itemErr) {
              errors.push(itemErr instanceof Error ? itemErr.message : 'Unknown error');
            }
          }

          builtInService.clearCaches();
          return NextResponse.json(
            {
              message: 'Batch upsert completed',
              total: users.length,
              success,
              failed: users.length - success,
              errors,
            },
            { headers: noStoreHeaders() }
          );
        } catch (batchError) {
          throw new Error(`Failed to batch upsert users: ${batchError instanceof Error ? batchError.message : 'Unknown error'}`);
        }

      case 'batch-remove-users':
        try {
          const userIds = parseUserIds(body?.userIds);
          if (!userIds.length) {
            return NextResponse.json(
              { error: "userIds is required and must be a non-empty array" },
              { status: 400, headers: noStoreHeaders() }
            );
          }

          const errors: string[] = [];
          let success = 0;
          for (const userId of userIds) {
            try {
              await builtInService.removeAuthorizedUser(userId);
              success++;
            } catch (itemErr) {
              errors.push(`${userId}: ${itemErr instanceof Error ? itemErr.message : 'Unknown error'}`);
            }
          }

          builtInService.clearCaches();
          return NextResponse.json(
            {
              message: 'Batch remove completed',
              total: userIds.length,
              success,
              failed: userIds.length - success,
              errors,
            },
            { headers: noStoreHeaders() }
          );
        } catch (batchError) {
          throw new Error(`Failed to batch remove users: ${batchError instanceof Error ? batchError.message : 'Unknown error'}`);
        }

      case 'batch-update-user-type':
        try {
          const userIds = parseUserIds(body?.userIds);
          if (!userIds.length) {
            return NextResponse.json(
              { error: "userIds is required and must be a non-empty array" },
              { status: 400, headers: noStoreHeaders() }
            );
          }

          const userType = String(body?.userType || 'basic');
          const status = typeof body?.status === 'string'
            ? (String(body.status).toLowerCase() === 'suspended' ? 'suspended' : 'active')
            : null;
          const quota = getQuotaPreset(userType);
          const existingUsers = await builtInService.getAllAuthorizedUsers();
          const usersById = new Map(existingUsers.map((item: any) => [item.userId, item]));
          const { updateUserStatus } = await import('@/lib/built-in-api-service/db');

          const errors: string[] = [];
          let success = 0;
          for (const userId of userIds) {
            try {
              const existing = usersById.get(userId);
              if (!existing) {
                throw new Error('User not found');
              }

              await builtInService.addAuthorizedUser(userId, {
                name: existing.name || existing.email || userId,
                email: existing.email || userId,
                canUseBuiltInServices: true,
                allowedServices: ['gemini-built-in'],
                quotaLimits: quota,
                grantedAt: existing.permissions?.grantedAt || new Date().toISOString(),
                grantedBy: existing.permissions?.grantedBy || 'admin',
              });

              if (status) {
                await updateUserStatus(userId, status);
              }
              success++;
            } catch (itemErr) {
              errors.push(`${userId}: ${itemErr instanceof Error ? itemErr.message : 'Unknown error'}`);
            }
          }

          builtInService.clearCaches();
          return NextResponse.json(
            {
              message: 'Batch permission update completed',
              total: userIds.length,
              success,
              failed: userIds.length - success,
              errors,
            },
            { headers: noStoreHeaders() }
          );
        } catch (batchError) {
          throw new Error(`Failed to batch update user permissions: ${batchError instanceof Error ? batchError.message : 'Unknown error'}`);
        }

      case 'add-user':
        try {
          // Restructure userData to match expected format
          const userDataForAdd = {
            name: userData.name,
            email: userData.email,
            canUseBuiltInServices: userData.canUseBuiltInServices,
            allowedServices: userData.allowedServices,
            quotaLimits: userData.quotaLimits,
            grantedAt: userData.grantedAt,
            grantedBy: userData.grantedBy
          };

          console.log('[Dashboard POST] Adding user with data:', JSON.stringify(userDataForAdd, null, 2));
          await builtInService.addAuthorizedUser(userId, userDataForAdd);
          console.log('[Dashboard POST] User added successfully');

          await autoEnableBuiltInService(builtInService, userId);
          console.log('[Dashboard POST] Auto-enable completed');
          builtInService.clearCaches();

          return NextResponse.json(
            { message: "User added successfully", userId },
            { headers: noStoreHeaders() }
          );
        } catch (addError) {
          console.error('[Dashboard POST] Add user error:', addError);
          throw new Error(`Failed to add user: ${addError instanceof Error ? addError.message : 'Unknown error'}`);
        }

      case 'update-user':
        try {
          // Restructure userData for update
          const userDataForUpdate = {
            name: userData.name,
            email: userData.email,
            canUseBuiltInServices: userData.canUseBuiltInServices,
            allowedServices: userData.allowedServices,
            quotaLimits: userData.quotaLimits,
            grantedAt: userData.grantedAt,
            grantedBy: userData.grantedBy
          };

          console.log('[Dashboard POST] Updating user with data:', JSON.stringify(userDataForUpdate, null, 2));
          await builtInService.addAuthorizedUser(userId, userDataForUpdate);
          console.log('[Dashboard POST] User updated successfully');
          builtInService.clearCaches();

          return NextResponse.json(
            { message: "User updated successfully", userId },
            { headers: noStoreHeaders() }
          );
        } catch (updateError) {
          console.error('[Dashboard POST] Update user error:', updateError);
          throw new Error(`Failed to update user: ${updateError instanceof Error ? updateError.message : 'Unknown error'}`);
        }

      case 'remove-user':
        try {
          console.log('[Dashboard POST] Removing user:', userId);
          await builtInService.removeAuthorizedUser(userId);
          console.log('[Dashboard POST] User removed successfully');
          builtInService.clearCaches();

          return NextResponse.json(
            { message: "User removed successfully", userId },
            { headers: noStoreHeaders() }
          );
        } catch (removeError) {
          console.error('[Dashboard POST] Remove user error:', removeError);
          throw new Error(`Failed to remove user: ${removeError instanceof Error ? removeError.message : 'Unknown error'}`);
        }

      case 'toggle-status':
        try {
          const { status } = body;
          if (!status || (status !== 'active' && status !== 'suspended')) {
            throw new Error('Invalid status. Must be "active" or "suspended"');
          }

          console.log('[Dashboard POST] Toggling user status:', userId, '->', status);

          // Import the updateUserStatus function
          const { updateUserStatus } = await import('@/lib/built-in-api-service/db');
          await updateUserStatus(userId, status);

          // Clear the service cache to reflect the change immediately
          builtInService.clearCaches();

          console.log('[Dashboard POST] User status toggled successfully');

          return NextResponse.json(
            { message: `User ${status === 'active' ? 'enabled' : 'suspended'} successfully`, userId, status },
            { headers: noStoreHeaders() }
          );
        } catch (toggleError) {
          console.error('[Dashboard POST] Toggle status error:', toggleError);
          throw new Error(`Failed to toggle user status: ${toggleError instanceof Error ? toggleError.message : 'Unknown error'}`);
        }

      default:
        return NextResponse.json(
          { error: "Invalid action" },
          { status: 400, headers: noStoreHeaders() }
        );
    }
  } catch (error) {
    console.error('[Dashboard POST] Fatal error:', error);
    console.error('[Dashboard POST] Error stack:', error instanceof Error ? error.stack : 'No stack trace');

    return NextResponse.json(
      {
        error: "Dashboard operation failed",
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: "Check Vercel function logs for detailed error information"
      },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}

type DashboardUsageSummary = {
  totalRequests: number;
  successRate: number;
  averageResponseTime: number;
  activeUsers: number;
  requestsLast24h: number;
  averageResponseTimeLast24h: number;
  lastRequestAt: string | null;
};

type DashboardServiceBreakdown = Array<{
  service: string;
  label: string;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  successRate: number;
}>;

const FALLBACK_USAGE_SUMMARY: DashboardUsageSummary = {
  totalRequests: 0,
  successRate: 100,
  averageResponseTime: 0,
  activeUsers: 0,
  requestsLast24h: 0,
  averageResponseTimeLast24h: 0,
  lastRequestAt: null,
};

const normalizeUsageService = (serviceId: unknown) => {
  const raw = String(serviceId || '').trim().toLowerCase();
  if (raw.startsWith('tts')) return { service: 'tts', label: '云端 TTS' };
  if (raw.startsWith('video')) return { service: 'video', label: '视频生成' };
  if (raw.startsWith('image')) return { service: 'image', label: '图像生成' };
  if (
    raw === 'built-in-default' ||
    raw === 'gemini-built-in' ||
    raw.includes('image') ||
    raw.includes('gemini')
  ) {
    return { service: 'image', label: '图像生成' };
  }
  return { service: raw || 'other', label: raw || '其它服务' };
};

async function getDashboardUsageSummary(): Promise<DashboardUsageSummary> {
  try {
    const { sql } = await import('@vercel/postgres');
    const { rows } = await sql`
      SELECT
        COUNT(*)::int AS total_requests,
        COALESCE(ROUND(AVG(NULLIF(response_time, 0)))::int, 0) AS average_response_time,
        COALESCE(
          ROUND(
            AVG(CASE WHEN success THEN 100.0 ELSE 0 END)
            FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')
          )::int,
          100
        ) AS success_rate_last_7d,
        COUNT(DISTINCT CASE
          WHEN created_at >= NOW() - INTERVAL '30 days' THEN user_id
          ELSE NULL
        END)::int AS active_users_last_30d,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS requests_last_24h,
        COALESCE(
          ROUND(
            AVG(NULLIF(response_time, 0)) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')
          )::int,
          0
        ) AS avg_response_time_last_24h,
        MAX(created_at) AS last_request_at
      FROM api_usage_records
    `;

    const row = rows[0] || {};
    const toNumber = (value: unknown, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const rawLastRequestAt = row.last_request_at;
    const parsedLastRequestAt =
      rawLastRequestAt instanceof Date
        ? rawLastRequestAt.toISOString()
        : rawLastRequestAt
          ? new Date(String(rawLastRequestAt)).toISOString()
          : null;

    return {
      totalRequests: toNumber(row.total_requests, 0),
      successRate: toNumber(row.success_rate_last_7d, 100),
      averageResponseTime: toNumber(row.average_response_time, 0),
      activeUsers: toNumber(row.active_users_last_30d, 0),
      requestsLast24h: toNumber(row.requests_last_24h, 0),
      averageResponseTimeLast24h: toNumber(row.avg_response_time_last_24h, 0),
      lastRequestAt: parsedLastRequestAt,
    };
  } catch (error) {
    console.error('[Dashboard] Failed to aggregate usage summary from database:', error);
    return FALLBACK_USAGE_SUMMARY;
  }
}

async function getDashboardServiceBreakdown(): Promise<DashboardServiceBreakdown> {
  try {
    const { sql } = await import('@vercel/postgres');
    const { rows } = await sql`
      SELECT
        service_id,
        COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE success = true)::int AS successful_requests,
        COUNT(*) FILTER (WHERE success = false)::int AS failed_requests,
        COALESCE(ROUND(AVG(NULLIF(response_time, 0)))::int, 0) AS average_response_time
      FROM api_usage_records
      GROUP BY service_id
      ORDER BY requests DESC
    `;

    const grouped = new Map<string, {
      service: string;
      label: string;
      requests: number;
      successfulRequests: number;
      failedRequests: number;
      responseTimeTotal: number;
      responseTimeWeight: number;
    }>();

    for (const row of rows) {
      const normalized = normalizeUsageService(row.service_id);
      const requests = Number(row.requests) || 0;
      const successfulRequests = Number(row.successful_requests) || 0;
      const failedRequests = Number(row.failed_requests) || 0;
      const averageResponseTime = Number(row.average_response_time) || 0;
      const current =
        grouped.get(normalized.service) || {
          ...normalized,
          requests: 0,
          successfulRequests: 0,
          failedRequests: 0,
          responseTimeTotal: 0,
          responseTimeWeight: 0,
        };
      current.requests += requests;
      current.successfulRequests += successfulRequests;
      current.failedRequests += failedRequests;
      if (averageResponseTime > 0 && requests > 0) {
        current.responseTimeTotal += averageResponseTime * requests;
        current.responseTimeWeight += requests;
      }
      grouped.set(normalized.service, current);
    }

    return Array.from(grouped.values())
      .map((item) => ({
        service: item.service,
        label: item.label,
        requests: item.requests,
        successfulRequests: item.successfulRequests,
        failedRequests: item.failedRequests,
        averageResponseTime:
          item.responseTimeWeight > 0
            ? Math.round(item.responseTimeTotal / item.responseTimeWeight)
            : 0,
        successRate:
          item.requests > 0
            ? Math.round((item.successfulRequests / item.requests) * 100)
            : 100,
      }))
      .sort((a, b) => b.requests - a.requests);
  } catch (error) {
    console.error('[Dashboard] Failed to aggregate service breakdown:', error);
    return [];
  }
}

async function getDashboardOverview(service: any) {
  try {
    console.log('[Dashboard] Getting overview data...');

    // Get data from service
    const configSummary = await service.getConfigurationSummary();
    console.log('[Dashboard] Config summary:', configSummary);

    const systemHealth = await service.getSystemHealthStatus();
    console.log('[Dashboard] System health:', systemHealth);

    const systemStats = service.getSystemStatistics();
    console.log('[Dashboard] System stats:', systemStats);
    const usageSummary = await getDashboardUsageSummary();

    // Also get direct database stats for comparison
    try {
      const dbStats = await getDatabaseStats();
      console.log('[Dashboard] Direct DB stats:', dbStats);

      // Use database stats if available, otherwise use service stats
      const totalUsers = dbStats.totalUsers > 0 ? dbStats.totalUsers : (configSummary.totalUsers || 0);
      const activeUsers = dbStats.activeUsers > 0 ? dbStats.activeUsers : (configSummary.activeUsers || 0);
      const resolvedAverageResponseTime =
        usageSummary.averageResponseTime > 0
          ? usageSummary.averageResponseTime
          : (systemStats.averageResponseTime || 0);
      const resolvedAverageResponseTimeLast24h =
        usageSummary.averageResponseTimeLast24h > 0
          ? usageSummary.averageResponseTimeLast24h
          : resolvedAverageResponseTime;

      console.log('[Dashboard] Final user counts - total:', totalUsers, 'active:', activeUsers);

      return {
        totalUsers,
        activeUsers,
        totalServices: configSummary.totalServices || 0,
        availableServices: configSummary.availableServices || 0,
        systemHealth: systemHealth.isHealthy || false,
        totalRequests: usageSummary.totalRequests || systemStats.totalRequests || 0,
        successRate:
          usageSummary.totalRequests > 0
            ? usageSummary.successRate
            : (systemStats.successRate || 100),
        averageResponseTime: resolvedAverageResponseTime,
        requestsLast24h: usageSummary.requestsLast24h,
        averageResponseTimeLast24h: resolvedAverageResponseTimeLast24h,
        lastUpdated: usageSummary.lastRequestAt || new Date().toISOString()
      };
    } catch (dbError) {
      console.error('[Dashboard] Failed to get direct DB stats:', dbError);
      const resolvedAverageResponseTime =
        usageSummary.averageResponseTime > 0
          ? usageSummary.averageResponseTime
          : (systemStats.averageResponseTime || 0);
      const resolvedAverageResponseTimeLast24h =
        usageSummary.averageResponseTimeLast24h > 0
          ? usageSummary.averageResponseTimeLast24h
          : resolvedAverageResponseTime;
      // Fall back to service stats
      return {
        totalUsers: configSummary.totalUsers || 0,
        activeUsers: configSummary.activeUsers || 0,
        totalServices: configSummary.totalServices || 0,
        availableServices: configSummary.availableServices || 0,
        systemHealth: systemHealth.isHealthy || false,
        totalRequests: usageSummary.totalRequests || systemStats.totalRequests || 0,
        successRate:
          usageSummary.totalRequests > 0
            ? usageSummary.successRate
            : (systemStats.successRate || 100),
        averageResponseTime: resolvedAverageResponseTime,
        requestsLast24h: usageSummary.requestsLast24h,
        averageResponseTimeLast24h: resolvedAverageResponseTimeLast24h,
        lastUpdated: usageSummary.lastRequestAt || new Date().toISOString()
      };
    }
  } catch (error) {
    console.error('[getDashboardOverview] Error:', error);
    // Return safe defaults
    return {
      totalUsers: 0,
      activeUsers: 0,
      totalServices: 0,
      availableServices: 0,
      systemHealth: false,
      totalRequests: 0,
      successRate: 0,
      averageResponseTime: 0,
      requestsLast24h: 0,
      averageResponseTimeLast24h: 0,
      lastUpdated: new Date().toISOString()
    };
  }
}

async function getAllUsersWithStats(service: any) {
  const allUsers = await service.getAllAuthorizedUsers();

  // 馃敡 UPDATED: Get usage stats from database
  const { getAllUsersUsageStats } = await import('@/lib/built-in-api-service/db');
  const allUsageStats = await getAllUsersUsageStats();

  return allUsers.map(user => {
    // Find usage stats for this user from database
    const dbUsage = allUsageStats.find(stat => stat.userId === user.userId);

    // Get memory-based stats as fallback
    const memoryStats = service.getUsageStatistics(user.userId);

    // Calculate remaining quota
    const dailyLimit = user.permissions?.quotaLimits?.dailyRequests || 500;
    const monthlyLimit = user.permissions?.quotaLimits?.monthlyRequests || 15000;
    const dailyUsed = dbUsage?.dailyUsage || 0;
    const monthlyUsed = dbUsage?.monthlyUsage || 0;

    // 🔧 FIX (single-user stats render as 0 in admin panel):
    // 旧实现把 service.getUsageStatistics(userId)（内存）当作 stats 主源，
    // serverless 容器复用 / 实例重启后内存归零，导致用户管理页面所有用户显示 0。
    // 数据库的 api_usage_records 表持久化了每次请求 (user_id, success, response_time)，
    // getAllUsersUsageStats 现在已返回 totalRequests/successful/failed/averageResponseTime/lastUsed
    // 直接读 DB 聚合即可。memory 仅作为 dailyStats / recentRequests 等辅助字段的兜底。
    const dbHasUsage = !!dbUsage && (dbUsage.totalRequests > 0 || dbUsage.lastUsed);
    const stats = dbHasUsage
      ? {
          totalRequests: dbUsage!.totalRequests,
          successfulRequests: dbUsage!.successfulRequests,
          failedRequests: dbUsage!.failedRequests,
          averageResponseTime: dbUsage!.averageResponseTime,
          lastUsed: dbUsage!.lastUsed,
        }
      : memoryStats || {
          totalRequests: dailyUsed + monthlyUsed,
          successfulRequests: 0,
          failedRequests: 0,
          averageResponseTime: 0,
          lastUsed: null,
        };

    return {
      ...user,
      usage: {
        dailyUsed,
        monthlyUsed,
        dailyRemaining: Math.max(0, dailyLimit - dailyUsed),
        monthlyRemaining: Math.max(0, monthlyLimit - monthlyUsed)
      },
      stats,
    };
  });
}

// 馃敡 UPDATED: 浣跨敤鐪熷疄鏁版嵁搴撴暟鎹浛浠ｆā鎷熸暟鎹?
async function getUsageStatistics(service: any) {
  const systemStats = service.getSystemStatistics();
  const { sql } = await import('@vercel/postgres');

  let dailyStats: any[] = [];
  let hourlyStats: any[] = [];

  try {
    // 鑾峰彇杩囧幓30澶╃殑鐪熷疄鏁版嵁
    const { rows: dailyRows } = await sql`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as requests,
        COUNT(DISTINCT user_id) as users
      FROM api_usage_records
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `;

    // 鑾峰彇浠婂ぉ24灏忔椂鐨勭湡瀹炴暟鎹?
    const { rows: hourlyRows } = await sql`
      SELECT 
        EXTRACT(HOUR FROM created_at)::int as hour,
        COUNT(*) as requests,
        COALESCE(AVG(NULLIF(response_time, 0)), 0)::int as response_time
      FROM api_usage_records
      WHERE created_at >= CURRENT_DATE
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY hour ASC
    `;

    dailyStats = dailyRows.map(r => ({
      date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
      requests: parseInt(String(r.requests)) || 0,
      users: parseInt(String(r.users)) || 0
    }));

    hourlyStats = hourlyRows.map(r => ({
      hour: parseInt(String(r.hour)) || 0,
      requests: parseInt(String(r.requests)) || 0,
      responseTime: parseInt(String(r.response_time)) || 0
    }));

    console.log('[Dashboard] Real usage data loaded:', {
      dailyCount: dailyStats.length,
      hourlyCount: hourlyStats.length
    });
  } catch (error) {
    console.error('[Dashboard] Failed to load real usage data, using fallback:', error);

    // 濡傛灉鏁版嵁搴撴煡璇㈠け璐ワ紝鐢熸垚绌烘暟鎹?
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      dailyStats.push({
        date: date.toISOString().split('T')[0],
        requests: 0,
        users: 0
      });
    }

    for (let i = 0; i < 24; i++) {
      hourlyStats.push({
        hour: i,
        requests: 0,
        responseTime: 0
      });
    }
  }

  // 璁＄畻鐪熷疄鐨勬垚鍔熺巼
  const usageSummary = await getDashboardUsageSummary();
  const serviceBreakdown = await getDashboardServiceBreakdown();
  const fallbackTotalRequests = dailyStats.reduce((sum, d) => sum + d.requests, 0);
  const totalRequests = usageSummary.totalRequests || systemStats.totalRequests || fallbackTotalRequests;
  const finalSuccessRate =
    usageSummary.totalRequests > 0
      ? usageSummary.successRate
      : (systemStats.successRate || 100);
  const hourlyResponseSamples = hourlyStats
    .map((item) => Number(item.responseTime || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const hourlyAverageResponseTime =
    hourlyResponseSamples.length > 0
      ? Math.round(
          hourlyResponseSamples.reduce((sum, value) => sum + value, 0) /
            hourlyResponseSamples.length
        )
      : 0;
  const finalAverageResponseTime =
    usageSummary.averageResponseTime > 0
      ? usageSummary.averageResponseTime
      : (systemStats.averageResponseTime > 0
          ? Math.round(systemStats.averageResponseTime)
          : hourlyAverageResponseTime);
  const finalAverageResponseTimeLast24h =
    usageSummary.averageResponseTimeLast24h > 0
      ? usageSummary.averageResponseTimeLast24h
      : (hourlyAverageResponseTime > 0
          ? hourlyAverageResponseTime
          : finalAverageResponseTime);
  const finalActiveUsers = usageSummary.activeUsers || systemStats.activeUsers || 0;

  return {
    daily: dailyStats,
    hourly: hourlyStats,
    serviceBreakdown,
    summary: {
      totalRequests,
      successRate: finalSuccessRate,
      averageResponseTime: finalAverageResponseTime,
      activeUsers: finalActiveUsers,
      requestsLast24h: usageSummary.requestsLast24h,
      averageResponseTimeLast24h: finalAverageResponseTimeLast24h,
    }
  };
}

async function autoEnableBuiltInService(service: any, userId: string) {
  try {
    console.log(`[AutoEnable] Attempting to auto-enable built-in service for user: ${userId}`);

    // Get available services for this user
    const services = await service.getAvailableServices(userId);
    console.log(`[AutoEnable] Available services:`, services.map((s: any) => ({ id: s.id, isBuiltIn: s.isBuiltIn, isAvailable: s.isAvailable })));

    const builtInService = services.find(
      (option: any) => option.isBuiltIn && option.isAvailable
    );

    if (!builtInService) {
      console.log('[AutoEnable] No available built-in service found');
      return;
    }

    console.log(`[AutoEnable] Found built-in service: ${builtInService.id}`);

    // Check current status
    const status = await service.getCurrentServiceStatus(userId);
    console.log(`[AutoEnable] Current service status:`, {
      isUsingBuiltIn: status?.isUsingBuiltIn,
      currentServiceId: status?.currentService?.id
    });

    // Auto-enable if:
    // 1. User is not already using built-in service
    // 2. User is using default custom configuration OR has no service configured yet
    const isDefaultCustom =
      !status ||
      !status.currentService ||
      (status.currentService.id === 'custom' &&
        status.currentService.description === 'Use your own API keys and configuration');

    if (!status.isUsingBuiltIn && isDefaultCustom) {
      console.log(`[AutoEnable] Switching user to built-in service: ${builtInService.id}`);
      await service.switchToBuiltInService(userId, builtInService.id);
      console.log(`[AutoEnable] Successfully switched user to built-in service`);
    } else {
      console.log('[AutoEnable] User already using built-in service or has custom configuration');
    }
  } catch (error) {
    console.error('[AutoEnable] Auto-enable built-in service failed:', error);
    console.error('[AutoEnable] Error details:', error instanceof Error ? error.message : 'Unknown');
    // Don't throw - this is a convenience feature, not critical
  }
}
