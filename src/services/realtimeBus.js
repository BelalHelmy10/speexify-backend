import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

const origin = randomUUID();
const handlers = new Map();
let publisher;
let subscriber;
let initializing;
const channel = 'speexify:realtime:v1';

function redisSocketOptions() {
  return {
    reconnectStrategy: (retries) => Math.min(1_000 * Math.max(1, retries), 5_000),
  };
}

export function onRealtimeEvent(topic, handler) {
  handlers.set(topic, handler);
}
export function startRealtimeBus() {
  if (initializing) return initializing;
  if (!process.env.REDIS_URL || process.env.NODE_ENV === 'test') return Promise.resolve();
  // Redis clients reconnect themselves after a transient outage. Do not create
  // a second publisher/subscriber pair while that recovery is in progress.
  if (publisher || subscriber) return Promise.resolve();
  let nextPublisher;
  let nextSubscriber;
  initializing = (async () => {
    nextPublisher = createClient({ url: process.env.REDIS_URL, socket: redisSocketOptions() });
    nextSubscriber = nextPublisher.duplicate();
    for (const client of [nextPublisher, nextSubscriber]) {
      client.on('error', err => logger.error({ err }, 'Realtime Redis error'));
    }
    await Promise.all([nextPublisher.connect(), nextSubscriber.connect()]);
    await nextSubscriber.subscribe(channel, raw => {
      try {
        const event = JSON.parse(raw);
        if (event.origin !== origin) handlers.get(event.topic)?.(event.payload);
      } catch (err) { logger.error({err}, 'Invalid realtime event'); }
    });
    publisher = nextPublisher;
    subscriber = nextSubscriber;
  })().catch(async (err) => {
    for (const client of [nextPublisher, nextSubscriber, publisher, subscriber]) {
      if (client?.isOpen) await client.quit().catch(() => {});
    }
    publisher = undefined;
    subscriber = undefined;
    throw err;
  }).finally(() => {
    initializing = undefined;
  });
  return initializing;
}
export function publishRealtimeEvent(topic, payload) {
  // Local delivery remains immediate; persisted notifications remain the recovery source.
  void startRealtimeBus().then(() => publisher?.isReady && publisher.publish(channel, JSON.stringify({origin, topic, payload})))
    .catch(err => logger.error({err, topic}, 'Realtime publish failed'));
}
