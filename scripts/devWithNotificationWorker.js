import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [];
let shuttingDown = false;

function start(label, args) {
  const child = spawn(npmCommand, args, {
    env: process.env,
    stdio: "inherit",
  });

  children.push({ child, label });

  child.on("error", (error) => {
    console.error(`[dev] ${label} failed to start:`, error);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;

    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
    console.error(`[dev] ${label} stopped with ${reason}; stopping the other process.`);
    shutdown(code && code > 0 ? code : 1);
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const { child } of children) {
    if (!child.killed) child.kill("SIGTERM");
  }

  const forceExit = setTimeout(() => process.exit(exitCode), 5_000);
  forceExit.unref();

  let remaining = children.length;
  for (const { child } of children) {
    child.once("exit", () => {
      remaining -= 1;
      if (remaining === 0) process.exit(exitCode);
    });
  }
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("api", ["run", "dev:api"]);
start("notification worker", ["run", "worker:notification-delivery"]);
