import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPaths = [
  fileURLToPath(new URL("../../.env", import.meta.url)),
  fileURLToPath(new URL("../.env", import.meta.url)),
];

for (const envPath of envPaths) {
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    const separator = value.indexOf("=");
    if (separator < 1) continue;
    const key = value.slice(0, separator).trim();
    let content = value.slice(separator + 1).trim();
    if (
      (content.startsWith('"') && content.endsWith('"')) ||
      (content.startsWith("'") && content.endsWith("'"))
    ) {
      content = content.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = content;
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
