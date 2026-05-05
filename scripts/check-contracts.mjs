import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const requiredFiles = [
  "src/types/api.ts",
  "src/shared/api/envelope.ts",
  "src/core/security/with-api-security.ts",
  "middleware.ts",
];

const missing = requiredFiles.filter((file) => !existsSync(join(process.cwd(), file)));

if (missing.length > 0) {
  console.error("[check-contracts] Arquivos obrigatorios ausentes:");
  for (const file of missing) {
    console.error(` - ${file}`);
  }
  process.exit(1);
}

const apiTypes = readFileSync(join(process.cwd(), "src/types/api.ts"), "utf8");
if (!apiTypes.includes("ApiEnvelope") || !apiTypes.includes("ActionResult")) {
  console.error("[check-contracts] src/types/api.ts precisa expor ApiEnvelope e ActionResult");
  process.exit(1);
}

const securityWrapper = readFileSync(
  join(process.cwd(), "src/core/security/with-api-security.ts"),
  "utf8"
);

if (!securityWrapper.includes("rateLimit") || !securityWrapper.includes("requestId")) {
  console.error(
    "[check-contracts] with-api-security precisa manter suporte a rateLimit e requestId"
  );
  process.exit(1);
}

console.log("[check-contracts] OK");
