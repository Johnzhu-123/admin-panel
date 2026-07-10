import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import {
  applyHttpSecurityHeaders,
  buildNonceContentSecurityPolicy,
  type StrictCspMode,
} from "@/lib/security/http-security-headers";

const getStrictCspMode = (): StrictCspMode => {
  const value = String(process.env.SECURITY_STRICT_CSP_MODE || "").toLowerCase();
  return value === "enforce" || value === "report-only" ? value : "off";
};

const isLoopbackUrl = (value: string) => {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
};

export const securityContextFor = (
  req: Pick<NextRequest, "url" | "headers">
) => {
  const mode = getStrictCspMode();
  const nonce = mode === "off" ? undefined : crypto.randomUUID().replace(/-/g, "");
  const trustForwardedProto =
    process.env.VERCEL === "1" || process.env.ADMIN_TRUST_PROXY_HEADERS === "1";
  const forwardedProto = req.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  const isHttps =
    new URL(req.url).protocol === "https:" ||
    (trustForwardedProto && forwardedProto === "https");
  return {
    isProduction: process.env.NODE_ENV === "production",
    isHttps,
    isLoopback: isLoopbackUrl(req.url),
    nonce,
    strictCspMode: mode,
  } as const;
};

const secureNextResponse = (req: NextRequest) => {
  const context = securityContextFor(req);
  const requestHeaders = new Headers(req.headers);
  if (context.nonce) {
    requestHeaders.set("x-nonce", context.nonce);
    requestHeaders.set(
      "content-security-policy",
      buildNonceContentSecurityPolicy(
        context.nonce,
        context.isProduction && !context.isLoopback
      )
    );
  }
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applyHttpSecurityHeaders(response.headers, context);
  return response;
};

const secureResponse = (req: NextRequest, response: NextResponse) => {
  applyHttpSecurityHeaders(response.headers, securityContextFor(req));
  return response;
};

export function isPublicClerkPage(req: Pick<NextRequest, "nextUrl">) {
  const pathname = req.nextUrl.pathname;
  return (
    pathname === "/" ||
    pathname === "/sign-in" ||
    pathname.startsWith("/sign-in/") ||
    pathname === "/sign-up" ||
    pathname.startsWith("/sign-up/") ||
    pathname === "/sign-up-with-terms" ||
    pathname.startsWith("/sign-up-with-terms/")
  );
}

const CLERK_CONFIGURED =
  Boolean(process.env.CLERK_SECRET_KEY?.trim()) &&
  Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim());

export function isPublicInfrastructureRequest(req: Pick<NextRequest, "nextUrl" | "method">) {
  const { pathname } = req.nextUrl;
  if (pathname === "/api/webhooks/clerk") return req.method === "POST";
  if (!pathname.startsWith("/api/desktop-update/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const asset = pathname.slice("/api/desktop-update/".length);
  return (
    asset === "latest.yml" ||
    (/^[^/]+\.(?:exe|blockmap)$/i.test(asset) && !asset.includes(".."))
  );
}

const protectedMiddleware = clerkMiddleware(async (auth, req) => {
  if (isPublicInfrastructureRequest(req) || isPublicClerkPage(req)) {
    return secureNextResponse(req);
  }
  await auth.protect();
  return secureNextResponse(req);
});

const unavailableMiddleware = (req: NextRequest) => {
  if (isPublicInfrastructureRequest(req)) return secureNextResponse(req);
  return secureResponse(
    req,
    NextResponse.json(
      { error: "Authentication is not configured" },
      { status: 503 }
    )
  );
};

export default CLERK_CONFIGURED ? protectedMiddleware : unavailableMiddleware;

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
