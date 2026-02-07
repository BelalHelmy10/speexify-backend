import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

const contextStorage = new AsyncLocalStorage();

function randomHex(sizeBytes) {
  return crypto.randomBytes(sizeBytes).toString("hex");
}

function normalizeId(raw, maxLength) {
  if (!raw) return "";
  return String(raw).trim().slice(0, maxLength);
}

function extractTraceIdFromTraceparent(headerValue) {
  if (!headerValue) return "";
  const raw = String(headerValue).trim();
  // traceparent format: 00-<trace-id>-<span-id>-<flags>
  const parts = raw.split("-");
  if (parts.length !== 4) return "";
  const traceId = parts[1];
  if (!/^[a-fA-F0-9]{32}$/.test(traceId)) return "";
  return traceId.toLowerCase();
}

export function buildRequestContext(req) {
  const requestId =
    normalizeId(req.get?.("x-request-id"), 128) || crypto.randomUUID();

  const traceId =
    extractTraceIdFromTraceparent(req.get?.("traceparent")) ||
    normalizeId(req.get?.("x-trace-id"), 64) ||
    randomHex(16);

  const spanId = randomHex(8);

  return {
    requestId,
    traceId,
    spanId,
    startedAt: Date.now(),
  };
}

export function runWithRequestContext(context, fn) {
  return contextStorage.run(context, fn);
}

export function getRequestContext() {
  return contextStorage.getStore() || null;
}
