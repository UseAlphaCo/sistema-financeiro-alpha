import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");

const errors = [];

function walk(dir) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (!fullPath.endsWith(".ts") && !fullPath.endsWith(".tsx")) {
      continue;
    }

    const relPath = relative(ROOT, fullPath);
    const content = readFileSync(fullPath, "utf8");

    if (relPath.startsWith("src/shared/") && /from\s+["']@\/core\//.test(content)) {
      errors.push(`${relPath}: shared nao pode importar core`);
    }

    if (relPath.startsWith("src/shared/") && /from\s+["']@\/features\//.test(content)) {
      errors.push(`${relPath}: shared nao pode importar features`);
    }

    if (relPath.startsWith("src/core/") && /from\s+["']@\/features\//.test(content)) {
      errors.push(`${relPath}: core nao pode importar features`);
    }
  }
}

walk(SRC_DIR);

if (errors.length > 0) {
  console.error("[check-boundaries] Violacoes encontradas:");
  for (const error of errors) {
    console.error(` - ${error}`);
  }
  process.exit(1);
}

console.log("[check-boundaries] OK");
