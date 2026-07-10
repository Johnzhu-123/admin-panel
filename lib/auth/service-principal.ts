import { auth } from "@clerk/nextjs/server";

const LEGACY_IDENTITY_HEADERS = [
  "x-md2ppt-user-id",
  "x-md2ppt-user-email",
  "x-md2ppt-user-name",
] as const;

export interface ServicePrincipal {
  userId: string;
  email?: string;
  source: "clerk-bearer";
}

export interface ClaimedServicePrincipal extends ServicePrincipal {
  resolvedUserId: string;
}

export class ServicePrincipalError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 = 401
  ) {
    super(message);
    this.name = "ServicePrincipalError";
  }
}

function claimString(claims: unknown, keys: string[]): string | undefined {
  if (!claims || typeof claims !== "object") return undefined;
  const record = claims as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export async function requireServicePrincipal(req: Request): Promise<ServicePrincipal> {
  if (LEGACY_IDENTITY_HEADERS.some((name) => req.headers.has(name))) {
    throw new ServicePrincipalError("Legacy identity headers are not accepted");
  }

  const authorization = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    throw new ServicePrincipalError("A Clerk Bearer token is required");
  }

  try {
    const authState = await auth();
    if (!authState.userId) throw new ServicePrincipalError("Invalid Clerk principal");
    return {
      userId: authState.userId,
      email: claimString(authState.sessionClaims, [
        "email",
        "email_address",
        "primary_email_address",
      ]),
      source: "clerk-bearer",
    };
  } catch (error) {
    if (error instanceof ServicePrincipalError) throw error;
    throw new ServicePrincipalError("Invalid Clerk principal");
  }
}

export async function requireClaimedServicePrincipal(
  req: Request,
  claimedUserId?: string | null
): Promise<ClaimedServicePrincipal> {
  const principal = await requireServicePrincipal(req);
  const rawClaimed = (claimedUserId || "").trim();
  const claimed = rawClaimed.toLowerCase();
  if (
    claimed &&
    claimed !== principal.userId.toLowerCase() &&
    claimed !== (principal.email || "").toLowerCase()
  ) {
    throw new ServicePrincipalError(
      "Claimed user does not match the authenticated principal",
      403
    );
  }
  return {
    ...principal,
    resolvedUserId: rawClaimed || principal.email || principal.userId,
  };
}
