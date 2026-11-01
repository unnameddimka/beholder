// Copied from Society src/sanitize.js: recursive secret redaction for diagnostics and dumps.
const SECRET_KEY_NAMES = new Set([
  "apikey",
  "api_key",
  "openrouterkey",
  "authorization",
  "accesstoken",
  "access_token",
  "password",
  "secret",
  "clientsecret",
  "client_secret"
]);

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function redactText(input, explicitSecrets = []) {
  let text = String(input ?? "");
  for (const secret of explicitSecrets) {
    if (typeof secret === "string" && secret.length >= 6) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/sk-or-v1-[A-Za-z0-9_-]{12,}/g, "[REDACTED_OPENROUTER_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]");
}

export function sanitize(value, explicitSecrets = [], seen = new WeakSet(), depth = 0) {
  if (depth > 40) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactText(value, explicitSecrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, explicitSecrets, seen, depth + 1));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const nk = normalizedKey(key);
    output[key] = SECRET_KEY_NAMES.has(nk) || nk.endsWith("apikey") || nk.endsWith("authorization")
      ? "[REDACTED]"
      : sanitize(item, explicitSecrets, seen, depth + 1);
  }
  return output;
}
