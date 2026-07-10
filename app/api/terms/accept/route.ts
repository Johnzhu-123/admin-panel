import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  getUserTermsAcceptance,
  recordTermsAcceptance,
} from "@/lib/built-in-api-service/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CURRENT_TERMS_VERSION = "1.0";

function clientAddress(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const termsVersion =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).termsVersion
      : undefined;
  if (termsVersion !== CURRENT_TERMS_VERSION) {
    return NextResponse.json({ error: "Unsupported terms version" }, { status: 400 });
  }

  const email =
    user.primaryEmailAddress?.emailAddress ||
    user.emailAddresses?.[0]?.emailAddress ||
    undefined;
  try {
    await recordTermsAcceptance(
      user.id,
      email,
      clientAddress(req),
      req.headers.get("user-agent"),
      CURRENT_TERMS_VERSION
    );
    return NextResponse.json({
      success: true,
      termsVersion: CURRENT_TERMS_VERSION,
      acceptedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[terms] Failed to record acceptance", error);
    return NextResponse.json({ error: "Failed to record terms acceptance" }, { status: 503 });
  }
}

export async function GET() {
  const user = await currentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const acceptance = await getUserTermsAcceptance(user.id);
    return NextResponse.json({
      hasAccepted: Boolean(acceptance),
      currentTermsVersion: CURRENT_TERMS_VERSION,
      acceptance: acceptance
        ? {
            termsVersion: acceptance.termsVersion,
            acceptedAt: acceptance.acceptedAt.toISOString(),
          }
        : null,
    });
  } catch (error) {
    console.error("[terms] Failed to read acceptance", error);
    return NextResponse.json({ error: "Failed to read terms acceptance" }, { status: 503 });
  }
}
