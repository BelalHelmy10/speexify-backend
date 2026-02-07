#!/usr/bin/env node
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

function parseBool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function toTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function toLabel(value) {
  const normalized = String(value || "manual")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "manual";
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

async function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
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

async function collectSnapshotDirs(backupRoot) {
  const entries = await fs.readdir(backupRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(backupRoot, entry.name));
}

async function pruneSnapshots(backupRoot, retentionDays, keepDir) {
  const now = Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  const pruned = [];

  if (!(await pathExists(backupRoot))) return pruned;

  const dirs = await collectSnapshotDirs(backupRoot);
  for (const dir of dirs) {
    if (dir === keepDir) continue;

    const manifestPath = path.join(dir, "manifest.json");
    if (!(await pathExists(manifestPath))) continue;

    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const createdAtMs = new Date(manifest.createdAt).getTime();
      if (!Number.isFinite(createdAtMs)) continue;
      if (now - createdAtMs <= maxAgeMs) continue;

      await fs.rm(dir, { recursive: true, force: true });
      pruned.push(path.basename(dir));
    } catch {
      // Ignore malformed/locked snapshot directories.
    }
  }

  return pruned;
}

async function ensureBinary(binary) {
  try {
    await runCommand(binary, ["--version"]);
  } catch (err) {
    throw new Error(
      `${binary} is required but not available. Install PostgreSQL client tools first.`
    );
  }
}

async function main() {
  const sourceDatabaseUrl =
    process.env.BACKUP_SOURCE_DATABASE_URL ||
    process.env.DIRECT_URL ||
    process.env.DATABASE_URL;

  if (!sourceDatabaseUrl) {
    throw new Error(
      "Missing source database URL. Set BACKUP_SOURCE_DATABASE_URL (or DATABASE_URL)."
    );
  }

  const backupRoot =
    process.env.BACKUP_OUTPUT_DIR || path.join(process.cwd(), "backups");
  const label = toLabel(process.env.BACKUP_LABEL || "manual");
  const includeUploads = parseBool(process.env.BACKUP_INCLUDE_UPLOADS, false);
  const uploadsDir =
    process.env.BACKUP_UPLOADS_DIR || path.join(process.cwd(), "uploads");
  const retentionDays = parsePositiveInt(process.env.BACKUP_RETENTION_DAYS, 14);

  await ensureBinary("pg_dump");
  if (includeUploads) {
    await ensureBinary("tar");
  }

  const timestamp = toTimestamp();
  const snapshotId = `${timestamp}-${label}`;
  const snapshotDir = path.join(backupRoot, snapshotId);
  await fs.mkdir(snapshotDir, { recursive: true });

  const dumpPath = path.join(snapshotDir, "database.dump");
  const dbArgs = [
    "--format=custom",
    "--compress=9",
    "--no-owner",
    "--no-privileges",
    "--file",
    dumpPath,
    sourceDatabaseUrl,
  ];

  const pgDumpVersion = (await runCommand("pg_dump", ["--version"])).stdout
    .trim()
    .replace(/\s+/g, " ");

  await runCommand("pg_dump", dbArgs);
  const dumpStats = await fs.stat(dumpPath);
  const dumpSha = await fileSha256(dumpPath);

  let uploadsArchive = null;
  if (includeUploads && (await pathExists(uploadsDir))) {
    const uploadsArchivePath = path.join(snapshotDir, "uploads.tar.gz");
    const uploadsParent = path.dirname(uploadsDir);
    const uploadsName = path.basename(uploadsDir);
    await runCommand("tar", ["-czf", uploadsArchivePath, "-C", uploadsParent, uploadsName]);
    const uploadStats = await fs.stat(uploadsArchivePath);
    const uploadSha = await fileSha256(uploadsArchivePath);
    uploadsArchive = {
      file: path.basename(uploadsArchivePath),
      sourceDir: uploadsDir,
      sizeBytes: uploadStats.size,
      sha256: uploadSha,
    };
  }

  const manifest = {
    version: 1,
    snapshotId,
    createdAt: new Date().toISOString(),
    host: os.hostname(),
    label,
    retentionDays,
    tools: {
      pgDumpVersion,
      nodeVersion: process.version,
    },
    database: {
      file: path.basename(dumpPath),
      sizeBytes: dumpStats.size,
      sha256: dumpSha,
    },
    uploadsArchive,
  };

  const manifestPath = path.join(snapshotDir, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const prunedSnapshots = await pruneSnapshots(backupRoot, retentionDays, snapshotDir);

  console.log(`Backup snapshot created: ${snapshotId}`);
  console.log(`Snapshot directory: ${snapshotDir}`);
  console.log(`Database dump: ${manifest.database.file} (${manifest.database.sizeBytes} bytes)`);
  if (uploadsArchive) {
    console.log(
      `Uploads archive: ${uploadsArchive.file} (${uploadsArchive.sizeBytes} bytes)`
    );
  }
  if (prunedSnapshots.length) {
    console.log(`Pruned old snapshots: ${prunedSnapshots.join(", ")}`);
  }
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error(`[backup:create] ${err.message}`);
  process.exitCode = 1;
});
