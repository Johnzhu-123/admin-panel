import { requireAdminSession } from "@/app/api/admin/_auth";
/**
 * Admin API for Terms Acceptance Records
 * Allows administrators to view terms acceptance statistics and records
 */

import { NextResponse } from 'next/server';
import { 
  getAllTermsAcceptanceRecords, 
  getTermsAcceptanceStats 
} from '@/lib/built-in-api-service/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    // TODO: Add admin authentication check here
    // const { userId } = auth();
    // if (!isAdmin(userId)) {
    //   return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    // }

    switch (action) {
      case 'stats':
        // Get statistics
        const stats = await getTermsAcceptanceStats();
        return NextResponse.json({ stats });

      case 'records':
        // Get all records
        const records = await getAllTermsAcceptanceRecords();
        return NextResponse.json({ records });

      default:
        // Default: return both stats and recent records
        const [allStats, allRecords] = await Promise.all([
          getTermsAcceptanceStats(),
          getAllTermsAcceptanceRecords()
        ]);

        return NextResponse.json({
          stats: allStats,
          records: allRecords.slice(0, 100) // Return only first 100 records
        });
    }

  } catch (error) {
    console.error('[Admin Terms API] Error:', error);
    
    return NextResponse.json(
      {
        error: 'Failed to fetch terms acceptance data',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
