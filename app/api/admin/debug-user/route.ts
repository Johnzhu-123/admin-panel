import { requireAdminSession } from "@/app/api/admin/_auth";
/**
 * Debug User Authorization API
 * Helps diagnose authorization issues
 */

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export async function GET(req: Request) {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId')?.trim();
    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    console.log(`[Debug] Checking authorization for user: ${userId}`);

    // 1. Check database directly
    console.log('[Debug] Step 1: Checking database...');
    const { rows } = await sql`
      SELECT user_id, email, name, status, can_use_built_in_services,
             allowed_services, daily_requests, monthly_requests
      FROM authorized_users
      WHERE user_id = ${userId}
    `;

    const dbUser = rows[0];
    console.log('[Debug] Database user:', JSON.stringify(dbUser, null, 2));

    const isAuthorized = Boolean(
      dbUser &&
      dbUser.status === 'active' &&
      dbUser.can_use_built_in_services === true
    );

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
      diagnosis: {
        databaseUserExists: !!dbUser,
        isAuthorized,
        hasConfiguredServices: Array.isArray(dbUser?.allowed_services)
          ? dbUser.allowed_services.length > 0
          : false,
        issues: []
      }
    });

  } catch (error) {
    console.error('[Debug] Error:', error);
    return NextResponse.json({
      error: 'User diagnostic failed'
    }, { status: 500 });
  }
}
