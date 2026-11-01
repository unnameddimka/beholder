// Basic check: `node --check` on every JavaScript file in the project (excluding data and dependencies).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["node_modules", "data", ".git"]);
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) files.push(full);
  }
})(root);
let failed = 0;
for (const file of files) {
  try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }); }
  catch (error) { failed += 1; console.error(`Syntax error in ${path.relative(root, file)}:\n${error.stderr}`); }
}
console.log(`node --check: ${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
