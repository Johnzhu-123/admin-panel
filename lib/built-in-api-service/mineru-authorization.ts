export type MinerUIdentitySource = "clerk" | "desktop-proxy";

export interface MinerURequestIdentity {
  userId: string;
  email: string;
  source: MinerUIdentitySource;
}

interface ClerkEmailLike {
  emailAddress?: string | null;
}

interface ClerkUserLike {
  id?: string | null;
  primaryEmailAddress?: ClerkEmailLike | null;
  emailAddresses?: ClerkEmailLike[] | null;
}

const clean = (value?: string | null) => (value || "").trim();

export function normalizeMinerUIdentifier(value?: string | null): string {
  return clean(value).toLowerCase();
}

export function getMinerUIdentityFromClerkUser(
  user: ClerkUserLike | null | undefined
): MinerURequestIdentity | null {
  if (!user) return null;
  const userId = clean(user.id);
  const email =
    clean(user.primaryEmailAddress?.emailAddress) ||
    clean(user.emailAddresses?.[0]?.emailAddress);
  if (!userId && !email) return null;
  return {
    userId: userId || email,
    email: email || userId,
    source: "clerk",
  };
}

export function getMinerUIdentityFromRequestHeaders(
  headers: Headers
): MinerURequestIdentity | null {
  const userId = clean(headers.get("x-md2ppt-user-id"));
  const email = clean(headers.get("x-md2ppt-user-email"));
  if (!userId && !email) return null;
  return {
    userId: userId || email,
    email: email || userId,
    source: "desktop-proxy",
  };
}

export function resolveMinerURequestIdentity(
  clerkUser: ClerkUserLike | null | undefined,
  headers: Headers
): MinerURequestIdentity | null {
  return (
    getMinerUIdentityFromClerkUser(clerkUser) ||
    getMinerUIdentityFromRequestHeaders(headers)
  );
}

export function isMinerUServiceAllowed(allowedServices: string[] | null | undefined): boolean {
  if (!Array.isArray(allowedServices) || allowedServices.length === 0) return true;
  const allowed = new Set(allowedServices.map(normalizeMinerUIdentifier).filter(Boolean));
  return (
    allowed.has("*") ||
    allowed.has("mineru") ||
    allowed.has("material-extract") ||
    allowed.has("built-in-mineru") ||
    // Historical value used by the admin user-management UI as the umbrella
    // permission for "built-in services".
    allowed.has("gemini-built-in") ||
    allowed.has("built-in-default")
  );
}
