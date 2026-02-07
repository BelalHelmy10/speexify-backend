import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = process.cwd();
const STRICT_MODE = String(process.env.SECURITY_AUDIT_STRICT || "").trim() === "1";

const TARGETS = ["index.js", "src", "worker"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "coverage", "reports"]);

const RULES = [
  {
    id: "dynamic-eval",
    severity: "high",
    regex: /(?:^|[^\w.$])eval\s*\(/g,
    message: "Dynamic eval usage can introduce code-injection risk.",
  },
  {
    id: "new-function",
    severity: "high",
    regex: /\bnew\s+Function\s*\(/g,
    message: "Dynamic Function constructor can introduce code-injection risk.",
  },
  {
    id: "child-process-exec",
    severity: "medium",
    regex: /\b(exec|execSync|spawn|spawnSync)\s*\(/g,
    message: "Process execution should be reviewed for input sanitization.",
  },
  {
    id: "secret-in-console",
    severity: "medium",
    regex: /console\.(log|info|warn|error)\([\s\S]{0,180}(password|secret|token|api[_-]?key|authorization)/gi,
    message: "Potential sensitive data in console logging statement.",
  },
];

const PRODUCTION_ENV_REQUIREMENTS = [
  "SESSION_SECRET",
  "REDIS_URL",
  "ALLOWED_ORIGINS",
  "WS_ALLOWED_ORIGINS",
  "PAYMOB_HMAC_SECRET",
];

function collectJsFiles(pathFragment) {
  const absolutePath = join(ROOT, pathFragment);

  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    return [];
  }

  if (stats.isFile()) {
    return absolutePath.endsWith(".js") ? [absolutePath] : [];
  }

  if (!stats.isDirectory()) return [];

  const entries = readdirSync(absolutePath);
  const files = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const child = join(pathFragment, entry);
    files.push(...collectJsFiles(child));
  }
  return files;
}

function findLineNumber(content, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function runRule(content, file, rule) {
  const findings = [];
  const regex = new RegExp(rule.regex.source, rule.regex.flags);
  let match;

  while ((match = regex.exec(content)) !== null) {
    const line = findLineNumber(content, match.index);
    findings.push({
      ruleId: rule.id,
      severity: rule.severity,
      file,
      line,
      excerpt: String(match[0]).slice(0, 160),
      message: rule.message,
    });
  }

  return findings;
}

function scanSourceFiles() {
  const allFiles = Array.from(new Set(TARGETS.flatMap((target) => collectJsFiles(target))))
    .sort();

  const findings = [];
  for (const absoluteFile of allFiles) {
    const relativeFile = relative(ROOT, absoluteFile);
    const content = readFileSync(absoluteFile, "utf8");
    for (const rule of RULES) {
      findings.push(...runRule(content, relativeFile, rule));
    }
  }

  return { filesScanned: allFiles.length, findings };
}

function collectEnvReadiness() {
  return PRODUCTION_ENV_REQUIREMENTS.map((name) => ({
    name,
    present: Boolean(String(process.env[name] || "").trim()),
  }));
}

function summarize(findings) {
  const counts = {
    high: findings.filter((item) => item.severity === "high").length,
    medium: findings.filter((item) => item.severity === "medium").length,
    low: findings.filter((item) => item.severity === "low").length,
  };
  return counts;
}

function writeReport(report) {
  const reportsDir = resolve(ROOT, "reports", "security");
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = join(reportsDir, `${stamp}-security-preflight.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

function shouldFail(report) {
  if (STRICT_MODE) {
    return report.summary.high > 0 || report.env.missing.length > 0;
  }
  return report.summary.high > 0;
}

function main() {
  const scan = scanSourceFiles();
  const summary = summarize(scan.findings);
  const envChecks = collectEnvReadiness();
  const missingEnv = envChecks.filter((item) => !item.present).map((item) => item.name);

  const report = {
    generatedAt: new Date().toISOString(),
    strictMode: STRICT_MODE,
    filesScanned: scan.filesScanned,
    summary,
    findings: scan.findings,
    env: {
      checks: envChecks,
      missing: missingEnv,
    },
  };

  const reportPath = writeReport(report);

  console.log("Security preflight summary");
  console.log(`- files scanned: ${scan.filesScanned}`);
  console.log(`- findings (high/medium/low): ${summary.high}/${summary.medium}/${summary.low}`);
  console.log(`- missing required prod env vars: ${missingEnv.length}`);
  console.log(`- report: ${reportPath}`);

  if (missingEnv.length > 0) {
    console.log(`  missing: ${missingEnv.join(", ")}`);
  }

  if (shouldFail(report)) {
    process.exit(1);
  }
}

main();
