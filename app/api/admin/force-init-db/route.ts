import { requireAdminSession } from "@/app/api/admin/_auth";
/**
 * Force Database Initialization API
 * Forces recreation of database tables
 */

import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  void req;
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
  return NextResponse.json({
    operationAvailable: false,
    message: 'Destructive database initialization has been removed from HTTP routes.'
  });
}
