import { requireAdminSession } from "@/app/api/admin/_auth";
/**
 * Check Database Status API
 * Verifies database connection and table existence
 */

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export async function GET() {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    console.log('[CheckDB] Checking database status...');

    // 1. Check database connection
    console.log('[CheckDB] Testing connection...');
    await sql`SELECT 1`;
    console.log('[CheckDB] Connection OK');

    // 2. Check if table exists
    console.log('[CheckDB] Checking if authorized_users table exists...');
    const { rows: tableCheck } = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'authorized_users'
    `;
    const tableExists = tableCheck.length > 0;
    console.log('[CheckDB] Table exists:', tableExists);

    let tableInfo = null;
    let userData = null;
    let userCount = 0;

    if (tableExists) {
      // 3. Get table structure
      console.log('[CheckDB] Getting table structure...');
      const { rows: columns } = await sql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'authorized_users'
        ORDER BY ordinal_position
      `;
      tableInfo = columns;
      console.log('[CheckDB] Columns:', columns.length);

      // 4. Count users
      console.log('[CheckDB] Counting users...');
      const { rows: countRows } = await sql`
        SELECT COUNT(*)::int as count FROM authorized_users
      `;
      userCount = countRows[0].count;
      console.log('[CheckDB] User count:', userCount);

      // 5. Get sample user data
      if (userCount > 0) {
        console.log('[CheckDB] Getting sample user data...');
        const { rows: users } = await sql`
          SELECT user_id, email, name, status, can_use_built_in_services, allowed_services
          FROM authorized_users
          LIMIT 5
        `;
        userData = users;
        console.log('[CheckDB] Sample users:', users.length);
      }
    }

    return NextResponse.json({
      success: true,
      database: {
        connected: true,
        tableExists,
        userCount,
        tableInfo,
        sampleUsers: userData
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('[CheckDB] Error:', error);
    return NextResponse.json({
      success: false,
      error: 'Database status check failed'
    }, { status: 500 });
  }
}
