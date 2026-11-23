'use strict';
// Whether a human can take a warm transfer right now. Computed on the server
// for every inbound call and passed to the agent as a dynamic variable, so the
// prompt never has to reason about weekdays or time zones.

/**
 * @param {Record<string, [number, number]>} hours minutes from local midnight, keyed by
 *   short weekday, e.g. { Mon: [540, 1260] }. A missing day means closed.
 * @param {string} timeZone IANA zone of the business, not of the server.
 */
function isOpen(hours, timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const range = hours[parts.weekday];
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return Boolean(range && minutes >= range[0] && minutes < range[1]);
}

module.exports = { isOpen };
