/**
 * Run the executor every 5 minutes. Use in production with pm2 or systemd.
 * Usage: npm run build && node loop.js
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function run() {
  const child = spawn(process.execPath, [join(__dirname, "dist", "run-executor.js")], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("close", (code) => {
    if (code !== 0) console.error("Executor exited with code", code);
  });
}

run();
setInterval(run, INTERVAL_MS);
console.log("Executor loop started (every 5 min). Press Ctrl+C to stop.");
