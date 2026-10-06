# Classroom PDF uploads

Classroom PDFs use private S3-compatible or authenticated Cloudinary storage in production. Legacy
avatar/support uploads can remain disabled. Local development uses the existing
upload directory when no bucket is configured. No database migration is needed.

## Cloudinary Free (selected for this setup)

The selected account has 25 shared credits and a 10 MB maximum raw/image file
size. Uploads use `raw/authenticated` and unique per-session public IDs. The
backend streams authenticated delivery to classroom members; signed upstream
URLs and credentials stay on the backend. No PDF image transformations occur.

1. In Cloudinary Security, enable “Allow delivery of PDF and ZIP files” after
   the account owner approves this account-wide change.
2. Register for the Perception Point Malware Detection **Free** add-on (50 scans
   per month). Review and accept its terms yourself when requested. Do not
   select a paid add-on plan. The app cannot determine the remaining scanner
   quota from its base credit balance.
3. Copy the existing cloud name, API key and secret to Render's backend
   environment after approval to transfer these credentials:

```dotenv
UPLOADS_ENABLED=false
CLASSROOM_UPLOADS_ENABLED=true
CLASSROOM_CLOUDINARY_CLOUD_NAME=YOUR_CLOUD_NAME
CLASSROOM_CLOUDINARY_API_KEY=YOUR_API_KEY
CLASSROOM_CLOUDINARY_API_SECRET=YOUR_API_SECRET
CLASSROOM_CLOUDINARY_MALWARE_SCAN=true
```

With remote scanning enabled, the uploaded PDF is kept private while the backend
waits for an explicit `perception_point` approval. Rejected scans, missing scan
results, timeouts, and provider errors fail closed. Unapproved objects are
deleted, and no classroom material entry is created. Two concurrent uploads per
backend process bound the waiting work. Polling uses at most ten Admin API calls
per upload, each with a five-second request timeout. Quota exhaustion must be
tested in the real account; never bypass scanning to continue uploads.

If remote scanning is disabled, the existing local scanner is still mandatory
in production. Do not set a dummy scanner command. Local development can omit
scanning, but production may not.

The list endpoint reports the configured maximum PDF size, so the picker rejects
oversized files before sending them. The server enforces the same limit.
New entries use `cloudinary:` in the filename column; existing S3/local entries
remain readable through their original storage adapters.

```sh
NODE_ENV=test node --import ./tests/fixtures/classroomCloudinaryServer.js --test tests/integration/classroom-materials.test.js
```

This local fixture uses the real SDK for multipart uploads, deletion and signed
delivery URL generation, with mocked provider responses. It tests approved and
rejected scans, access checks, ranges, rollback, file limits and concurrency.
It does not substitute for a real account upload/scan/download verification.

