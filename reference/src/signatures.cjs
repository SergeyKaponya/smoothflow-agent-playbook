'use strict';
// Webhook authentication for the two providers that can reach the agent runtime.
// Both checks run on the raw request body, before any JSON or form parsing.
const { createHmac, timingSafeEqual } = require('node:crypto');

const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * Retell signs `rawBody + timestamp` and sends `v=<timestamp>,d=<hex digest>`.
 * A valid digest with an old timestamp is a replay and is rejected.
 */
function verifyRetellSignature(rawBody, header, apiKey, { now = Date.now(), toleranceMs = FIVE_MINUTES } = {}) {
  const match = /^v=(\d+),d=([a-f0-9]{64})$/i.exec(String(header || ''));
  if (!apiKey || !match) return false;
  if (Math.abs(now - Number(match[1])) > toleranceMs) return false;
  const expected = createHmac('sha256', apiKey).update(rawBody).update(match[1]).digest();
  return timingSafeEqual(expected, Buffer.from(match[2], 'hex'));
}

/**
 * Twilio signs the exact public URL followed by the form fields sorted by key.
 * `url` must be the configured webhook URL, not one rebuilt from proxy headers.
 */
function verifyTwilioSignature({ url, params, signature, authToken }) {
  if (!url || !authToken || !signature) return false;
  const data = url + Object.keys(params).sort().map((key) => key + params[key]).join('');
  const expected = Buffer.from(createHmac('sha1', authToken).update(data).digest('base64'));
  const actual = Buffer.from(String(signature));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

module.exports = { verifyRetellSignature, verifyTwilioSignature };
