import { requireAdminSession } from "@/app/api/admin/_auth";
/**
 * Database Initialization API
 * Initializes Vercel Postgres database and imports users from environment
 */

import { NextRequest, NextResponse } from 'next/server';
import { initializeDatabase, importUsersFromEnv, isDatabaseAvailable, getDatabaseStats } from '@/lib/built-in-api-service/db';

export async function POST(request: NextRequest) {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    // Check admin authentication
    const adminPassword = request.headers.get('x-admin-password');
    if (adminPassword !== process.env.ADMIN_PASSWORD) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      return NextResponse.json(
        {
          error: 'Database not available',
          message: 'Please configure Vercel Postgres in your project settings'
        },
        { status: 503 }
      );
    }

    // Initialize database tables
    await initializeDatabase();

    // Import users from environment variable
    const importedCount = await importUsersFromEnv();

    // Get database statistics
    const stats = await getDatabaseStats();

    return NextResponse.json({
      success: true,
      message: 'Database initialized successfully',
      imported: importedCount,
      stats
    });
  } catch (error) {
    console.error('Database initialization error:', error);
    return NextResponse.json(
      {
        error: 'Database initialization failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
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

    // Check if tables exist by trying to query
    try {
      const stats = await getDatabaseStats();
      
      // If tables exist, return current status
      return NextResponse.json({
        success: true,
        message: 'Database already initialized',
        stats,
        note: 'Database is ready to use'
      });
    } catch (error) {
      // Tables don't exist, proceed with initialization
      console.log('Tables not found, initializing...');
    }

    // Initialize database tables (no auth required for first-time setup)
    console.log('Initializing database tables...');
    await initializeDatabase();

    // Import users from environment variable
    console.log('Importing users from environment...');
    const importedCount = await importUsersFromEnv();

    // Get database statistics
    const stats = await getDatabaseStats();

    return NextResponse.json({
      success: true,
      message: 'Database initialized successfully',
      details: {
        tablesCreated: true,
        usersImported: importedCount,
        timestamp: new Date().toISOString()
      },
      stats,
      nextSteps: [
        'Database is now ready',
        'You can access the admin panel at /admin',
        `${importedCount} user(s) imported from environment variable`,
        'You can now add more users via the admin panel'
      ]
    });
  } catch (error) {
    console.error('Database initialization error:', error);
    return NextResponse.json(
      {
        error: 'Database initialization failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    );
  }
}
