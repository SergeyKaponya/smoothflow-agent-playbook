'use strict';
// Runs once at boot, before the server binds a port. Any failure stops the
// process: a misconfigured agent that refuses to start is cheaper than one
// that takes real calls with a mock provider, or test calls with a live one.
const path = require('node:path');

const PLACEHOLDER = /REPLACE|YOUR_/i;

function validateConfig(env) {
  const fail = (reason) => {
    throw new Error(`Configuration invalid: ${reason}`);
  };

  if ((env.HOST || '127.0.0.1') !== '127.0.0.1') fail('HOST must be 127.0.0.1 behind the reverse proxy');

  // Feature flags must come with everything they depend on.
  if (env.BOOKING_SMS_AGENT_ENABLED === '1') {
    if (env.BOOKING_SMS_ENABLED !== '1') fail('SMS agent requires booking SMS');
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_INBOUND_WEBHOOK_URL) {
      fail('SMS agent requires authenticated Twilio webhook configuration');
    }
    if (env.NODE_ENV === 'production' && !env.TWILIO_INBOUND_WEBHOOK_URL.startsWith(`${env.SITE_PUBLIC_URL}/api/webhooks/twilio`)) {
      fail('SMS webhook must belong to this site');
    }
  }
  if (env.BOOKING_VOICE_AGENT_ENABLED === '1') {
    if (!env.RETELL_API_KEY || !env.RETELL_AGENT_ID || !env.VOICE_BUSINESS_PHONE) fail('voice requires authenticated Retell configuration');
    if (env.BOOKING_SMS_ENABLED !== '1') fail('voice link delivery requires booking SMS');
    if (env.NODE_ENV === 'production' && env.RETELL_API_KEY === 'mock') fail('voice signature key must be real in production');
  }

  // Outside production nothing may be able to reach a real provider.
  if (env.NODE_ENV !== 'production') {
    if (env.BOOKING_PROVIDER_MODE !== 'mock') fail('development must use the isolated mock booking provider');
    if (env.BOOKING_SMS_ENABLED === '1' && env.BOOKING_SMS_PROVIDER !== 'mock') fail('development SMS must use the mock provider');
    for (const key of ['BOOKING_PROVIDER_ACCESS_TOKEN', 'EMAIL_API_KEY', 'TWILIO_AUTH_TOKEN']) {
      if (env[key]) fail(`${key} must be empty in local mock mode`);
    }
    return;
  }

  // In production nothing may be simulated.
  if (env.BOOKING_PROVIDER_MODE !== 'live') fail('production must not expose simulated bookings');
  if (env.BOOKING_SMS_ENABLED === '1') {
    if (env.BOOKING_SMS_PROVIDER !== 'twilio') fail('production SMS must use Twilio');
    if (!/^AC[0-9a-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID || '')) fail('TWILIO_ACCOUNT_SID is required for SMS');
    if (!/^MG[0-9a-f]{32}$/i.test(env.TWILIO_MESSAGING_SERVICE_SID || '')) fail('TWILIO_MESSAGING_SERVICE_SID is required for SMS');
    if (!env.TWILIO_AUTH_TOKEN || env.TWILIO_AUTH_TOKEN === 'mock') fail('TWILIO_AUTH_TOKEN is required for SMS');
  }
  const required = [
    'BOOKING_PROVIDER_ACCESS_TOKEN',
    'BOOKING_PROVIDER_WEBHOOK_SIGNATURE_KEY',
    'BOOKING_PROVIDER_WEBHOOK_URL',
    'SITE_PUBLIC_URL',
    'EMAIL_API_KEY',
    'OWNER_NOTIFY_TO',
  ];
  for (const key of required) {
    if (!env[key] || PLACEHOLDER.test(env[key])) fail(`${key} is required`);
  }
  if (env.EMAIL_API_KEY === 'mock') fail('mock email is not allowed in production');

  // Secrets must be long, real, and not shared between purposes.
  for (const key of ['ADMIN_SHARED_KEY', 'MANAGE_LINK_SECRET']) {
    if (!env[key] || env[key].length < 32 || PLACEHOLDER.test(env[key])) fail(`${key} requires an independent random secret`);
  }
  if (env.ADMIN_SHARED_KEY === env.MANAGE_LINK_SECRET) fail('admin and manage-link secrets must differ');

  for (const key of ['BOOKING_DATA_DIR', 'EVENTS_DIR']) {
    if (!path.isAbsolute(env[key] || '')) fail(`${key} must be an absolute persistent path`);
  }
  // Prices quoted by the agent come from the booking provider, never from a local copy.
  if (env.BOOKING_PRICE_SOURCE !== 'provider' || env.BOOKING_PRICE_SOURCE_STRICT !== '1') fail('strict provider pricing is required');
  if (env.ALLOW_INSECURE_WEBHOOKS_IN_MOCK === '1') fail('insecure webhook bypass must be off');

  let mapping;
  try {
    mapping = JSON.parse(env.SERVICE_VARIATIONS_JSON || '{}');
  } catch {
    fail('SERVICE_VARIATIONS_JSON is not JSON');
  }
  if (!mapping || !Object.keys(mapping).length) fail('service mappings are empty');

  for (const key of ['SITE_PUBLIC_URL', 'BOOKING_PROVIDER_WEBHOOK_URL']) {
    let url;
    try {
      url = new URL(env[key]);
    } catch {
      fail(`${key} is not a URL`);
    }
    if (url.protocol !== 'https:') fail(`${key} must use HTTPS`);
  }
}

module.exports = { validateConfig };
