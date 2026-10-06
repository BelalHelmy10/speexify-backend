import http from "node:http";
import express from "express";
import multer from "multer";
import assert from "node:assert/strict";

const objects = new Map();
globalThis.materialStorageTestObjects = objects;
const app = express();
app.post("/v1_1/test-cloud/raw/upload", multer().single("file"), async (req, res) => {
  assert.equal(req.body.type, "authenticated");
  assert.ok(["false", "0"].includes(req.body.overwrite));
  assert.equal(req.body.api_key, "test-key");
  const gate = globalThis.materialStorageTestGate;
  if (gate) { gate.entered(); await gate.wait; }
  objects.set(req.body.public_id, req.file.buffer);
  assert.equal(req.body.moderation, "perception_point");
  const rejected = globalThis.rejectNextCloudinaryPdf;
  globalThis.rejectNextCloudinaryPdf = false;
  res.json({ public_id: req.body.public_id, type: "authenticated", resource_type: "raw",
    moderation: [{ kind: "perception_point", status: rejected ? "rejected" : "approved" }] });
});
app.post("/v1_1/test-cloud/raw/destroy", multer().none(), express.urlencoded({ extended: false }), (req, res) => {
  assert.equal(req.body.type, "authenticated");
  objects.delete(req.body.public_id);
  res.json({ result: "ok" });
});
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.CLOUDINARY_URL = `cloudinary://test-key:test-secret@test-cloud?upload_prefix=${encodeURIComponent(`http://127.0.0.1:${server.address().port}`)}`;
Object.assign(process.env, {
  CLASSROOM_CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLASSROOM_CLOUDINARY_API_KEY: "test-key",
  CLASSROOM_CLOUDINARY_API_SECRET: "test-secret",
  CLASSROOM_CLOUDINARY_MALWARE_SCAN: "true",
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith("https://res.cloudinary.com/test-cloud/")) return originalFetch(url, options);
  const path = new URL(url).pathname;
  assert.match(path, /\/raw\/authenticated\/s--[\w-]+--\//);
  const id = path.slice(path.indexOf("classroom-materials/"));
  const body = objects.get(id);
  if (!body) return new Response(null, { status: 404 });
  const headers = { "Content-Type": "application/pdf", "Accept-Ranges": "bytes" };
  const range = options.headers.Range;
  if (range) {
    const [, first, last] = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = first ? Number(first) : Math.max(0, body.length - Number(last));
    const end = first && last ? Math.min(Number(last), body.length - 1) : body.length - 1;
    if (start >= body.length || start > end) return new Response(null, { status: 416 });
    const partial = body.subarray(start, end + 1);
    return new Response(partial, { status: 206, headers: { ...headers,
      "Content-Length": String(partial.length), "Content-Range": `bytes ${start}-${end}/${body.length}` } });
  }
  return new Response(body, { headers: { ...headers, "Content-Length": String(body.length) } });
};
