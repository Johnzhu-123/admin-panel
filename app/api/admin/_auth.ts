import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { validateAdminSession } from "@/lib/admin/session-store";

export async function requireAdminSession() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("admin-session");

  if (!sessionCookie?.value) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const valid = await validateAdminSession(sessionCookie.value);
    if (!valid) {
      cookieStore.delete("admin-session");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } catch (error) {
    console.error("[admin-auth] Session validation unavailable", error);
    cookieStore.delete("admin-session");
    return NextResponse.json(
      { error: "Authentication unavailable" },
      { status: 503 }
    );
  }

  return null;
}
