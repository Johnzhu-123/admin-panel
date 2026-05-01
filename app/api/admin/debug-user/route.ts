import { requireAdminSession } from "@/app/api/admin/_auth";
/**
 * Debug User Authorization API
 * Helps diagnose authorization issues
 */

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getBuiltInAPIService } from '@/lib/built-in-api-service';

export async function GET(req: Request) {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId') || 'zhuzhu1528875@gmail.com';

    console.log(`[Debug] Checking authorization for user: ${userId}`);

    // 1. Check database directly
    console.log('[Debug] Step 1: Checking database...');
    const { rows } = await sql`
      SELECT * FROM authorized_users WHERE user_id = ${userId}
    `;

    const dbUser = rows[0];
    console.log('[Debug] Database user:', JSON.stringify(dbUser, null, 2));

    // 2. Check through service
    console.log('[Debug] Step 2: Checking through service...');
    const builtInService = getBuiltInAPIService();
    await builtInService.initialize();

    const isAuthorized = await builtInService.checkUserAuthorization(userId);
    console.log('[Debug] Service authorization result:', isAuthorized);

    const allUsers = await builtInService.getAllAuthorizedUsers();
    console.log('[Debug] Total users in service:', allUsers.length);
    
    const serviceUser = allUsers.find(u => u.userId === userId);
    console.log('[Debug] Service user:', JSON.stringify(serviceUser, null, 2));

    // 3. Get available services
    console.log('[Debug] Step 3: Getting available services...');
    const services = await builtInService.getAvailableServices(userId);
    console.log('[Debug] Available services:', services.length);

    // 4. Get current status
    console.log('[Debug] Step 4: Getting current status...');
    const status = await builtInService.getCurrentServiceStatus(userId);
    console.log('[Debug] Current status:', JSON.stringify(status, null, 2));

    return NextResponse.json({
      userId,
      database: {
        found: !!dbUser,
        user: dbUser ? {
          user_id: dbUser.user_id,
          email: dbUser.email,
          name: dbUser.name,
          status: dbUser.status,
          can_use_built_in_services: dbUser.can_use_built_in_services,
          allowed_services: dbUser.allowed_services,
          daily_requests: dbUser.daily_requests,
          monthly_requests: dbUser.monthly_requests,
        } : null
      },
      service: {
        isAuthorized,
        totalUsers: allUsers.length,
        user: serviceUser,
        availableServices: services.length,
        currentStatus: status
      },
      diagnosis: {
        databaseUserExists: !!dbUser,
        serviceUserExists: !!serviceUser,
        isAuthorized,
        hasServices: services.length > 0,
        issues: []
      }
    });

  } catch (error) {
    console.error('[Debug] Error:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    }, { status: 500 });
  }
}
