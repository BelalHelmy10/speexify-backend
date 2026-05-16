// src/services/notificationStreamHub.js
/** @type {Map<number, Set<import('http').ServerResponse>>} */
const subscribersByUser = new Map();

function getSet(userId) {
  let set = subscribersByUser.get(userId);
  if (!set) {
    set = new Set();
    subscribersByUser.set(userId, set);
  }
  return set;
}

export function subscribeNotificationStream(userId, res) {
  const set = getSet(userId);
  set.add(res);

  res.on("close", () => {
    set.delete(res);
    if (set.size === 0) subscribersByUser.delete(userId);
  });
}

export function publishNotificationEvent(userId, payload) {
  const set = subscribersByUser.get(userId);
  if (!set?.size) return;

  const data = JSON.stringify(payload);
  for (const res of set) {
    try {
      res.write(`event: notification\ndata: ${data}\n\n`);
    } catch {
      set.delete(res);
    }
  }
}
