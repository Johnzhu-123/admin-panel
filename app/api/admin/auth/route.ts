import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  createAdminSession,
  revokeAdminSession,
  validateAdminSession,
} from '@/lib/admin/session-store';
import {
  clearAdminClientLoginAttempts,
  consumeAdminLoginAttempt,
  resolveAdminClientIdentifier,
} from '@/lib/admin/rate-limit-store';

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

function verifyAdminPassword(input: unknown, expected: string): boolean {
  const inputHash = createHash('sha256').update(String(input ?? '')).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(inputHash, expectedHash);
}

export async function POST(request: NextRequest) {
  try {
    const clientIdentifier = resolveAdminClientIdentifier(request.headers);
    const rateLimit = await consumeAdminLoginAttempt(clientIdentifier);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many login attempts. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) },
        }
      );
    }

    const { password } = await request.json();
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      console.error('ADMIN_PASSWORD environment variable is not set');
      return NextResponse.json(
        { success: false, error: 'Server configuration error' },
        { status: 500 }
      );
    }

    if (!verifyAdminPassword(password, adminPassword)) {
      return NextResponse.json(
        { success: false, error: 'Invalid password' },
        { status: 401 }
      );
    }

    // Generate cryptographically secure session token
    const sessionToken = randomBytes(32).toString('hex');
    await createAdminSession(
      sessionToken,
      new Date(Date.now() + SESSION_MAX_AGE)
    );
    await clearAdminClientLoginAttempts(clientIdentifier);

    const cookieStore = await cookies();
    cookieStore.set('admin-session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Admin auth error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('admin-session');

    if (!sessionCookie?.value) {
      return NextResponse.json({ authenticated: false });
    }

    // Validate session token against server-side store
    const valid = await validateAdminSession(sessionCookie.value);
    if (!valid) {
      cookieStore.delete('admin-session');
      return NextResponse.json({ authenticated: false });
    }

    return NextResponse.json({ authenticated: true });
  } catch (error) {
    console.error('Admin auth check error:', error);
    return NextResponse.json({ authenticated: false });
  }
}

export async function DELETE(request: NextRequest) {
  void request;
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('admin-session');
  cookieStore.delete('admin-session');
  try {
    if (sessionCookie?.value) {
      await revokeAdminSession(sessionCookie.value);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Admin logout error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
