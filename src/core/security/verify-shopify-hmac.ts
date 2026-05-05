import { createHmac, timingSafeEqual } from "crypto";

export function verifyShopifyHmac(
  rawBody: string,
  signatureHeader: string,
  secret: string
): boolean {
  if (!signatureHeader || !secret) return false;

  const computed = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");

  try {
    const computedBuf = Buffer.from(computed, "base64");
    const providedBuf = Buffer.from(signatureHeader, "base64");

    if (computedBuf.length !== providedBuf.length) return false;

    return timingSafeEqual(computedBuf, providedBuf);
  } catch {
    return false;
  }
}
