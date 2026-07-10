const { Buffer } = require("buffer");

const errors = [];

function requireValue(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) errors.push(`${name} is required`);
  return value;
}

const adminPassword = requireValue("ADMIN_PASSWORD");
const postgresUrl = requireValue("POSTGRES_URL");
const postgresNonPoolingUrl = requireValue("POSTGRES_URL_NON_POOLING");
const clerkPublishableKey = requireValue("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
const clerkSecretKey = requireValue("CLERK_SECRET_KEY");
const clerkWebhookSecret = requireValue("CLERK_WEBHOOK_SECRET");

const encryptionKey = requireValue("BUILT_IN_ENCRYPTION_KEY");
const encryptionKeyId = requireValue("BUILT_IN_ENCRYPTION_KEY_ID");

if (adminPassword && adminPassword.length < 16) {
  errors.push("ADMIN_PASSWORD must contain at least 16 characters");
}

if (postgresUrl && !/^postgres(?:ql)?:\/\//i.test(postgresUrl)) {
  errors.push("POSTGRES_URL must be a PostgreSQL connection URL");
}

if (
  postgresNonPoolingUrl &&
  !/^postgres(?:ql)?:\/\//i.test(postgresNonPoolingUrl)
) {
  errors.push(
    "POSTGRES_URL_NON_POOLING must be a direct PostgreSQL connection URL"
  );
}

if (clerkPublishableKey && !/^pk_live_/i.test(clerkPublishableKey)) {
  errors.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must be a live production key");
}

if (clerkSecretKey && !/^sk_live_/i.test(clerkSecretKey)) {
  errors.push("CLERK_SECRET_KEY must be a live production key");
}

if (clerkWebhookSecret && !/^whsec_[A-Za-z0-9_-]{16,}$/i.test(clerkWebhookSecret)) {
  errors.push("CLERK_WEBHOOK_SECRET must be a valid Clerk/Svix signing secret");
}

if (encryptionKey) {
  const decoded = Buffer.from(encryptionKey, "base64");
  const normalizedInput = encryptionKey.replace(/=+$/, "");
  const normalizedDecoded = decoded.toString("base64").replace(/=+$/, "");
  if (decoded.length !== 32 || normalizedInput !== normalizedDecoded) {
    errors.push("BUILT_IN_ENCRYPTION_KEY must be a valid 32-byte base64 value");
  }
}

if (encryptionKeyId && !/^[A-Za-z0-9._-]{1,64}$/.test(encryptionKeyId)) {
  errors.push("BUILT_IN_ENCRYPTION_KEY_ID must match [A-Za-z0-9._-]{1,64}");
}

if (process.env.ADMIN_TRUST_PROXY_HEADERS === "1" && process.env.VERCEL === "1") {
  errors.push(
    "ADMIN_TRUST_PROXY_HEADERS should be unset on Vercel; the platform header is used automatically"
  );
}

if (errors.length > 0) {
  console.error("Production environment check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Production environment check passed.");
}
