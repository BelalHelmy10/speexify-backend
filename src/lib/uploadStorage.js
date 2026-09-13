import path from 'node:path';
// Configure a shared, durable filesystem mount in production. Defaults preserve
// existing development files. Object storage requires a separate adapter.
export const uploadRoot = path.resolve(process.env.UPLOAD_STORAGE_ROOT || path.join(process.cwd(), 'uploads'));
