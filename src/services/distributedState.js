import { createHash, randomUUID } from "node:crypto";
import { createClient } from "redis";
import { REDIS_URL, isProd, isTest } from "../config/env.js";
import { logger } from "../lib/logger.js";

const KEY_PREFIX = "speexify:distributed:v1:";
const INSTANCE_ID = randomUUID();

let redisClient = null;
let connectPromise = null;

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function getConnectionKeys(ip) {
  return {
    all: `${KEY_PREFIX}ws:connections`,
    ip: `${KEY_PREFIX}ws:connections:ip:${hash(ip || "unknown")}`,
  };
}

function getRoomKey(channel, roomId) {
  return `${KEY_PREFIX}ws:room:${hash(`${channel}:${roomId}`)}`;
}

function getRoomToken(channel, roomId) {
  return hash(`${channel}:${roomId}`);
}

function getRoomsKey(channel) {
  return `${KEY_PREFIX}ws:rooms:${hash(channel)}`;
}

async function getRedisClient() {
  if (isTest || !REDIS_URL) return null;

  if (!redisClient) {
    redisClient = createClient({
      url: REDIS_URL,
      socket: {
        tls: REDIS_URL.startsWith("rediss://"),
        rejectUnauthorized: true,
        reconnectStrategy: false,
      },
    });
    redisClient.on("error", (err) => {
      logger.error({ err }, "[distributed-state] Redis client error");
    });
  }

  if (redisClient.isOpen) return redisClient;

  if (!connectPromise) {
    connectPromise = redisClient
      .connect()
      .then(() => redisClient)
      .catch((err) => {
        logger.error({ err }, "[distributed-state] Redis connect failed");
        return null;
      })
      .finally(() => {
        connectPromise = null;
      });
  }

  await connectPromise;
  return redisClient.isOpen ? redisClient : null;
}

function unavailable(action) {
  if (isProd) {
    return { allowed: false, reason: "distributed_state_unavailable", action };
  }
  return { allowed: true, source: "local_development", action };
}

const acquireConnectionScript = `
  local now = tonumber(ARGV[1])
  local cutoff = now - tonumber(ARGV[2])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return {0, 'total'} end
  if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return {0, 'ip'} end
  redis.call('ZADD', KEYS[1], now, ARGV[5])
  redis.call('ZADD', KEYS[2], now, ARGV[5])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
  redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]) * 2)
  return {1, 'ok'}
`;

const releaseConnectionScript = `
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 1
`;

const touchConnectionScript = `
  if redis.call('ZSCORE', KEYS[1], ARGV[2]) then
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
    redis.call('ZADD', KEYS[2], ARGV[1], ARGV[2])
    redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
    redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]) * 2)
    return 1
  end
  return 0
`;

const acquireRoomScript = `
  local now = tonumber(ARGV[1])
  local cutoff = now - tonumber(ARGV[2])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
  if redis.call('ZSCORE', KEYS[1], ARGV[4]) then return {1, 'existing'} end
  if not redis.call('ZSCORE', KEYS[2], ARGV[6]) and redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return {0, 'rooms'} end
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return {0, 'full'} end
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('ZADD', KEYS[2], now, ARGV[6])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
  redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]) * 2)
  return {1, 'ok'}
`;

const touchRoomScript = `
  if redis.call('ZSCORE', KEYS[1], ARGV[2]) then
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
    redis.call('ZADD', KEYS[2], ARGV[1], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
    redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]) * 2)
    return 1
  end
  return 0
`;

export async function acquireConnection({
  connectionId,
  ip,
  maxTotal,
  maxPerIp,
  leaseMs,
}) {
  const client = await getRedisClient();
  if (!client) return unavailable("connection");

  try {
    const keys = getConnectionKeys(ip);
    const result = await client.eval(acquireConnectionScript, {
      keys: [keys.all, keys.ip],
      arguments: [
        String(Date.now()),
        String(leaseMs),
        String(maxTotal),
        String(maxPerIp),
        `${INSTANCE_ID}:${connectionId}`,
      ],
    });
    const allowed = Number(result?.[0]) === 1;
    return {
      allowed,
      reason: allowed ? undefined : result?.[1] === "ip" ? "ip" : "total",
      source: "redis",
    };
  } catch (err) {
    logger.error({ err }, "[distributed-state] connection admission failed");
    return unavailable("connection");
  }
}

export async function releaseConnection({ connectionId, ip }) {
  const client = await getRedisClient();
  if (!client) return;
  try {
    const keys = getConnectionKeys(ip);
    await client.eval(releaseConnectionScript, {
      keys: [keys.all, keys.ip],
      arguments: [`${INSTANCE_ID}:${connectionId}`],
    });
  } catch (err) {
    logger.warn({ err }, "[distributed-state] connection release failed");
  }
}

export async function touchConnection({ connectionId, ip, leaseMs }) {
  const client = await getRedisClient();
  if (!client) return;
  try {
    const keys = getConnectionKeys(ip);
    await client.eval(touchConnectionScript, {
      keys: [keys.all, keys.ip],
      arguments: [String(Date.now()), `${INSTANCE_ID}:${connectionId}`, String(leaseMs)],
    });
  } catch (err) {
    logger.warn({ err }, "[distributed-state] connection heartbeat failed");
  }
}

export async function acquireRoom({
  channel,
  roomId,
  connectionId,
  maxPeers,
  maxRooms,
  leaseMs,
}) {
  const client = await getRedisClient();
  if (!client) return unavailable("room");

  try {
    const result = await client.eval(acquireRoomScript, {
      keys: [getRoomKey(channel, roomId), getRoomsKey(channel)],
      arguments: [
        String(Date.now()),
        String(leaseMs),
        String(maxPeers),
        `${INSTANCE_ID}:${connectionId}`,
        String(maxRooms),
        getRoomToken(channel, roomId),
      ],
    });
    return {
      allowed: Number(result?.[0]) === 1,
      reason: result?.[1] === "full" || result?.[1] === "rooms" ? result[1] : undefined,
      source: "redis",
    };
  } catch (err) {
    logger.error({ err, channel, roomId }, "[distributed-state] room admission failed");
    return unavailable("room");
  }
}

export async function releaseRoom({ channel, roomId, connectionId }) {
  const client = await getRedisClient();
  if (!client) return;
  try {
    await client.zRem(getRoomKey(channel, roomId), `${INSTANCE_ID}:${connectionId}`);
  } catch (err) {
    logger.warn({ err, channel, roomId }, "[distributed-state] room release failed");
  }
}

export async function touchRoom({ channel, roomId, connectionId, leaseMs }) {
  const client = await getRedisClient();
  if (!client) return;
  try {
    await client.eval(touchRoomScript, {
      keys: [getRoomKey(channel, roomId), getRoomsKey(channel)],
      arguments: [
        String(Date.now()),
        `${INSTANCE_ID}:${connectionId}`,
        String(leaseMs),
        getRoomToken(channel, roomId),
      ],
    });
  } catch (err) {
    logger.warn({ err, channel, roomId }, "[distributed-state] room heartbeat failed");
  }
}

export { INSTANCE_ID };
