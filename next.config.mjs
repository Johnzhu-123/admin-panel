const clerkOrigins = [
  "https://*.clerk.accounts.dev",
  "https://*.clerk.com",
  "https://*.clerk.services",
  "https://clerk.ppt.seeyjys.eu.org",
  "https://challenges.cloudflare.com",
];

const scriptSources = ["'self'", "'unsafe-inline'", ...clerkOrigins];
if (process.env.NODE_ENV !== "production") scriptSources.push("'unsafe-eval'");

const baselineCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  `form-action 'self' ${clerkOrigins.join(" ")}`,
  `script-src ${scriptSources.join(" ")}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: asset: https:",
  "media-src 'self' data: blob: asset: https:",
  "worker-src 'self' blob:",
  `frame-src 'self' ${clerkOrigins.join(" ")}`,
  "connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
].join("; ");

const staticSecurityHeaders = [
  { key: "Content-Security-Policy", value: baselineCsp },
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

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  typescript: {
    // 🔧 FIX (2026-06-11 类型门禁): 类型债清零（129→0）后开启构建期类型检查，
    // 防止新增类型错误再次悄悄进入生产构建。
    ignoreBuildErrors: false,
  },
  eslint: {
    // Warning: This allows production builds to successfully complete even if
    // your project has ESLint errors.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [{ source: "/(.*)", headers: staticSecurityHeaders }];
  },
  webpack: (config) => {
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      canvas: false,
    };
    return config;
  },
};

export default nextConfig;
