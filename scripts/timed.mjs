#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [key, file, separator, command, ...args] = process.argv.slice(2);
if (!key || !file || separator !== "--" || !command) {
  console.error("usage: node scripts/timed.mjs <key> <timings.json> -- <command> [args...]");
  process.exit(2);
}

const start = performance.now();
const result = spawnSync(command, args, { stdio: "inherit" });
const milliseconds = Math.round(performance.now() - start);

const timings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
timings[key] = milliseconds;
writeFileSync(file, `${JSON.stringify(timings, null, 2)}\n`);

console.log(`${key}: ${milliseconds} ms`);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
