import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVoiceTools } from '../src/voice-tools.cjs';

// All identifiers are fixtures. Phone numbers are in the reserved 555-01xx range.
const KEY = 'fixture-signing-key';
const BUSINESS = '+12025550100';
const CALLER = '+12025550199';
const NOW = Date.parse('2030-01-07T15:00:00Z'); // a Monday, 10:00 in New York
const SLOT = { slot_id: 'slot-1', start_at: '2030-01-08T15:00:00Z' };
const call = { call_id: 'call_fixture', agent_id: 'agent_fixture', from_number: CALLER, to_number: BUSINESS, direction: 'inbound' };

async function setup(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'voice-tools-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sent = { sms: [], email: [], drafts: 0 };
  const optedOut = new Set();
  const tools = createVoiceTools({
    now: () => NOW,
    config: {
      enabled: true, signingKey: KEY, agentId: 'agent_fixture', agentName: 'Riley', businessName: 'Example Studio',
      businessPhone: BUSINESS, timeZone: 'America/New_York', hours: { Mon: [540, 1260] }, dataDir,
      ownerNotifyTo: ['owner@studio.invalid'], unavailableServices: ['retired-service'],
    },
    catalog: { resolveService: ({ serviceId, duration }) => (serviceId ? { serviceId, duration: String(duration || '60') } : null) },
    findSlots: async () => ({ slots: [SLOT], nextAvailableSlots: [] }),
    prepareBooking: async () => { sent.drafts++; return { intent_id: 'intent-1', text: 'Finish booking: https://studio.invalid/b/abc', subject: 'Finish your booking' }; },
    prepareManage: async () => null,
    sendEmail: async (message) => { sent.email.push(message); return { id: 'email-1' }; },
    sendSms: async (message) => { sent.sms.push(message); return { id: 'SMfixture', status: 'queued' }; },
    isOptedOut: async (phone) => optedOut.has(phone),
    ...overrides,
  });
  const post = (pathname, payload, { stamp = NOW, key = KEY } = {}) => {
    const raw = JSON.stringify(payload);
    return tools.request(pathname, raw, `v=${stamp},d=${createHmac('sha256', key).update(raw).update(String(stamp)).digest('hex')}`);
  };
  const tool = (route, name, args, options) => post(`/voice/tools/${route}`, { name, args, call }, options);
  const search = () => tool('slots', 'get_available_slots', { service_id: 'standard' });
  const link = (args = {}) => tool('finalization-link', 'send_booking_finalization_link', {
    service_id: 'standard', slot_id: 'slot-1', contact_name: 'Jordan Lee', contact_phone: CALLER,
    delivery_preference: 'sms', sms_consent: true, ...args,
  });
  return { tools, sent, optedOut, post, tool, search, link };
}
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('unsigned, stale and wrong-key requests are rejected before any work', async (t) => {
  const s = await setup(t);
  await rejects(s.tools.request('/voice/tools/slots', '{}', ''), 'invalid_signature');
  await rejects(s.tool('slots', 'get_available_slots', { service_id: 'standard' }, { stamp: NOW - 10 * 60000 }), 'invalid_signature');
  await rejects(s.tool('slots', 'get_available_slots', { service_id: 'standard' }, { key: 'another-key' }), 'invalid_signature');
});

test('a signed request for another number, agent or tool is rejected', async (t) => {
  const s = await setup(t);
  const args = { service_id: 'standard' };
  await rejects(s.post('/voice/tools/slots', { name: 'get_available_slots', args, call: { ...call, to_number: '+12025550111' } }), 'wrong_call');
  await rejects(s.post('/voice/tools/slots', { name: 'get_available_slots', args, call: { ...call, agent_id: 'agent_other' } }), 'wrong_call');
  await rejects(s.post('/voice/tools/slots', { name: 'send_booking_finalization_link', args, call }), 'invalid_tool');
});

test('a link is sent once for an offered slot and never claims a confirmed appointment', async (t) => {
  const s = await setup(t);
  assert.equal((await s.search()).appointment_confirmed, false);
  const first = await s.link();
  assert.deepEqual([first.sent, first.appointment_confirmed, first.delivery_channel], [true, false, 'sms']);
  assert.equal(s.sent.sms[0].to, CALLER);

  const replay = await s.link();
  assert.equal(replay.duplicate, true);
  assert.equal(s.sent.sms.length, 1);
  assert.equal(s.sent.drafts, 1);
});

