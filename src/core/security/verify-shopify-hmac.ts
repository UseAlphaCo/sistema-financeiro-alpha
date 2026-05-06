import { createHmac, timingSafeEqual } from "crypto";

function sanitizeSecret(secret: string): string {
  return secret.replace(/^['"]+|['"]+$/g, "").replace(/\r?\n/g, "").trim();
}

function normalizeSignature(signatureHeader: string): string {
  return signatureHeader
    .trim()
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
}

export function verifyShopifyHmac(
  rawBody: string,
  signatureHeader: string,
  secret: string
): boolean {
  const safeSecret = sanitizeSecret(secret);
  const safeSignature = normalizeSignature(signatureHeader);
  if (!safeSignature || !safeSecret) return false;

  const computed = createHmac("sha256", safeSecret).update(rawBody, "utf8").digest("base64");

  try {
    const computedBuf = Buffer.from(computed, "base64");
    const providedBuf = Buffer.from(safeSignature, "base64");

    if (computedBuf.length !== providedBuf.length) return false;

    return timingSafeEqual(computedBuf, providedBuf);
  } catch {
    return false;
  }
}
