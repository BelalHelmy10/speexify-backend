import os from "node:os";
import path from "node:path";
import { isProd, UPLOADS_ENABLED } from "../config/env.js";

const configuredRoot = String(process.env.UPLOAD_STORAGE_ROOT || '').trim();
const isProduction = isProd;

if (isProduction && UPLOADS_ENABLED && !configuredRoot) {
  throw new Error(
    'UPLOAD_STORAGE_ROOT must be an absolute, durable shared mount in production'
  );
}

if (isProduction && UPLOADS_ENABLED && !path.isAbsolute(configuredRoot)) {
  throw new Error('UPLOAD_STORAGE_ROOT must be an absolute path in production');
}

// Disabled production uploads use an isolated temporary path only so the
// upload modules can be imported safely. Route middleware rejects all writes
// before this path can be used. Enabled production uploads require a durable
// shared mount (or an object-storage-backed adapter before deployment).
export const uploadRoot = path.resolve(
  configuredRoot ||
    (isProduction
      ? path.join(os.tmpdir(), "speexify-uploads-disabled")
      : path.join(process.cwd(), "uploads"))
);

export const uploadStorageInfo = Object.freeze({
  mode: 'filesystem',
  root: uploadRoot,
  enabled: UPLOADS_ENABLED,
  durableRequired: isProduction && UPLOADS_ENABLED,
});
