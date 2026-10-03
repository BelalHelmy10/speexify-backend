#!/usr/bin/env bash
set -euo pipefail

# Jibri invokes this script with the directory for one finished recording.
# The Jibri image must provide aws-cli and curl, or this script can run on a
# host that mounts the same recording directory.
: "${RECORDINGS_S3_BUCKET:?Set RECORDINGS_S3_BUCKET}"
: "${SPEEXIFY_API_URL:?Set SPEEXIFY_API_URL}"
: "${JIBRI_INGEST_TOKEN:?Set JIBRI_INGEST_TOKEN}"

recording_dir=${1:?Pass Jibri recording directory}
if [[ ! -d "$recording_dir" ]]; then
  echo "Recording directory does not exist" >&2
  exit 1
fi

shopt -s nullglob
files=("$recording_dir"/*.mp4)
if (( ${#files[@]} == 0 )); then
  echo "No MP4 recording found in $recording_dir" >&2
  exit 1
fi

for file in "${files[@]}"; do
  filename=${file##*/}
  if [[ ! "$filename" =~ ^speexify-classroom-([0-9]+)_[A-Za-z0-9._-]+\.mp4$ ]]; then
    echo "Unexpected Jibri filename: $filename" >&2
    exit 1
  fi

  session_id=${BASH_REMATCH[1]}
  key="class-recordings/session-${session_id}/${filename}"
  aws_args=()
  if [[ -n "${RECORDINGS_S3_ENDPOINT:-}" ]]; then
    aws_args+=(--endpoint-url "$RECORDINGS_S3_ENDPOINT")
  fi
  aws_args+=(s3 cp "$file" "s3://${RECORDINGS_S3_BUCKET}/${key}" --no-progress --content-type video/mp4 --metadata "session-id=${session_id}")
  aws "${aws_args[@]}"

  payload=$(printf '{"sessionId":%s,"key":"%s"}' "$session_id" "$key")
  curl --fail --silent --show-error --retry 3 \
    --request POST \
    --header "Authorization: Bearer ${JIBRI_INGEST_TOKEN}" \
    --header "Content-Type: application/json" \
    --data "$payload" \
    "${SPEEXIFY_API_URL%/}/api/internal/jibri/recordings"

  if [[ "${JIBRI_DELETE_AFTER_UPLOAD:-0}" == "1" ]]; then
    rm -- "$file"
  fi
done
