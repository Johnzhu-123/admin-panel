/**
 * Terms of Service Acceptance API
 * Records user acceptance of terms with IP and device information
 */

import { NextResponse } from 'next/server';
import { currentUser } from '@clerk/nextjs/server';
import { recordTermsAcceptance } from '@/lib/built-in-api-service/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    // Get user info from Clerk
    const user = await currentUser();
    const userId = user?.id;
    
    // Parse request body
    const body = await req.json();
    const { email, termsVersion = '1.0' } = body;

    // Get IP address from headers
    const forwarded = req.headers.get('x-forwarded-for');
    const ipAddress = forwarded ? forwarded.split(',')[0].trim() : 
                     req.headers.get('x-real-ip') || 
                     'unknown';

    // Get user agent
    const userAgent = req.headers.get('user-agent') || 'unknown';

    // Use userId from Clerk if available, otherwise use email
    const userIdentifier = userId || email || 'anonymous';

    console.log(`[Terms API] Recording acceptance for user: ${userIdentifier}`);
    console.log(`[Terms API] IP: ${ipAddress}, User-Agent: ${userAgent}`);

    // Record to database
    await recordTermsAcceptance(
      userIdentifier,
      email,
      ipAddress,
      userAgent,
      termsVersion
    );

    return NextResponse.json({
      success: true,
      message: 'Terms acceptance recorded successfully',
      data: {
        userId: userIdentifier,
        termsVersion,
        acceptedAt: new Date().toISOString(),
        ipAddress
      }
    });

  } catch (error) {
    console.error('[Terms API] Error recording acceptance:', error);
    
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to record terms acceptance',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  try {
    // Get user info from Clerk
    const user = await currentUser();
    const userId = user?.id;

    if (!userId) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Import the function to check terms acceptance
    const { getUserTermsAcceptance } = await import('@/lib/built-in-api-service/db');
    
    const acceptance = await getUserTermsAcceptance(userId);

    if (!acceptance) {
      return NextResponse.json({
        hasAccepted: false,
        acceptance: null
      });
    }

    return NextResponse.json({
      hasAccepted: true,
      acceptance: {
        termsVersion: acceptance.termsVersion,
        acceptedAt: acceptance.acceptedAt.toISOString(),
        ipAddress: acceptance.ipAddress
      }
    });

  } catch (error) {
    console.error('[Terms API] Error checking acceptance:', error);
    
    return NextResponse.json(
      {
        error: 'Failed to check terms acceptance',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
