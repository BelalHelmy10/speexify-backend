#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--snapshot") {
      args.snapshot = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--skip-backup") {
      args.skipBackup = true;
      continue;
    }
  }
  return args;
}

async function runCommand(cmd, args, options = {}) {
  const { cwd = process.cwd(), env = process.env } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const err = new Error(
        `${cmd} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
      );
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureBinary(binary) {
  try {
    await runCommand(binary, ["--version"]);
  } catch {
    throw new Error(
      `${binary} is required but not available. Install PostgreSQL client tools first.`
    );
  }
}

function parseSnapshotDirFromBackupOutput(output) {
  const line = String(output || "")
    .split("\n")
    .find((entry) => entry.startsWith("Snapshot directory: "));
  if (!line) return null;
  return line.replace("Snapshot directory: ", "").trim();
}

function parseSimpleCount(output) {
  const cleaned = String(output || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = cleaned[cleaned.length - 1];
  const value = Number(last);
  return Number.isFinite(value) ? value : null;
}

async function findLatestSnapshotDir(backupRoot) {
  const entries = await fs.readdir(backupRoot, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(backupRoot, entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    try {
      const manifestRaw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(manifestRaw);
      candidates.push({
        dir,
        createdAt: new Date(manifest.createdAt).getTime(),
      });
    } catch {
      // Ignore invalid snapshot dirs.
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.createdAt - a.createdAt);
  return candidates[0].dir;
}

async function runPsqlCountQuery(databaseUrl, tableName) {
  const query = `SELECT COUNT(*) FROM "${tableName}";`;
  const { stdout } = await runCommand("psql", [
    databaseUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-t",
    "-A",
    "-c",
    query,
  ]);
  return parseSimpleCount(stdout);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = process.cwd();
  const backupRoot =
    process.env.BACKUP_OUTPUT_DIR || path.join(projectRoot, "backups");
  const drillDatabaseUrl = process.env.RECOVERY_DRILL_DATABASE_URL;
  const sourceDatabaseUrl =
    process.env.BACKUP_SOURCE_DATABASE_URL ||
    process.env.DIRECT_URL ||
    process.env.DATABASE_URL;

  if (!sourceDatabaseUrl) {
    throw new Error(
      "Missing source database URL. Set BACKUP_SOURCE_DATABASE_URL (or DATABASE_URL)."
    );
  }

  if (!drillDatabaseUrl) {
    throw new Error(
      "Missing RECOVERY_DRILL_DATABASE_URL. Recovery drills must run on a separate drill/staging database."
    );
  }

  if (drillDatabaseUrl === sourceDatabaseUrl) {
    throw new Error(
      "RECOVERY_DRILL_DATABASE_URL must not match source database URL."
    );
  }

  const startedAt = new Date();
  let snapshotDir = args.snapshot || null;

  await ensureBinary("psql");

  if (!snapshotDir && !args.skipBackup) {
    const backupRun = await runCommand(
      process.execPath,
      [path.join(projectRoot, "scripts", "backupCreate.js")],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          BACKUP_LABEL: process.env.BACKUP_LABEL || "drill",
          BACKUP_SOURCE_DATABASE_URL: sourceDatabaseUrl,
        },
      }
    );
    snapshotDir = parseSnapshotDirFromBackupOutput(backupRun.stdout);
  }

  if (!snapshotDir) {
    snapshotDir = await findLatestSnapshotDir(backupRoot);
  }

  if (!snapshotDir) {
    throw new Error("Could not resolve a snapshot for recovery drill.");
  }

  let absoluteSnapshotDir = snapshotDir;
  if (!path.isAbsolute(absoluteSnapshotDir)) {
    const fromCwd = path.join(projectRoot, absoluteSnapshotDir);
    const fromBackupRoot = path.join(backupRoot, absoluteSnapshotDir);
    if (await pathExists(path.join(fromCwd, "manifest.json"))) {
      absoluteSnapshotDir = fromCwd;
    } else {
      absoluteSnapshotDir = fromBackupRoot;
    }
  }

  const restoreRun = await runCommand(
    process.execPath,
    [
      path.join(projectRoot, "scripts", "backupRestore.js"),
      "--snapshot",
      absoluteSnapshotDir,
      "--yes",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        RESTORE_DATABASE_URL: drillDatabaseUrl,
      },
    }
  );

  const migrationCount = await runPsqlCountQuery(
    drillDatabaseUrl,
    "_prisma_migrations"
  );
  const userCount = await runPsqlCountQuery(drillDatabaseUrl, "User");
  const sessionCount = await runPsqlCountQuery(drillDatabaseUrl, "Session");

  const finishedAt = new Date();
  const report = {
    status: "passed",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    snapshotDir: absoluteSnapshotDir,
    checks: {
      migrationCount,
      userCount,
      sessionCount,
    },
    restoreSummary: restoreRun.stdout.trim(),
  };

  const reportDir = path.join(backupRoot, "drills");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(
    reportDir,
    `drill-${finishedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.json`
  );
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("Recovery drill passed.");
  console.log(`Snapshot used: ${absoluteSnapshotDir}`);
  console.log(`Report: ${reportPath}`);
}

main().catch(async (err) => {
  const backupRoot =
    process.env.BACKUP_OUTPUT_DIR || path.join(process.cwd(), "backups");
  const finishedAt = new Date();
  const reportDir = path.join(backupRoot, "drills");

  try {
    await fs.mkdir(reportDir, { recursive: true });
    const reportPath = path.join(
      reportDir,
      `drill-${finishedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-failed.json`
    );
    const report = {
      status: "failed",
      finishedAt: finishedAt.toISOString(),
      error: err.message,
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.error(`[backup:drill] ${err.message}`);
    console.error(`Failure report: ${reportPath}`);
  } catch {
    console.error(`[backup:drill] ${err.message}`);
  }

  process.exitCode = 1;
});
