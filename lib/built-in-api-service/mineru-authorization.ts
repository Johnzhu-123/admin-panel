export type MinerUIdentitySource = "clerk" | "desktop-proxy";

export interface MinerURequestIdentity {
  userId: string;
  email: string;
  source: MinerUIdentitySource;
}

export interface MinerUAuthorizationRecord {
  userId: string;
  email: string;
  status: string;
  canUseBuiltInServices: boolean;
  allowedServices: string[];
  dailyRequests: number;
  monthlyRequests: number;
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

const toNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeAllowedServices = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clean(String(item || ""))).filter(Boolean);
};

export function parseMinerUAuthorizedUsersFromEnv(
  raw: string | undefined
): MinerUAuthorizationRecord[] {
  if (!raw) return [];
  try {
    const json = raw.includes('\\"') ? raw.replace(/\\"/g, '"') : raw;
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item): MinerUAuthorizationRecord | null => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, any>;
        const permissions =
          record.permissions && typeof record.permissions === "object"
            ? record.permissions
            : record;
        const quota =
          permissions.quotaLimits && typeof permissions.quotaLimits === "object"
            ? permissions.quotaLimits
            : record.quotaLimits || {};
        const userId = clean(record.userId || record.user_id || record.id || record.email);
        const email = clean(record.email || userId);
        if (!userId && !email) return null;

        return {
          userId: userId || email,
          email: email || userId,
          status: clean(record.status) || "active",
          canUseBuiltInServices:
            typeof permissions.canUseBuiltInServices === "boolean"
              ? permissions.canUseBuiltInServices
              : typeof record.can_use_built_in_services === "boolean"
                ? record.can_use_built_in_services
                : true,
          allowedServices: normalizeAllowedServices(
            permissions.allowedServices || record.allowed_services
          ),
          dailyRequests: toNumber(
            quota.dailyRequests ?? record.daily_requests,
            500
          ),
          monthlyRequests: toNumber(
            quota.monthlyRequests ?? record.monthly_requests,
            15000
          ),
        };
      })
      .filter((item): item is MinerUAuthorizationRecord => Boolean(item));
  } catch (error) {
    console.error("[mineru-authorization] Failed to parse AUTHORIZED_USERS:", error);
    return [];
  }
}

export function findMinerUAuthorizationRecord(
  users: MinerUAuthorizationRecord[],
  userId: string,
  email?: string
): MinerUAuthorizationRecord | null {
  const normalizedUserId = normalizeMinerUIdentifier(userId);
  const normalizedEmail = normalizeMinerUIdentifier(email);
  return (
    users.find((user) => {
      const candidateUserId = normalizeMinerUIdentifier(user.userId);
      const candidateEmail = normalizeMinerUIdentifier(user.email);
      return (
        (normalizedUserId && candidateUserId === normalizedUserId) ||
        (normalizedUserId && candidateEmail === normalizedUserId) ||
        (normalizedEmail && candidateEmail === normalizedEmail) ||
        (normalizedEmail && candidateUserId === normalizedEmail)
      );
    }) || null
  );
}

export function getMinerUAuthorizationFromEnv(
  userId: string,
  email?: string
): MinerUAuthorizationRecord | null {
  return findMinerUAuthorizationRecord(
    parseMinerUAuthorizedUsersFromEnv(process.env.AUTHORIZED_USERS),
    userId,
    email
  );
}
