import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

const origin = randomUUID();
const handlers = new Map();
let publisher;
let initializing;
const channel = 'speexify:realtime:v1';
export function onRealtimeEvent(topic, handler) {
  handlers.set(topic, handler);
}
export function startRealtimeBus() {
  if (initializing) return initializing;
  if (!process.env.REDIS_URL || process.env.NODE_ENV === 'test') return Promise.resolve();
  initializing = (async () => {
    publisher = createClient({url: process.env.REDIS_URL, socket: { reconnectStrategy: false }});
    const subscriber = publisher.duplicate();
    for (const client of [publisher, subscriber]) client.on('error', err => logger.error({err}, 'Realtime Redis error'));
    await Promise.all([publisher.connect(), subscriber.connect()]);
    await subscriber.subscribe(channel, raw => {
      try {
        const event = JSON.parse(raw);
        if (event.origin !== origin) handlers.get(event.topic)?.(event.payload);
      } catch (err) { logger.error({err}, 'Invalid realtime event'); }
    });
  })();
  return initializing;
}
export function publishRealtimeEvent(topic, payload) {
  // Local delivery remains immediate; persisted notifications remain the recovery source.
  void startRealtimeBus().then(() => publisher?.publish(channel, JSON.stringify({origin, topic, payload})))
    .catch(err => logger.error({err, topic}, 'Realtime publish failed'));
}
