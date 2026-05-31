import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/ai/built-in-service(.*)",
  "/api/material-extract/mineru(.*)",
  "/admin(.*)",
  "/api/admin(.*)",
]);

const isClerkConfigured =
  Boolean(process.env.CLERK_SECRET_KEY) &&
  Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) &&
  process.env.ELECTRON_DESKTOP !== "1";

export default isClerkConfigured
  ? clerkMiddleware((auth, req) => {
      if (!isPublicRoute(req)) auth.protect();
    })
  : () => NextResponse.next();

export const config = {
  matcher: ["/((?!.+\\.[\\w]+$|_next).*)", "/", "/(api|trpc)(.*)"],
};
