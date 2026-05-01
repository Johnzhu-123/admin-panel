import { requireAdminSession } from "@/app/api/admin/_auth";
/**
 * Clerk Users API
 * Fetches registered users from Clerk workspace for admin panel integration
 */

import { NextResponse } from "next/server";
import { createClerkClient } from "@clerk/backend";
import { noStoreHeaders } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    // Create Clerk client instance
    const clerkClient = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
    });

    // Fetch users from Clerk
    const users = await clerkClient.users.getUserList({
      limit: 100, // Adjust as needed
      orderBy: '-created_at'
    });

    // Transform Clerk users to our format
    const transformedUsers = users.data.map(user => {
      const primaryEmail = user.emailAddresses.find(email => email.id === user.primaryEmailAddressId);
      const firstName = user.firstName || '';
      const lastName = user.lastName || '';
      const fullName = `${firstName} ${lastName}`.trim() || primaryEmail?.emailAddress || 'Unknown User';

      return {
        clerkId: user.id,
        userId: primaryEmail?.emailAddress || '',
        email: primaryEmail?.emailAddress || '',
        name: fullName,
        firstName: firstName,
        lastName: lastName,
        createdAt: user.createdAt,
        lastSignInAt: user.lastSignInAt,
        imageUrl: user.imageUrl,
        verified: primaryEmail?.verification?.status === 'verified'
      };
    }).filter(user => user.email); // Only include users with email addresses

    return NextResponse.json({ 
      users: transformedUsers,
      total: users.totalCount 
    }, { headers: noStoreHeaders() });

  } catch (error) {
    console.error('Clerk users API error:', error);
    return NextResponse.json(
      { 
        error: "Failed to fetch Clerk users",
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}