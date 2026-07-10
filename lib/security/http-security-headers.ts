export type StrictCspMode = "off" | "report-only" | "enforce";

export type SecurityHeaderContext = {
  isProduction: boolean;
  isHttps: boolean;
  isLoopback: boolean;
  nonce?: string;
  strictCspMode?: StrictCspMode;
};

export type SecurityHeader = {
  key: string;
  value: string;
};

const CLERK_SCRIPT_ORIGINS = [
  "https://*.clerk.accounts.dev",
  "https://*.clerk.com",
  "https://*.clerk.services",
  "https://clerk.ppt.seeyjys.eu.org",
  "https://challenges.cloudflare.com",
];

const joinDirective = (name: string, sources: string[]) =>
  `${name} ${Array.from(new Set(sources)).join(" ")}`;

const baseDirectives = (scriptSources: string[]) => [
  joinDirective("default-src", ["'self'"]),
  joinDirective("base-uri", ["'self'"]),
  joinDirective("object-src", ["'none'"]),
  joinDirective("frame-ancestors", ["'none'"]),
  joinDirective("form-action", ["'self'", ...CLERK_SCRIPT_ORIGINS]),
  joinDirective("script-src", scriptSources),
  joinDirective("style-src", [
    "'self'",
    "'unsafe-inline'",
    "https://fonts.googleapis.com",
  ]),
  joinDirective("font-src", ["'self'", "data:", "https://fonts.gstatic.com"]),
  joinDirective("img-src", ["'self'", "data:", "blob:", "asset:", "https:"]),
  joinDirective("media-src", ["'self'", "data:", "blob:", "asset:", "https:"]),
  joinDirective("worker-src", ["'self'", "blob:"]),
  joinDirective("frame-src", ["'self'", ...CLERK_SCRIPT_ORIGINS]),
  joinDirective("connect-src", [
    "'self'",
    "https:",
    "wss:",
    "http://127.0.0.1:*",
    "http://localhost:*",
    "ws://127.0.0.1:*",
    "ws://localhost:*",
  ]),
];

export function buildBaselineContentSecurityPolicy(
  isProduction: boolean,
  upgradeInsecureRequests = isProduction
) {
  const scripts = ["'self'", "'unsafe-inline'", ...CLERK_SCRIPT_ORIGINS];
  if (!isProduction) scripts.push("'unsafe-eval'");
  const directives = baseDirectives(scripts);
  if (upgradeInsecureRequests) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function buildNonceContentSecurityPolicy(
  nonce: string,
  upgradeInsecureRequests = true
) {
  const safeNonce = nonce.trim();
  if (!/^[A-Za-z0-9+/_=-]{16,}$/.test(safeNonce)) {
    throw new Error("CSP nonce is missing or malformed.");
  }
  const directives = baseDirectives([
    "'self'",
    `'nonce-${safeNonce}'`,
    "'strict-dynamic'",
    ...CLERK_SCRIPT_ORIGINS,
  ]);
  if (upgradeInsecureRequests) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function buildHttpSecurityHeaders(
  context: SecurityHeaderContext
): SecurityHeader[] {
  const mode = context.strictCspMode || "off";
  const shouldUpgrade = context.isProduction && !context.isLoopback;
  const noncePolicy = context.nonce
    ? buildNonceContentSecurityPolicy(context.nonce, shouldUpgrade)
    : null;
  if (mode !== "off" && !noncePolicy) {
    throw new Error("Strict CSP mode requires a nonce.");
  }

  const headers: SecurityHeader[] = [
    {
      key: "Content-Security-Policy",
      value:
        mode === "enforce" && noncePolicy
          ? noncePolicy
          : buildBaselineContentSecurityPolicy(context.isProduction, shouldUpgrade),
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "no-referrer" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(self), geolocation=(), browsing-topics=(), payment=(), usb=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "Cross-Origin-Resource-Policy", value: "same-site" },
  ];

  if (mode === "report-only" && noncePolicy) {
    headers.push({
      key: "Content-Security-Policy-Report-Only",
      value: noncePolicy,
    });
  }
  if (context.isProduction && context.isHttps && !context.isLoopback) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    });
  }
  return headers;
}

export function applyHttpSecurityHeaders(
  headers: Headers,
  context: SecurityHeaderContext
) {
  for (const { key, value } of buildHttpSecurityHeaders(context)) {
    headers.set(key, value);
  }
  return headers;
}
