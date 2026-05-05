const REDACT_KEYS = [
  "authorization",
  "token",
  "password",
  "secret",
  "apiKey",
  "cookie",
  "set-cookie",
];

function redactValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.includes(key.toLowerCase())) {
      clone[key] = "[REDACTED]";
      continue;
    }
    clone[key] = redactValue(item);
  }

  return clone;
}

export function logInfo(message: string, payload?: unknown) {
  const safePayload = redactValue(payload);
  console.info(
    JSON.stringify({
      level: "info",
      message,
      payload: safePayload,
      timestamp: new Date().toISOString(),
    })
  );
}

export function logError(message: string, payload?: unknown) {
  const safePayload = redactValue(payload);
  console.error(
    JSON.stringify({
      level: "error",
      message,
      payload: safePayload,
      timestamp: new Date().toISOString(),
    })
  );
}
