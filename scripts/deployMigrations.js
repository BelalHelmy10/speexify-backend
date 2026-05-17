import "dotenv/config";
import { spawnSync } from "node:child_process";

const REQUIRED_ENV = ["DATABASE_URL", "DIRECT_URL"];

function readEnv(name) {
  return String(process.env[name] || "").trim();
}

function describeDatabaseUrl(name) {
  const value = readEnv(name);
  if (!value) return `${name}=missing`;

  try {
    const url = new URL(value);
    const database = url.pathname.replace(/^\/+/, "") || "(no database)";
    return `${name}=${url.protocol}//${url.hostname}:${url.port || "(default)"}/${database}`;
  } catch {
    return `${name}=invalid URL`;
  }
}

function parseDatabaseUrl(name) {
  try {
    return new URL(readEnv(name));
  } catch {
    return null;
  }
}

function validateEnv() {
  const missing = REQUIRED_ENV.filter((name) => !readEnv(name));

  if (missing.length > 0) {
    console.error(`Missing required Prisma migration env var(s): ${missing.join(", ")}`);
    console.error("Set DATABASE_URL and DIRECT_URL in Render before deploying.");
    process.exit(1);
  }

  for (const name of REQUIRED_ENV) {
    const value = readEnv(name);
    if (!value.startsWith("postgresql://") && !value.startsWith("postgres://")) {
      console.error(`${name} must be a PostgreSQL connection string.`);
      console.error(`${describeDatabaseUrl(name)}`);
      process.exit(1);
    }
  }

  const directUrl = parseDatabaseUrl("DIRECT_URL");
  if (
    directUrl?.hostname.includes("pooler.supabase.com") &&
    directUrl.port === "5432" &&
    directUrl.username === "postgres"
  ) {
    console.error(
      "DIRECT_URL is using Supabase session pooler, but the username is only `postgres`.",
    );
    console.error(
      "For Supabase pooler URLs, the username should be `postgres.<project-ref>`.",
    );
    console.error(
      "Copy the full Session pooler connection string from Supabase and replace [YOUR-PASSWORD] with the database password.",
    );
    process.exit(1);
  }
}

validateEnv();

console.log("Running Prisma migrations with:");
console.log(`- ${describeDatabaseUrl("DATABASE_URL")}`);
console.log(`- ${describeDatabaseUrl("DIRECT_URL")}`);

const result = spawnSync(
  process.execPath,
  ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { stdio: "inherit" },
);

if (result.error) {
  console.error("Failed to start Prisma migrate deploy.");
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error("Prisma migrate deploy failed.");
  console.error(
    "On Render with Supabase, use the session pooler for DIRECT_URL: pooler.supabase.com:5432/postgres.",
  );
  console.error(
    "The direct db.<project-ref>.supabase.co:5432 host is IPv6-only unless your Supabase project has the IPv4 add-on.",
  );
  process.exit(result.status || 1);
}
