# Speexify Jibri recording upload

This integration handles **finished Jibri MP4 files**. It uploads them to a private S3-compatible bucket, registers the object against a Speexify session, and exposes it to admins at `/admin/recordings`. It does not itself start Jibri recordings or capture the separate Speexify resource panel.

## Backend configuration

Set these environment variables on the Speexify API deployment:

| Variable | Purpose |
| --- | --- |
| `RECORDINGS_S3_BUCKET` | Private bucket name |
| `RECORDINGS_S3_REGION` | Bucket region |
| `RECORDINGS_S3_ENDPOINT` | Optional S3-compatible endpoint; omit for AWS S3 |
| `RECORDINGS_S3_ACCESS_KEY_ID` and `RECORDINGS_S3_SECRET_ACCESS_KEY` | Credentials with `HeadObject` and `GetObject` access; omit both if using an AWS IAM role |
| `JIBRI_INGEST_TOKEN` | Random secret of at least 32 characters, shared only with the Jibri upload worker |

Apply the Prisma migration before deploying the new API code. Keep the bucket private and do not enable a public CDN. Configure encryption and a lifecycle retention rule on the bucket according to the approved recording policy. The backend returns a time-limited signed playback URL only after authenticating an admin.

## Jibri upload worker

The `finalize-recording.sh` script accepts the recording directory that Jibri passes to its finalization hook. Run it in an environment with **Bash, AWS CLI v2, and curl**. For Docker Jibri, a custom image or an equivalent host-side worker is needed because these tools are not guaranteed in the stock image. Mount the script into Jibri and set `JIBRI_FINALIZE_RECORDING_SCRIPT_PATH` to its path inside the container.

Set these environment variables on the worker:

| Variable | Purpose |
| --- | --- |
| `RECORDINGS_S3_BUCKET` | Same private bucket as the API |
| `RECORDINGS_S3_ENDPOINT` | Optional endpoint for non-AWS storage |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION` | Credentials with `PutObject` access; use a role instead if available |
| `SPEEXIFY_API_URL` | Public HTTPS origin of the backend, without `/api` |
| `JIBRI_INGEST_TOKEN` | Same secret as the API |
| `JIBRI_DELETE_AFTER_UPLOAD` | Optional `1` to delete the local MP4 after upload and successful registration |

Jibri names files using the room name. The script accepts only `speexify-classroom-<numeric session ID>_*.mp4`, matching the room name built in the frontend. It uploads to `class-recordings/session-<ID>/...` with `session-id` object metadata. The API confirms the matching object with `HeadObject` before creating a database row. Re-running the script for a finished directory is safe: the object key is unique and registration is idempotent. By default the local MP4 stays on disk, so set up disk monitoring or enable deletion after verifying the upload flow.

## Rollout checks

1. Configure and test Jibri itself on `meet.speexify.com` with a short meeting. This repository does not contain that server's deployment or credentials.
2. Confirm a finished MP4 exists on the Jibri host and its filename begins `speexify-classroom-<session ID>_`.
3. Run the finalization script for that directory and confirm it uploads the MP4 and registers it with the API.
4. Sign in as an admin and open `/admin/recordings`. Confirm the video plays and seeking works. Confirm a non-admin gets HTTP 403 from the recording APIs.
5. Test a failed upload, a failed registration, a disconnected class, and two simultaneous classes before enabling unattended recording.

Only Jibri's video-call view is recorded. To include Speexify's separate lesson-resource panel, use a dedicated full-classroom recorder instead.
