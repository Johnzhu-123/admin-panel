import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes, createHash } from 'crypto';
// 🔧 FIX (2026-06-11 类型门禁): 会话存储移至 ../_auth.ts（路由文件不允许导出非 handler）
import { activeSessions } from '../_auth';

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

// Rate limiting for login attempts
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function getClientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

function isRateLimited(ip: string): boolean {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (Date.now() - record.lastAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return record.count >= MAX_LOGIN_ATTEMPTS;
}

function recordLoginAttempt(ip: string) {
  const record = loginAttempts.get(ip);
  if (!record || Date.now() - record.lastAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, lastAttempt: Date.now() });
  } else {
    record.count++;
    record.lastAttempt = Date.now();
  }
}

function clearLoginAttempts(ip: string) {
  loginAttempts.delete(ip);
}

export async function POST(request: NextRequest) {
  try {
    const ip = getClientIp(request);

    if (isRateLimited(ip)) {
      return NextResponse.json(
        { success: false, error: 'Too many login attempts. Please try again later.' },
        { status: 429 }
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

    // Use timing-safe comparison
    const inputHash = createHash('sha256').update(String(password)).digest('hex');
    const expectedHash = createHash('sha256').update(adminPassword).digest('hex');

    if (inputHash !== expectedHash) {
      recordLoginAttempt(ip);
      return NextResponse.json(
        { success: false, error: 'Invalid password' },
        { status: 401 }
      );
    }

    clearLoginAttempts(ip);

    // Generate cryptographically secure session token
    const sessionToken = randomBytes(32).toString('hex');
    const now = Date.now();
    activeSessions.set(sessionToken, {
      createdAt: now,
      expiresAt: now + SESSION_MAX_AGE,
    });

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
    const session = activeSessions.get(sessionCookie.value);
    if (!session || Date.now() > session.expiresAt) {
      if (session) activeSessions.delete(sessionCookie.value);
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
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('admin-session');
    if (sessionCookie?.value) {
      activeSessions.delete(sessionCookie.value);
    }
    cookieStore.delete('admin-session');

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Admin logout error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
