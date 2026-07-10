import { requireAdminSession } from "@/app/api/admin/_auth";
/**
 * Database Initialization API
 * Initializes Vercel Postgres database and imports users from environment
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { isDatabaseAvailable } from '@/lib/built-in-api-service/db';

export async function POST(request: NextRequest) {
  void request;
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  return NextResponse.json(
    {
      success: false,
      error: 'Database DDL is not available over HTTP',
      action: 'Run the approved database migration scripts from a trusted deployment shell.',
    },
    { status: 410 }
  );
}

export async function GET() {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    // Check if database is already initialized
    const dbAvailable = await isDatabaseAvailable();

    if (!dbAvailable) {
      return NextResponse.json({
        error: 'Database not configured',
        message: 'Please create and connect a Vercel Postgres database to your project',
        steps: [
          '1. Go to Vercel project → Storage tab',
          '2. Click "Create Database" → Select "Postgres"',
          '3. Click "Connect Project" to link the database',
          '4. Redeploy your application',
          '5. Visit this endpoint again'
        ]
      }, { status: 503 });
    }

    try {
      const { rows } = await sql<{
        total_users: number;
        active_users: number;
        suspended_users: number;
      }>`
        SELECT
          COUNT(*)::int AS total_users,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_users,
          COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_users
        FROM authorized_users
      `;
      const row = rows[0];
      return NextResponse.json({
        success: true,
        message: 'Database is reachable',
        stats: {
          totalUsers: row?.total_users || 0,
          activeUsers: row?.active_users || 0,
          suspendedUsers: row?.suspended_users || 0,
        },
        readOnly: true,
      });
    } catch {
      return NextResponse.json({
        success: false,
        error: 'Database schema is not ready',
        readOnly: true,
      }, { status: 503 });
    }
  } catch (error) {
    console.error('Database initialization error:', error);
    return NextResponse.json(
      {
        error: 'Database status check failed',
      },
      { status: 500 }
    );
  }
}
