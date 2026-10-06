// A local S3-compatible HTTP fixture exercises the real AWS SDK without credentials.
import http from "node:http";

const objects = new Map();
globalThis.materialStorageTestObjects = objects;
const server = http.createServer(async (req, res) => {
  const key = new URL(req.url, "http://localhost").pathname;
  if (req.method === "PUT") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const gate = globalThis.materialStorageTestGate;
    if (gate) { gate.entered(); await gate.wait; }
    objects.set(key, Buffer.concat(chunks));
    res.setHeader("ETag", '"fixture"');
    return res.end();
  }
  if (req.method === "DELETE") { objects.delete(key); res.statusCode = 204; return res.end(); }
  const body = objects.get(key);
  if (!body) { res.statusCode = 404; return res.end(); }
  res.setHeader("Content-Type", "application/pdf");
  if (req.headers.range) {
    const [, first, last] = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const start = first ? Number(first) : Math.max(0, body.length - Number(last));
    const end = first && last ? Math.min(Number(last), body.length - 1) : body.length - 1;
    if (start >= body.length || start > end) { res.statusCode = 416; return res.end(); }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${body.length}`);
    const partial = body.subarray(start, end + 1);
    res.setHeader("Content-Length", partial.length);
    return res.end(partial);
  }
  res.setHeader("Content-Length", body.length);
  res.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
Object.assign(process.env, {
  CLASSROOM_S3_BUCKET: "private-classroom-test",
  CLASSROOM_S3_REGION: "auto",
  CLASSROOM_S3_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
  CLASSROOM_S3_ACCESS_KEY_ID: "test-only",
  CLASSROOM_S3_SECRET_ACCESS_KEY: "test-only",
});
