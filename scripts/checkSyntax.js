import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const TARGETS = [
  "index.js",
  "src",
  "worker",
  "prisma",
  "scripts",
  "tests",
];
const IGNORE_DIRS = new Set(["node_modules", ".git", ".next", "coverage"]);

function listJsFiles(path) {
  const fullPath = join(ROOT, path);
  let entries = [];

  try {
    entries = readdirSync(fullPath);
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue;
    const relativePath = join(path, entry);
    const absolutePath = join(ROOT, relativePath);

    let stats;
    try {
      stats = statSync(absolutePath);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      files.push(...listJsFiles(relativePath));
      continue;
    }

    if (extname(entry) === ".js") {
      files.push(relativePath);
    }
  }

  return files;
}

function gatherTargets() {
  const files = [];

  for (const target of TARGETS) {
    const absoluteTarget = join(ROOT, target);

    let stats;
    try {
      stats = statSync(absoluteTarget);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      files.push(...listJsFiles(target));
      continue;
    }

    if (extname(target) === ".js") {
      files.push(target);
    }
  }

  return Array.from(new Set(files)).sort();
}

function checkFile(file) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: ROOT,
    encoding: "utf8",
  });

  return result;
}

const files = gatherTargets();
if (files.length === 0) {
  console.log("No JavaScript files found for syntax check.");
  process.exit(0);
}

let hasFailures = false;
for (const file of files) {
  const result = checkFile(file);
  if (result.status === 0) continue;

  hasFailures = true;
  console.error(`Syntax check failed: ${file}`);
  if (result.stderr) console.error(result.stderr.trim());
}

if (hasFailures) {
  process.exit(1);
}

console.log(`Syntax check passed for ${files.length} files.`);
