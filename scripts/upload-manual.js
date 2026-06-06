/**
 * One-time script to upload manual files to Anthropic Files API.
 *
 * Run from the greasy-lemons directory:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/upload-manual.js
 *
 * Copy the printed IDs into your .env file, then redeploy.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY env var not set.");
  process.exit(1);
}

async function uploadFile(filePath, fileName) {
  const content = readFileSync(filePath, "utf-8");
  const blob = new Blob([content], { type: "text/plain" });
  const formData = new FormData();
  formData.append("file", blob, fileName);

  const res = await fetch("https://api.anthropic.com/v1/files", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    },
    body: formData,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Upload failed for ${fileName}: ${JSON.stringify(data)}`);
  }
  return data.id;
}

console.log("Uploading 2ZZ-GE service specs...");
const specsId = await uploadFile(
  join(__dirname, "../2zz_ge_specs.md"),
  "2zz_ge_specs.md"
);
console.log(`  ✓ ${specsId}`);

console.log("Uploading maintenance schedule...");
const maintId = await uploadFile(
  join(__dirname, "../celica_maintenance.md"),
  "celica_maintenance.md"
);
console.log(`  ✓ ${maintId}`);

console.log("\nAdd these to your .env (and Vercel environment variables):\n");
console.log(`ANTHROPIC_FILE_ID_SPECS=${specsId}`);
console.log(`ANTHROPIC_FILE_ID_MAINTENANCE=${maintId}`);