References: [Cloudinary authenticated assets](https://cloudinary.com/documentation/control_access_to_media),
[Perception Point scanning](https://cloudinary.com/documentation/perception_point_malware_detection_addon).

## No-card setup: Supabase Free

Use a new Supabase project in a **Free** organization. Do not add a payment method
or upgrade the organization. The Free plan includes 1 GB file storage and 5 GB
uncached egress per month (plus a separate 5 GB cached egress allowance). Exceeding
free quotas can restrict service; inactive free projects can be paused.

1. Create a Free project. The existing classroom database stays where it is;
   this project is used only for uploaded PDF storage.
2. In Storage, create a **private** bucket named `speexify-classroom-pdfs`, with a
   25 MB upload limit and `application/pdf` as its allowed content type. Do not
   add public access policies.
3. In Storage > Configuration > S3, generate server-side S3 credentials and copy
   the displayed region and endpoint. Use the direct storage endpoint shown by
   Supabase, normally `https://PROJECT_REF.storage.supabase.co/storage/v1/s3`.
   These credentials can access all buckets in the project, so use a dedicated
   project and keep them exclusively on the backend.
4. Configure the backend variables below using the displayed values:

```dotenv
UPLOADS_ENABLED=false
CLASSROOM_UPLOADS_ENABLED=true
CLASSROOM_S3_BUCKET=speexify-classroom-pdfs
CLASSROOM_S3_REGION=YOUR_PROJECT_REGION
CLASSROOM_S3_ENDPOINT=https://YOUR_PROJECT_REF.storage.supabase.co/storage/v1/s3
CLASSROOM_S3_ACCESS_KEY_ID=YOUR_STORAGE_ACCESS_KEY
CLASSROOM_S3_SECRET_ACCESS_KEY=YOUR_STORAGE_SECRET_KEY
UPLOAD_MALWARE_SCAN_COMMAND=/absolute/path/to/working-scanner
```

The scanner requirement below still applies. Keep uploads disabled until storage
and scanning are provisioned and verified. A no-card storage account does not
by itself complete the live backend setup.

References: [Supabase pricing](https://supabase.com/pricing),
[free quota restrictions](https://supabase.com/docs/guides/platform/billing-faq),
[private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals),
[S3 credentials](https://supabase.com/docs/guides/storage/s3/authentication).

## Optional Cloudflare R2 storage (billing enrollment required)

1. Sign in to Cloudflare and enable R2. Review its subscription and usage pricing
   before accepting the checkout flow.
2. Create a bucket named `speexify-classroom-pdfs`. Leave public access disabled.
3. Create an R2 API token with Object Read & Write access scoped to this bucket.
4. Add the following **backend-only** environment variables in Render. Never put
   the secret in the frontend or commit it to Git:

```dotenv
UPLOADS_ENABLED=false
CLASSROOM_UPLOADS_ENABLED=true
CLASSROOM_S3_BUCKET=speexify-classroom-pdfs
CLASSROOM_S3_REGION=auto
CLASSROOM_S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
CLASSROOM_S3_ACCESS_KEY_ID=YOUR_BUCKET_ACCESS_KEY
CLASSROOM_S3_SECRET_ACCESS_KEY=YOUR_BUCKET_SECRET_KEY
UPLOAD_MALWARE_SCAN_COMMAND=/absolute/path/to/clamscan
```

The scanner must be installed in the backend runtime with current malware
definitions. The application invokes it without a shell, passing
`--no-summary <temporary-file>` and enforcing a 30-second timeout. A missing,
failed or timed-out scanner rejects the upload; a placeholder command does not
provide scanning. Do not enable the flag until the scanner is provisioned.
Enabling the flag without a scanner command or durable storage fails startup.

For AWS S3, use your bucket's actual region, omit `CLASSROOM_S3_ENDPOINT`, and
use a backend IAM role or a bucket-scoped credential pair with PutObject,
GetObject and DeleteObject permissions. Keep the bucket private.

References: [R2 setup](https://developers.cloudflare.com/r2/get-started/),
[R2 S3 credentials](https://developers.cloudflare.com/r2/get-started/s3/).

## Behavior and performance

- Teachers upload PDFs up to 25 MB to their own scheduled/completed sessions.
- Files stream to temporary disk, are checked for PDF header/trailer and scanned,
  then streamed into the bucket. Temporary files are removed after completion or
  failure. At most two uploads are processed concurrently per backend process.
- Storage writes have a 60-second deadline. If database creation fails, the
  corresponding object is deleted. Rollback failures are logged for cleanup.
- Learners and teachers retrieve files through the authenticated session API.
  The bucket and storage credentials are never exposed to the browser. Downloads
  stream with backpressure and support byte ranges; disconnected readers abort
  object retrieval. No public URLs or bucket CORS changes are required.
- Uploaded PDFs load in 256 KB ranges in the PDF.js worker with automatic
  background fetching disabled. Existing catalog PDFs retain their loading mode.
- The picker shows upload progress, followed by preparation status. When ready,
  the PDF opens through the existing classroom resource selection and annotation
  flow. The classroom stays usable during uploading.
- Old filesystem filenames remain readable. New object storage entries use an
  `s3:` filename marker. Keep the same bucket/endpoint while those entries exist.
- Closing a resource tab keeps its uploaded PDF and annotations available for
  the session. Bucket lifecycle policies must not delete active materials.

## Verification before enabling production

```sh
NODE_ENV=test node --test tests/integration/classroom-materials.test.js tests/unit/env-config.test.js
NODE_ENV=test node --import ./tests/fixtures/classroomS3Server.js --test tests/integration/classroom-materials.test.js
```

The second command uses a local S3-compatible fixture with the real AWS SDK.
It verifies storage writes, membership checks, partial reads, invalid ranges,
file limits, and rollback after a database failure. No real credentials or
production database writes are used.

After deployment, upload a prepared PDF in a test classroom, open it as the
learner, switch resources, annotate, close/reopen, then restart the backend and
verify the same PDF still loads. Compare classroom audio/video responsiveness
on a representative connection during a large upload; automated route tests
alone cannot establish real-call performance.
