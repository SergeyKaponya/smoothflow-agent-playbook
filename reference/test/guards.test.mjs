import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyRetellSignature, verifyTwilioSignature } from '../src/signatures.cjs';
import { normalizePhone, isDeliverableEmail } from '../src/contact.cjs';
import { isOpen } from '../src/business-hours.cjs';
import { classifyBookingStatus, getOwnerLifecycleNotificationKey, isOwnerLifecycleNotificationType } from '../src/booking-lifecycle.cjs';
import { validateConfig } from '../src/validate-config.cjs';

test('Retell signatures bind the body to a recent timestamp', () => {
  const now = 1_900_000_000_000;
  const sign = (raw, stamp) => `v=${stamp},d=${createHmac('sha256', 'key').update(raw).update(String(stamp)).digest('hex')}`;
  assert.equal(verifyRetellSignature('{"a":1}', sign('{"a":1}', now), 'key', { now }), true);
  assert.equal(verifyRetellSignature('{"a":2}', sign('{"a":1}', now), 'key', { now }), false);
  assert.equal(verifyRetellSignature('{"a":1}', sign('{"a":1}', now - 301000), 'key', { now }), false);
  assert.equal(verifyRetellSignature('{"a":1}', sign('{"a":1}', now), '', { now }), false);
  assert.equal(verifyRetellSignature('{"a":1}', 'v=1,d=zz', 'key', { now }), false);
});

test('Twilio signatures cover the exact URL and every form field', () => {
  const url = 'https://studio.invalid/api/webhooks/twilio';
  const params = { From: '+12025550199', Body: 'Hi' };
  const signature = createHmac('sha1', 'token').update(`${url}BodyHiFrom+12025550199`).digest('base64');
  assert.equal(verifyTwilioSignature({ url, params, signature, authToken: 'token' }), true);
  assert.equal(verifyTwilioSignature({ url, params: { ...params, Body: 'Hi!' }, signature, authToken: 'token' }), false);
  assert.equal(verifyTwilioSignature({ url: `${url}?x=1`, params, signature, authToken: 'token' }), false);
  assert.equal(verifyTwilioSignature({ url, params, signature: '', authToken: 'token' }), false);
});

test('contact fields are normalized or rejected, never guessed', () => {
  assert.equal(normalizePhone('(202) 555-0199'), '+12025550199');
  assert.equal(normalizePhone('1-202-555-0199'), '+12025550199');
  assert.equal(normalizePhone('555-0199'), '');
  assert.equal(isDeliverableEmail('jordan@studio.invalid'), true);
  assert.equal(isDeliverableEmail('caller@example.com'), false);
  assert.equal(isDeliverableEmail('jordan at studio'), false);
});

test('business hours are evaluated in the business time zone', () => {
  const hours = { Mon: [540, 1260], Sat: [600, 1080] };
  assert.equal(isOpen(hours, 'America/New_York', new Date('2030-01-07T14:00:00Z')), true); // Mon 09:00
  assert.equal(isOpen(hours, 'America/New_York', new Date('2030-01-07T13:59:00Z')), false); // Mon 08:59
  assert.equal(isOpen(hours, 'America/New_York', new Date('2030-01-08T02:00:00Z')), false); // Mon 21:00
  assert.equal(isOpen(hours, 'America/New_York', new Date('2030-01-06T17:00:00Z')), false); // Sun, closed
});

test('provider booking statuses map to local state and owner notifications', () => {
  for (const status of ['ACCEPTED', 'PENDING', 'COMPLETED', ' accepted ']) {
    assert.deepEqual(classifyBookingStatus(status), { kind: 'confirmed', localBookingStatus: 'created', terminalIntentState: null, ownerNotificationType: null });
  }
  for (const status of ['CANCELLED_BY_CUSTOMER', 'CANCELED_BY_SELLER']) {
    assert.equal(classifyBookingStatus(status).ownerNotificationType, 'booking_cancelled');
  }
  assert.equal(classifyBookingStatus('NO_SHOW').terminalIntentState, 'no_show');
  assert.equal(classifyBookingStatus('DECLINED').terminalIntentState, 'declined');
});

test('unknown provider statuses fail closed and do not notify the owner', () => {
  assert.deepEqual(classifyBookingStatus('MYSTERY_STATUS'), { kind: 'failed', localBookingStatus: 'failed', terminalIntentState: null, ownerNotificationType: null });
  assert.equal(isOwnerLifecycleNotificationType('booking_confirmed'), false);
  assert.equal(getOwnerLifecycleNotificationKey('booking_rescheduled'), 'owner_booking_rescheduled');
});

const production = () => ({
  NODE_ENV: 'production', BOOKING_PROVIDER_MODE: 'live', BOOKING_PROVIDER_ACCESS_TOKEN: 'fixture-token',
  BOOKING_PROVIDER_WEBHOOK_SIGNATURE_KEY: 'fixture-key', BOOKING_PROVIDER_WEBHOOK_URL: 'https://studio.invalid/api/webhooks/booking',
  SITE_PUBLIC_URL: 'https://studio.invalid', EMAIL_API_KEY: 'fixture-email-key', OWNER_NOTIFY_TO: 'owner@studio.invalid',
  ADMIN_SHARED_KEY: 'a'.repeat(32), MANAGE_LINK_SECRET: 'b'.repeat(32), BOOKING_DATA_DIR: '/var/lib/agent', EVENTS_DIR: '/var/log/agent',
  BOOKING_PRICE_SOURCE: 'provider', BOOKING_PRICE_SOURCE_STRICT: '1', SERVICE_VARIATIONS_JSON: '{"standard":{"60":"variation-id"}}',
});

test('a complete production configuration passes', () => {
  assert.doesNotThrow(() => validateConfig(production()));
});

test('production refuses mocks, placeholders, shared secrets and plain HTTP', () => {
  const broken = [
    [{ BOOKING_PROVIDER_MODE: 'mock' }, /simulated bookings/],
    [{ EMAIL_API_KEY: 'mock' }, /mock email/],
    [{ BOOKING_PROVIDER_ACCESS_TOKEN: 'REPLACE_ME' }, /BOOKING_PROVIDER_ACCESS_TOKEN is required/],
    [{ MANAGE_LINK_SECRET: 'a'.repeat(32) }, /secrets must differ/],
    [{ SITE_PUBLIC_URL: 'http://studio.invalid' }, /must use HTTPS/],
    [{ BOOKING_DATA_DIR: 'data' }, /absolute persistent path/],
    [{ SERVICE_VARIATIONS_JSON: '{}' }, /service mappings are empty/],
    [{ BOOKING_VOICE_AGENT_ENABLED: '1' }, /voice requires authenticated Retell configuration/],
  ];
  for (const [change, message] of broken) assert.throws(() => validateConfig({ ...production(), ...change }), message);
});

test('development refuses live providers and real credentials', () => {
  assert.doesNotThrow(() => validateConfig({ BOOKING_PROVIDER_MODE: 'mock' }));
  assert.throws(() => validateConfig({ BOOKING_PROVIDER_MODE: 'live' }), /mock booking provider/);
  assert.throws(() => validateConfig({ BOOKING_PROVIDER_MODE: 'mock', TWILIO_AUTH_TOKEN: 'real' }), /must be empty/);
  assert.throws(() => validateConfig({ BOOKING_PROVIDER_MODE: 'mock', HOST: '0.0.0.0' }), /127\.0\.0\.1/);
});
