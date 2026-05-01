/**
 * Clerk Webhook Handler
 * Updates terms acceptance records when user completes registration
 */

import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { Webhook } from 'svix';
import { recordTermsAcceptance } from '@/lib/built-in-api-service/db';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  // Get the headers
  const headerPayload = await headers();
  const svix_id = headerPayload.get('svix-id');
  const svix_timestamp = headerPayload.get('svix-timestamp');
  const svix_signature = headerPayload.get('svix-signature');

  // If there are no headers, error out
  if (!svix_id || !svix_timestamp || !svix_signature) {
    return NextResponse.json(
      { error: 'Missing svix headers' },
      { status: 400 }
    );
  }

  // Get the body
  const payload = await req.json();
  const body = JSON.stringify(payload);

  // Get the Webhook secret from environment
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

  if (!WEBHOOK_SECRET) {
    console.error('CLERK_WEBHOOK_SECRET is not set');
    return NextResponse.json(
      { error: 'Webhook secret not configured' },
      { status: 500 }
    );
  }

  // Create a new Svix instance with your secret
  const wh = new Webhook(WEBHOOK_SECRET);

  let evt: any;

  // Verify the payload with the headers
  try {
    evt = wh.verify(body, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature,
    }) as any;
  } catch (err) {
    console.error('Error verifying webhook:', err);
    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 400 }
    );
  }

  // Handle the webhook
  const eventType = evt.type;
  console.log(`[Clerk Webhook] Received event: ${eventType}`);

  if (eventType === 'user.created') {
    const { id, email_addresses, created_at } = evt.data;
    const email = email_addresses?.[0]?.email_address;

    console.log(`[Clerk Webhook] New user created: ${id}, email: ${email}`);

    try {
      // Check if user accepted terms before registration (from localStorage)
      // If so, update the record with the Clerk user ID
      // For now, we'll create a new record with the Clerk user ID
      await recordTermsAcceptance(
        id, // Clerk user ID
        email,
        null, // IP will be null for webhook
        null, // User agent will be null for webhook
        '1.0'
      );

      console.log(`[Clerk Webhook] Terms acceptance recorded for user: ${id}`);
    } catch (error) {
      console.error('[Clerk Webhook] Error recording terms acceptance:', error);
      // Don't fail the webhook if terms recording fails
    }
  }

  return NextResponse.json({ success: true });
}
