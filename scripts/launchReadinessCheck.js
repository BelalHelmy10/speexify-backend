import "dotenv/config";

function hasValue(name) {
  const raw = process.env[name];
  return raw != null && String(raw).trim() !== "";
}

function truthy(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function checkEnv(name, level = "fail", reason = "required") {
  const ok = hasValue(name);
  return {
    id: `env:${name}`,
    ok,
    level,
    message: ok ? `${name} is set` : `${name} is missing (${reason})`,
  };
}

function checkCustom(id, ok, level, message) {
  return { id, ok: Boolean(ok), level, message };
}

function summarize(checks) {
  const failures = checks.filter((c) => !c.ok && c.level === "fail");
  const warnings = checks.filter((c) => !c.ok && c.level === "warn");
  const passed = checks.filter((c) => c.ok);

  return {
    total: checks.length,
    passed: passed.length,
    failures: failures.length,
    warnings: warnings.length,
  };
}

function print(checks, summary) {
  console.log("Launch readiness check");
  console.log("======================");

  for (const check of checks) {
    const marker = check.ok ? "PASS" : check.level === "fail" ? "FAIL" : "WARN";
    console.log(`${marker} ${check.id} - ${check.message}`);
  }

  console.log("----------------------");
  console.log(
    `Summary: ${summary.passed}/${summary.total} passed, ${summary.failures} failures, ${summary.warnings} warnings`
  );
}

function main() {
  const strict = process.argv.includes("--strict");

  const checks = [
    checkEnv("NODE_ENV", "warn", "recommended for deploy runtime"),
    checkCustom(
      "runtime:node_env_prod",
      String(process.env.NODE_ENV || "").toLowerCase() === "production",
      "warn",
      "NODE_ENV should be production in deployed service"
    ),

    checkEnv("DATABASE_URL", "fail", "database connection"),
    checkEnv("DIRECT_URL", "warn", "recommended for Prisma migrations"),
    checkEnv("SESSION_SECRET", "fail", "session signing"),
    checkEnv("ALLOWED_ORIGINS", "fail", "CORS boundary"),

    checkEnv("REDIS_URL", "warn", "required for distributed sessions/rate limiting"),
    checkCustom(
      "runtime:redis_strict",
      truthy("SESSION_REDIS_STRICT", false),
      "warn",
      "SESSION_REDIS_STRICT=true is recommended for production stability"
    ),

    checkEnv("PAYMOB_API_KEY", "fail", "payment provider"),
    checkEnv("PAYMOB_INTEGRATION_ID", "fail", "payment provider"),
    checkEnv("PAYMOB_IFRAME_ID", "fail", "payment provider"),
    checkEnv("PAYMOB_HMAC_SECRET", "fail", "webhook signature validation"),

    checkEnv("OBS_METRICS_TOKEN", "warn", "protect /metrics endpoint"),
    checkCustom(
      "runtime:alerts_enabled",
      truthy("OBS_ALERTS_ENABLED", true),
      "warn",
      "OBS_ALERTS_ENABLED should stay on in production"
    ),

    checkEnv("PRIVACY_CONTACT_EMAIL", "warn", "privacy requests contact"),
    checkEnv("PRIVACY_POLICY_VERSION", "warn", "policy version tracking"),

    checkEnv("BACKUP_SOURCE_DATABASE_URL", "warn", "backup automation source DB"),
    checkEnv("RECOVERY_DRILL_DATABASE_URL", "warn", "backup drill target DB"),
  ];

  const summary = summarize(checks);
  print(checks, summary);

  if (summary.failures > 0) {
    process.exit(1);
  }

  if (strict && summary.warnings > 0) {
    process.exit(1);
  }

  process.exit(0);
}

main();
