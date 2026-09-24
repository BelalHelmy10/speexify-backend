import path from 'node:path';

const configuredRoot = String(process.env.UPLOAD_STORAGE_ROOT || '').trim();
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !configuredRoot) {
  throw new Error(
    'UPLOAD_STORAGE_ROOT must be an absolute, durable shared mount in production'
  );
}

if (isProduction && !path.isAbsolute(configuredRoot)) {
  throw new Error('UPLOAD_STORAGE_ROOT must be an absolute path in production');
}

// Development keeps the existing local default. Production must explicitly
// provide a durable shared filesystem mount (or an object-storage-backed
// adapter before deployment) so uploads survive process replacement and scale.
export const uploadRoot = path.resolve(
  configuredRoot || path.join(process.cwd(), 'uploads')
);

export const uploadStorageInfo = Object.freeze({
  mode: 'filesystem',
  root: uploadRoot,
  durableRequired: isProduction,
});