test('one explicit resend is allowed, to the same contact only', async (t) => {
  const s = await setup(t);
  await s.search();
  await s.link();
  await rejects(s.link({ contact_phone: '+12025550155' }), 'link_already_prepared');
  await s.link({ resend: true });
  await s.link({ resend: true });
  assert.equal(s.sent.sms.length, 2);
});

test('a slot that was not offered on this call cannot be booked', async (t) => {
  const s = await setup(t);
  await rejects(s.link(), 'slot_not_offered');
  await s.search();
  await rejects(s.link({ slot_id: 'slot-invented' }), 'slot_not_offered');
  await rejects(s.link({ service_id: 'deluxe' }), 'slot_not_offered');
  assert.equal(s.sent.drafts, 0);
});

test('texts need consent, a real contact and no opt-out', async (t) => {
  const s = await setup(t);
  await s.search();
  await rejects(s.link({ sms_consent: false }), 'sms_consent_required');
  await rejects(s.link({ delivery_preference: 'email', contact_email: 'caller@example.com' }), 'contact_required');
  await rejects(s.link({ contact_name: 'caller' }), 'contact_required');
  s.optedOut.add(CALLER);
  await rejects(s.link(), 'sms_opted_out');
  assert.equal(s.sent.sms.length, 0);
});

test('an unknown delivery outcome is not retried on any channel', async (t) => {
  let attempts = 0;
  const s = await setup(t, { sendSms: async () => { attempts++; throw new Error('network timeout'); } });
  await s.search();
  await assert.rejects(s.link());
  await rejects(s.link(), 'delivery_unknown');
  await rejects(s.link({ resend: true }), 'delivery_unknown');
  await rejects(s.link({ delivery_preference: 'email', contact_email: 'jordan@studio.invalid' }), 'delivery_unknown');
  assert.equal(attempts, 1);
  assert.equal(s.sent.email.length, 0);
});

test('retired services are refused by the tool, whatever the prompt says', async (t) => {
  const s = await setup(t);
  await rejects(s.tool('slots', 'get_available_slots', { service_id: 'retired-service' }), 'service_unavailable');
});

test('call_ended notifies the owner once, as a lead and not a confirmation', async (t) => {
  const s = await setup(t);
  const ended = { event: 'call_ended', call: { ...call, transcript: 'Agent: How can I help?\nUser: I would like a session on Friday.' } };
  const first = await s.post('/webhooks/voice', ended);
  const second = await s.post('/webhooks/voice', ended);
  assert.equal(first.notification_type, 'lead_intent');
  assert.equal(second.duplicate, true);
  assert.equal(s.sent.email.length, 1);
  assert.match(s.sent.email[0].text, /not a booking confirmation/);
  assert.match(s.sent.email[0].text, /no booking link issued/);
});

test('a call with no customer speech does not page the owner', async (t) => {
  const s = await setup(t);
  const result = await s.post('/webhooks/voice', { event: 'call_ended', call: { ...call, transcript: 'Agent: Hello?' } });
  assert.equal(result.ignored, true);
  assert.equal(s.sent.email.length, 0);
});

test('a failed owner notification tells the agent not to promise a callback', async (t) => {
  const s = await setup(t, { sendEmail: async () => { throw new Error('email provider down'); } });
  const request = () => s.tool('request', 'submit_follow_up_request', { consent: true, phone: CALLER, name: 'Jordan Lee', message: 'Please call me back.' });
  await rejects(request(), 'owner_delivery_unknown');
  const retry = await request();
  assert.equal(retry.ok, false);
  assert.match(retry.agent_reply, /Do not promise a callback/);
});

test('inbound calls get server-computed dynamic variables', async (t) => {
  const s = await setup(t);
  const { call_inbound } = await s.post('/webhooks/voice/inbound', { call_inbound: { from_number: CALLER, to_number: BUSINESS } });
  assert.deepEqual(call_inbound.dynamic_variables, {
    agent_name: 'Riley', business_name: 'Example Studio', phone_number: BUSINESS, caller_number: CALLER,
    call_direction: 'inbound', owner_transfer_available: 'true',
  });
});
