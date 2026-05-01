import { requireAdminSession } from "@/app/api/admin/_auth";
/**
 * Force Database Initialization API
 * Forces recreation of database tables
 */

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export async function POST(req: Request) {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    console.log('[ForceInit] Starting forced database initialization...');

    // Drop existing table if it exists
    console.log('[ForceInit] Dropping existing table...');
    await sql`DROP TABLE IF EXISTS authorized_users CASCADE`;
    console.log('[ForceInit] Table dropped');

    // Create table
    console.log('[ForceInit] Creating authorized_users table...');
    await sql`
      CREATE TABLE authorized_users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'active',
        can_use_built_in_services BOOLEAN DEFAULT true,
        allowed_services TEXT[],
        daily_requests INTEGER DEFAULT 500,
        monthly_requests INTEGER DEFAULT 15000,
        concurrent_requests INTEGER DEFAULT 20,
        granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        granted_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    console.log('[ForceInit] Table created');

    // Create indexes
    console.log('[ForceInit] Creating indexes...');
    await sql`CREATE INDEX idx_user_id ON authorized_users(user_id)`;
    await sql`CREATE INDEX idx_status ON authorized_users(status)`;
    console.log('[ForceInit] Indexes created');

    // Verify table exists
    console.log('[ForceInit] Verifying table...');
    const { rows } = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'authorized_users'
    `;
    console.log('[ForceInit] Verification result:', rows);

    if (rows.length === 0) {
      throw new Error('Table was not created successfully');
    }

    // Get table structure
    const { rows: columns } = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'authorized_users'
      ORDER BY ordinal_position
    `;
    console.log('[ForceInit] Table structure:', columns);

    return NextResponse.json({
      success: true,
      message: 'Database forcefully initialized',
      details: {
        tableCreated: true,
        tableExists: rows.length > 0,
        columns: columns.map(c => ({ name: c.column_name, type: c.data_type })),
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('[ForceInit] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    }, { status: 500 });
  }
}

export async function GET() {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  return NextResponse.json({
    message: 'Use POST method to force initialize database',
    warning: 'This will DROP and recreate the authorized_users table'
  });
}
