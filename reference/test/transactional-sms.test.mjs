import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTransactionalSms } from '../src/transactional-sms.cjs';

const PHONE = '+12025550199';
const JOBS = 'transactional_sms_jobs.json';

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'transactional-sms-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = Date.parse('2030-01-01T12:00:00Z');
  const intent = {
    id: 'intent-1', state: 'confirmed', booking: { id: 'booking-1', start_at: '2030-01-04T12:00:00Z', version: 1 },
    customer: { phone: PHONE }, sms_consent: { phone: PHONE, transactional: true },
  };
  const calls = [];
  const fetchImpl = options.fetchImpl || (async (url, request) => {
    calls.push({ url, request });
    return new Response(JSON.stringify({ sid: 'SM123456', status: request.method === 'POST' ? 'queued' : 'delivered' }), { status: 200 });
  });
  const sms = createTransactionalSms({
    env: { BOOKING_SMS_ENABLED: '1', BOOKING_SMS_PROVIDER: 'twilio', BOOKING_DATA_DIR: dir, TWILIO_ACCOUNT_SID: 'ACfixture', TWILIO_AUTH_TOKEN: 'fixture', TWILIO_MESSAGING_SERVICE_SID: 'MGfixture' },
    getIntent: async () => intent,
    buildBody: () => 'Fixture appointment message. Reply STOP to opt out.',
    fetchImpl,
    now: () => clock,
  });
  return {
    dir, intent, calls, sms,
    setNow: (value) => { clock = Date.parse(value); },
    posts: () => calls.filter((c) => c.request.method === 'POST').length,
    jobs: async () => Object.values(JSON.parse(await readFile(path.join(dir, JOBS), 'utf8'))),
  };
}

test('concurrent and replayed confirmations send once, then record delivery without resending', async (t) => {
  const s = await setup(t);
  await Promise.all([s.sms.notify(s.intent, 'confirmation'), s.sms.notify(s.intent, 'confirmation')]);
  assert.equal(s.calls.length, 1);
  const { request } = s.calls[0];
  assert.equal(request.body.get('To'), PHONE);
  assert.equal(request.body.get('MessagingServiceSid'), 'MGfixture');
  assert.ok(request.signal, 'provider calls carry a timeout');
  assert.equal((await s.jobs())[0].status, 'accepted');
  await s.sms.runDue();
  assert.equal((await s.jobs())[0].status, 'delivered');
  assert.equal(s.posts(), 1);
});

test('missing, revoked or mismatched consent and changed phones never send', async (t) => {
  for (const consent of [null, { transactional: false, phone: PHONE }, { transactional: true, phone: '+12025550200' }]) {
    const s = await setup(t);
    s.intent.sms_consent = consent;
    await s.sms.notify(s.intent, 'confirmation');
    assert.equal(s.calls.length, 0);
  }
  const s = await setup(t);
  await s.sms.enqueue(s.intent, 'confirmation');
  s.intent.customer.phone = '+12025550200';
  await s.sms.runDue();
  assert.equal(s.calls.length, 0);
});

test('opt-outs block sending', async (t) => {
  const s = await setup(t);
  const hash = createHash('sha256').update(PHONE).digest('hex');
  await writeFile(path.join(s.dir, 'sms_optouts.json'), JSON.stringify({ [hash]: true }));
  await s.sms.notify(s.intent, 'confirmation');
  assert.equal(s.calls.length, 0);
  assert.equal((await s.jobs())[0].status, 'skipped');
});

test('the queue stores a hash of the phone number, not the number', async (t) => {
  const s = await setup(t);
  await s.sms.enqueue(s.intent, 'confirmation');
  assert.ok(!(await readFile(path.join(s.dir, JOBS), 'utf8')).includes(PHONE.slice(2)));
});

test('a reminder waits until 24 hours before the current booking', async (t) => {
  const s = await setup(t);
  await s.sms.enqueue(s.intent, 'reminder_24h');
  await s.sms.runDue();
  assert.equal(s.calls.length, 0);
  s.setNow('2030-01-03T12:00:01Z');
  await s.sms.runDue();
  assert.equal(s.posts(), 1);
});

test('cancelled or moved bookings cannot send an obsolete reminder', async (t) => {
  const changes = [(i) => { i.state = 'cancelled'; }, (i) => { i.booking.start_at = '2030-01-05T12:00:00Z'; }];
  for (const change of changes) {
    const s = await setup(t);
    await s.sms.enqueue(s.intent, 'reminder_24h');
    change(s.intent);
    s.setNow('2030-01-03T12:00:01Z');
    await s.sms.runDue();
    assert.equal(s.calls.length, 0);
  }
});

test('rescheduling back to the original time recreates a cancelled reminder', async (t) => {
  const s = await setup(t);
  await s.sms.enqueue(s.intent, 'reminder_24h');
  await s.sms.cancelReminders(s.intent);
  assert.equal((await s.sms.enqueue(s.intent, 'reminder_24h')).scheduled, 1);
  assert.equal((await s.jobs())[0].status, 'pending');
});

test('a provider opt-out fails closed; an ambiguous network outcome is not retried', async (t) => {
  const cases = [
    [async () => new Response(JSON.stringify({ code: 21610 }), { status: 400 }), 'opted_out'],
    [async () => { throw new Error('network timeout'); }, 'unknown'],
  ];
  for (const [fetchImpl, expected] of cases) {
    let count = 0;
    const s = await setup(t, { fetchImpl: async (...args) => { count++; return fetchImpl(...args); } });
    await s.sms.notify(s.intent, 'confirmation');
    await s.sms.notify(s.intent, 'confirmation');
    assert.equal(count, 1);
    assert.equal((await s.jobs())[0].status, expected);
  }
});

test('an interrupted send is recorded as unknown and never duplicated', async (t) => {
  const s = await setup(t);
  await s.sms.enqueue(s.intent, 'confirmation');
  const jobs = await s.jobs();
  jobs[0].status = 'sending'; // simulate a crash between "persist" and "provider replied"
  await writeFile(path.join(s.dir, JOBS), JSON.stringify(Object.fromEntries(jobs.map((j) => [j.id, j]))));
  await s.sms.runDue();
  assert.equal(s.calls.length, 0);
  assert.equal((await s.jobs())[0].status, 'unknown');
});
