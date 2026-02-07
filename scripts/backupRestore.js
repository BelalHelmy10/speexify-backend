#!/usr/bin/env node
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    if (token === "--yes") {
      args.yes = true;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "--restore-uploads") {
      args.restoreUploads = true;
      continue;
    }
    if (token === "--snapshot") {
      args.snapshot = argv[i + 1];
      i += 1;
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

async function ensureBinary(binary) {
  try {
    await runCommand(binary, ["--version"]);
  } catch {
    throw new Error(
      `${binary} is required but not available. Install PostgreSQL client tools first.`
    );
  }
}

async function findLatestSnapshotDir(backupRoot) {
  const entries = await fs.readdir(backupRoot, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(backupRoot, entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    if (!(await pathExists(manifestPath))) continue;
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      candidates.push({
        dir,
        createdAt: new Date(manifest.createdAt).getTime(),
      });
    } catch {
      // Ignore bad manifests.
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.createdAt - a.createdAt);
  return candidates[0].dir;
}

async function resolveSnapshotDir(backupRoot, snapshotArg) {
  if (snapshotArg) {
    const direct = path.isAbsolute(snapshotArg)
      ? snapshotArg
      : path.join(backupRoot, snapshotArg);
    if (await pathExists(path.join(direct, "manifest.json"))) {
      return direct;
    }

    const manifestPath = path.isAbsolute(snapshotArg)
      ? snapshotArg
      : path.join(process.cwd(), snapshotArg);

    if (
      manifestPath.endsWith("manifest.json") &&
      (await pathExists(manifestPath))
    ) {
      return path.dirname(manifestPath);
    }

    throw new Error(`Snapshot not found: ${snapshotArg}`);
  }

  const latest = await findLatestSnapshotDir(backupRoot);
  if (!latest) {
    throw new Error(`No backup snapshots found in ${backupRoot}`);
  }
  return latest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const backupRoot =
    process.env.BACKUP_OUTPUT_DIR || path.join(process.cwd(), "backups");
  const restoreDatabaseUrl = process.env.RESTORE_DATABASE_URL;
  const uploadsRestoreDir =
    process.env.RESTORE_UPLOADS_DIR || path.join(process.cwd(), "uploads");

  if (!restoreDatabaseUrl) {
    throw new Error("Set RESTORE_DATABASE_URL before running backup:restore.");
  }

  await ensureBinary("pg_restore");
  if (args.restoreUploads) {
    await ensureBinary("tar");
  }

  const snapshotDir = await resolveSnapshotDir(backupRoot, args.snapshot);
  const manifestPath = path.join(snapshotDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  const dumpPath = path.join(snapshotDir, manifest?.database?.file || "");
  if (!(await pathExists(dumpPath))) {
    throw new Error(`Database dump not found in snapshot: ${dumpPath}`);
  }

  const currentDumpSha = await fileSha256(dumpPath);
  if (
    manifest?.database?.sha256 &&
    manifest.database.sha256.toLowerCase() !== currentDumpSha.toLowerCase()
  ) {
    throw new Error("Database dump checksum mismatch. Restore aborted.");
  }

  if (!args.yes && !args.dryRun) {
    throw new Error(
      "Refusing to restore without confirmation. Re-run with --yes (or --dry-run)."
    );
  }

  const verifyArgs = ["--list", dumpPath];
  const restoreArgs = [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    "--dbname",
    restoreDatabaseUrl,
    dumpPath,
  ];

  console.log(`Using snapshot: ${manifest.snapshotId || path.basename(snapshotDir)}`);
  console.log(`Snapshot directory: ${snapshotDir}`);
  console.log(`Target database: RESTORE_DATABASE_URL`);

  if (args.dryRun) {
    console.log(`[dry-run] pg_restore ${verifyArgs.join(" ")}`);
    console.log(`[dry-run] pg_restore ${restoreArgs.join(" ")}`);
  } else {
    await runCommand("pg_restore", verifyArgs);
    await runCommand("pg_restore", restoreArgs);
  }

  if (args.restoreUploads && manifest.uploadsArchive?.file) {
    const uploadsArchivePath = path.join(snapshotDir, manifest.uploadsArchive.file);
    if (!(await pathExists(uploadsArchivePath))) {
      throw new Error(`Uploads archive missing: ${uploadsArchivePath}`);
    }

    if (manifest.uploadsArchive.sha256) {
      const uploadSha = await fileSha256(uploadsArchivePath);
      if (uploadSha.toLowerCase() !== manifest.uploadsArchive.sha256.toLowerCase()) {
        throw new Error("Uploads archive checksum mismatch. Restore aborted.");
      }
    }

    const parentDir = path.dirname(uploadsRestoreDir);
    await fs.mkdir(parentDir, { recursive: true });

    const tarArgs = ["-xzf", uploadsArchivePath, "-C", parentDir];
    if (args.dryRun) {
      console.log(`[dry-run] tar ${tarArgs.join(" ")}`);
    } else {
      await runCommand("tar", tarArgs);
    }
  }

  console.log(
    args.dryRun
      ? "Restore dry run completed."
      : "Restore completed successfully."
  );
}

main().catch((err) => {
  console.error(`[backup:restore] ${err.message}`);
  process.exitCode = 1;
});
