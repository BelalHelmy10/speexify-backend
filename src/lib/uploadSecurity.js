import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UPLOAD_MALWARE_SCAN_COMMAND } from "../config/env.js";
import { uploadRoot } from "./uploadStorage.js";

const execFileAsync = promisify(execFile);
const SCAN_TIMEOUT_MS = 30_000;

async function runScanner(filePath) {
  if (!UPLOAD_MALWARE_SCAN_COMMAND) return;

  try {
    // The command is deployment configuration, while the file path is passed
    // as an argument (never through a shell) to prevent command injection.
    await execFileAsync(
      UPLOAD_MALWARE_SCAN_COMMAND,
      ["--no-summary", filePath],
      { timeout: SCAN_TIMEOUT_MS, maxBuffer: 256 * 1024 }
    );
  } catch (error) {
    const scanError = new Error("Upload rejected by malware scanner");
    scanError.statusCode = 422;
    scanError.cause = error;
    throw scanError;
  }
}

export async function scanUploadFile(filePath) {
  await runScanner(filePath);
}

export async function scanUploadBuffer(buffer, extension = ".bin") {
  if (!UPLOAD_MALWARE_SCAN_COMMAND) return;

  const directory = fs.mkdtempSync(path.join(uploadRoot, ".scan-"));
  const filename = `${crypto.randomBytes(16).toString("hex")}${extension}`;
  const filePath = path.join(directory, filename);

  try {
    fs.writeFileSync(filePath, buffer, { mode: 0o600 });
    await runScanner(filePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
