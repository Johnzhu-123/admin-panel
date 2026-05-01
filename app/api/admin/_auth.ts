import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { activeSessions } from "./auth/route";

export async function requireAdminSession() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("admin-session");

  if (!sessionCookie?.value) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = activeSessions.get(sessionCookie.value);
  if (!session || Date.now() > session.expiresAt) {
    if (session) activeSessions.delete(sessionCookie.value);
    cookieStore.delete("admin-session");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

