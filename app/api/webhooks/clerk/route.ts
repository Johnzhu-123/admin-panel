import { NextResponse } from "next/server";
import { Webhook } from "svix";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    console.error("[clerk-webhook] CLERK_WEBHOOK_SECRET is not configured");
    return NextResponse.json({ error: "Webhook unavailable" }, { status: 503 });
  }

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing Svix headers" }, { status: 400 });
  }

  // Svix signatures cover the exact received bytes. Parsing and reserializing JSON
  // before verification changes those bytes and invalidates the security contract.
  const rawBody = await req.text();
  try {
    new Webhook(webhookSecret).verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
  } catch (error) {
    console.warn("[clerk-webhook] Signature verification failed", error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Account creation is deliberately not consent. Terms are recorded only by the
  // authenticated post-signup endpoint after an explicit user action.
  return NextResponse.json({ success: true });
}
