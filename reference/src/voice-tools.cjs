'use strict';
// Server side of a Retell voice agent: the inbound-call webhook, the
// call-ended webhook, and four custom tools.
//
// The agent follows "Protocol B: Secure Finalization" from the playbook. It can
// search availability and send a secure link, but it cannot confirm a booking:
// every tool response carries `appointment_confirmed: false`, and the booking
// exists only after the customer completes checkout on the linked page.
//
// What the code enforces, so the prompt does not have to:
//   - every request is signed, recent, and bound to this business number and agent
//   - a link can only be sent for a slot this same call was offered
//   - each link is sent once; at most one explicit resend, to the same contact
//   - a send with an unknown outcome is never retried and never reported as sent
//   - the owner gets one lead-intent notification per call, however many events arrive
//
// Each thrown error carries a `code` for logs and a `message` written for the
// agent to act on (the "customer-safe error wording" from the playbook).
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyRetellSignature } = require('./signatures.cjs');
const { normalizePhone, isDeliverableEmail } = require('./contact.cjs');
const { isOpen } = require('./business-hours.cjs');

const TOOL_ROUTES = {
  '/voice/tools/slots': 'get_available_slots',
  '/voice/tools/finalization-link': 'send_booking_finalization_link',
  '/voice/tools/manage-link': 'send_existing_booking_manage_link',
  '/voice/tools/request': 'submit_follow_up_request',
};
const INBOUND_ROUTE = '/webhooks/voice/inbound';
const EVENTS_ROUTE = '/webhooks/voice';

const MINUTE = 60 * 1000;
const OFFER_TTL = 30 * MINUTE;
const CUSTOMER_TURN = /^(user|caller|customer):\s*\S/im;
const PLACEHOLDER_NAME = /^(caller|customer|guest|test|search|email)$/i;

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const toolError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

/**
 * @param {object} deps
 * @param {object} deps.config  enabled, signingKey, agentId, agentName, businessName, businessPhone,
 *                              timeZone, hours, dataDir, ownerNotifyTo[], minNoticeMinutes, unavailableServices[]
 * @param {object} deps.catalog resolveService({ serviceId, service, duration }) -> { serviceId, duration } | null
 * @param {Function} deps.findSlots       ({ serviceId, duration, window }) -> { slots, nextAvailableSlots }
 * @param {Function} deps.prepareBooking  creates a draft and returns { intent_id, text, subject } with the secure link
 * @param {Function} deps.prepareManage   returns { text, subject } for an upcoming booking of that contact, or null
 * @param {Function} deps.sendEmail       ({ to, subject, text, category }) -> { id }
 * @param {Function} deps.sendSms         ({ to, text }) -> { id, status }
 * @param {Function} deps.isOptedOut      (phone) -> boolean
 */
function createVoiceTools({ config, catalog, findSlots, prepareBooking, prepareManage, sendEmail, sendSms, isOptedOut, now = Date.now }) {
  const stateDir = path.join(config.dataDir, 'voice_agent');
  const minNotice = (config.minNoticeMinutes ?? 60) * MINUTE;
  const unavailable = new Set(config.unavailableServices || []);
  const locks = new Map();

  // --- per-call state -------------------------------------------------------
  // One small JSON file per call and purpose, named by a hash of the call id.

  const stateFile = (callId, kind) => path.join(stateDir, `${hash(callId)}.${kind}.json`);

  async function readState(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function saveState(file, data) {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}`;
    await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(temp, file);
  }

  /** Requests for the same call run one at a time; different calls run in parallel. */
  async function serial(callId, work) {
    const previous = locks.get(callId) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    locks.set(callId, current);
    try {
      return await current;
    } finally {
      if (locks.get(callId) === current) locks.delete(callId);
    }
  }

  // --- validation -----------------------------------------------------------

  /** A valid signature only proves the provider account. This binds the call to this tenant. */
  function validateCall(call, { inbound = false } = {}) {
    const wrongAgent = inbound ? Boolean(call?.agent_id) && call.agent_id !== config.agentId : call?.agent_id !== config.agentId;
    if (!call || call.to_number !== config.businessPhone || call.direction === 'outbound' || wrongAgent) {
      throw toolError('wrong_call', 'This call does not belong to this business.', 403);
    }
    if (!inbound && (!/^call_[\w-]{1,200}$/.test(call.call_id || '') || !normalizePhone(call.from_number))) {
      throw toolError('invalid_call', 'A verified phone call is required.', 403);
    }
  }

  function selectService(args) {
    const selected = catalog.resolveService({ serviceId: args.service_id, service: args.service, duration: args.duration });
    if (!selected || unavailable.has(selected.serviceId)) {
      throw toolError('service_unavailable', 'This service is not currently offered. Offer an available service instead.');
    }
    if (args.duration && String(args.duration) !== String(selected.duration)) {
      throw toolError('duration_unavailable', 'Choose a supported duration for this service.');
    }
    return selected;
  }

  function deliveryTarget(args, call) {
    const channel = args.delivery_preference;
    if (!['sms', 'email'].includes(channel)) throw toolError('delivery_required', 'Confirm SMS or email delivery.');
    if (channel === 'sms' && args.sms_consent !== true) throw toolError('sms_consent_required', 'Ask permission to text this link first.');
    const recipient = channel === 'sms' ? normalizePhone(args.contact_phone || call.from_number) : clean(args.contact_email).toLowerCase();
    if (!recipient || (channel === 'email' && !isDeliverableEmail(recipient))) {
      throw toolError('contact_required', 'Confirm a valid delivery contact first.');
    }
    return { channel, recipient };
  }

  // --- secure link delivery -------------------------------------------------

  async function deliver({ channel, recipient, text, subject }) {
    if (channel === 'email') {
      const result = await sendEmail({ to: [recipient], subject, text, category: 'voice-secure-link' });
      if (!result?.id) throw toolError('delivery_unknown', 'Email delivery could not be verified.', 502);
      return;
    }
    if (await isOptedOut(recipient)) throw toolError('sms_opted_out', 'This number opted out of texts. Offer email or the website.');
    const result = await sendSms({ to: recipient, text: `${text} Reply STOP to opt out, HELP for help.` });
    if (!result?.id || ['failed', 'undelivered', 'canceled'].includes(result.status)) {
      throw toolError('delivery_unknown', 'Text delivery could not be verified. Do not promise delivery or retry automatically.', 502);
    }
  }

  async function prepareFinalization(args, call, target, otherChannel) {
    const selected = selectService(args);

    // The slot must be one this call was offered, for this service, recently.
    // The agent cannot book a time it misheard or made up.
    const offer = await readState(stateFile(call.call_id, 'offers'));
    const slot = offer?.slots?.find(
      (candidate) => candidate.slot_id === args.slot_id && (!args.startAt || Date.parse(candidate.start_at) === Date.parse(args.startAt)),
    );
    const offerValid = offer && now() - offer.at <= OFFER_TTL && offer.serviceId === selected.serviceId && offer.duration === selected.duration;
    if (!offerValid || !slot) throw toolError('slot_not_offered', 'Search again and select an exact returned slot.');
    if (Date.parse(slot.start_at) < now() + minNotice) {
      throw toolError('too_soon', 'This time is inside the minimum booking notice. Offer a later appointment.');
    }

    const contact = {
      name: clean(args.contact_name),
      phone: normalizePhone(args.contact_phone),
      email: target.channel === 'email' ? target.recipient : '',
    };
    if (contact.name.length < 2 || PLACEHOLDER_NAME.test(contact.name) || !contact.phone) {
      throw toolError('contact_required', 'Confirm the client name and phone.');
    }

    // The same draft may go out on a second channel, but not a different booking.
    const changed =
      otherChannel &&
      (otherChannel.serviceId !== selected.serviceId ||
        otherChannel.duration !== selected.duration ||
        otherChannel.slot_id !== slot.slot_id ||
        otherChannel.contact_phone !== contact.phone);
    if (changed) {
      throw toolError('booking_changed', 'The booking details changed. Use the existing secure page or offer a team follow-up request.', 409);
    }

    const draft = otherChannel
      ? { intent_id: otherChannel.intent_id, text: otherChannel.text, subject: otherChannel.subject }
      : await prepareBooking({ ...selected, slot, contact, callId: call.call_id, channel: target.channel });
    return { ...draft, ...selected, slot_id: slot.slot_id, contact_phone: contact.phone };
  }

  async function sendLink(kind, args, call) {
    const target = deliveryTarget(args, call);
    if (target.channel === 'sms' && (await isOptedOut(target.recipient))) {
      throw toolError('sms_opted_out', 'This number opted out of texts. Offer email or the website.');
    }

    const file = stateFile(call.call_id, `${kind}.${target.channel}`);
    const otherChannel = await readState(stateFile(call.call_id, `${kind}.${target.channel === 'sms' ? 'email' : 'sms'}`));
    if (otherChannel && otherChannel.state !== 'accepted') {
      throw toolError('delivery_unknown', 'The previous delivery needs review. Offer the website or a team follow-up request.', 409);
    }

    let operation = await readState(file);
    if (operation) {
      if (operation.recipient !== target.recipient) {
        throw toolError('link_already_prepared', 'A link was already prepared for this call. Do not send another or change the recipient.', 409);
      }
      if (operation.state !== 'accepted') {
        throw toolError('delivery_unknown', 'The earlier delivery needs review. Do not retry or promise delivery. Offer the website or a team follow-up request.', 409);
      }
      // A repeated tool call is answered from the record. Only an explicit
      // request permits one resend of the same link to the same contact.
      if (!args.resend || operation.resends >= 1) return { ...operation.result, duplicate: true };
      operation.resends = 1;
    } else {
      if (args.resend) throw toolError('no_original_delivery', 'Send the original link first.');
      const prepared =
        kind === 'finalization'
          ? await prepareFinalization(args, call, target, otherChannel)
          : await prepareManage({ channel: target.channel, recipient: target.recipient, action: args.action });
      if (!prepared) {
        return {
          ok: false,
          code: 'no_upcoming_booking',
          agent_reply: 'I could not find an upcoming online appointment for that contact. The team can help with appointments booked elsewhere.',
        };
      }
      operation = { ...target, state: 'prepared', resends: 0, created_at: new Date(now()).toISOString(), ...prepared };
    }

    // Persist before the provider call. If the process dies mid-send, the record
    // says `sending`, which is treated as unknown and is never sent again.
    operation.state = 'sending';
    await saveState(file, operation);
    try {
      await deliver(operation);
    } catch (error) {
      operation.state = 'unknown';
      await saveState(file, operation);
      throw error;
    }
    operation.state = 'accepted';
    operation.result = {
      ok: true,
      sent: true,
      delivery_status: 'accepted',
      delivery_channel: target.channel,
      appointment_confirmed: false,
      agent_reply:
        kind === 'finalization'
          ? 'The secure link was submitted for delivery. Ask whether it arrived. The appointment is not confirmed until the booking page is completed.'
          : 'The secure management link was submitted for delivery. The customer must open it to make changes.',
    };
    await saveState(file, operation);
    return operation.result;
  }

  // --- owner handoff --------------------------------------------------------

  const LEAD_ACCEPTED = 'Your request was sent to the team, and someone will reach out to you. This is not an appointment confirmation.';

  /**
   * Lead-intent notification: "someone tried to book or needs attention".
   * Booking-confirmed notifications are a separate path, triggered by the
   * booking provider, and are never sent from here.
   */
  async function notifyLead(call, args) {
    const file = stateFile(call.call_id, 'lead');
    const previous = await readState(file);
    if (previous) {
      const accepted = previous.state === 'accepted';
      return {
        ok: accepted,
        duplicate: true,
        notification_type: 'lead_intent',
        agent_reply: accepted ? LEAD_ACCEPTED : 'Delivery needs review. Do not promise a callback.',
      };
    }
    if (!config.ownerNotifyTo?.length) throw toolError('owner_unavailable', 'Owner notification is unavailable.', 503);

    const turns = String(call.transcript || '').split(/\r?\n/).filter(Boolean);
    const customerTurns = turns.filter((turn) => /^(user|caller|customer):/i.test(turn));
    const latestReply = turns.filter((turn) => /^(agent|assistant|ai):/i.test(turn)).at(-1) || 'Not available';
    const link =
      (await readState(stateFile(call.call_id, 'finalization.sms'))) || (await readState(stateFile(call.call_id, 'finalization.email')));

    const text = [
      'LEAD INTENT / PHONE INQUIRY — not a booking confirmation.',
      `Caller: ${args?.phone || call.from_number}`,
      `Name: ${args?.name || 'Not provided'}`,
      `Service: ${args?.service || args?.service_id || 'See customer request'}`,
      `Duration: ${args?.duration || 'Not selected'}`,
      `Requested time: ${args?.preferred_time || 'See customer request'}`,
      `Automation: ${link ? `secure booking link ${link.state}; customer must complete checkout` : 'no booking link issued'}`,
      `Customer request: ${(args?.message || customerTurns.join('\n')).slice(0, 5000)}`,
      `Latest assistant reply: ${latestReply.slice(0, 1500)}`,
      `Call ID: ${call.call_id}`,
      'Check the booking system before confirming an appointment. Booking confirmations are sent separately.',
    ].join('\n\n');

    await saveState(file, { state: 'sending', at: new Date(now()).toISOString() });
    try {
      const result = await sendEmail({
        to: config.ownerNotifyTo,
        subject: `${config.businessName}: phone inquiry — follow-up may be needed`,
        text,
        category: 'voice-lead-intent',
      });
      if (!result?.id) throw new Error('No email acknowledgement');
    } catch {
      await saveState(file, { state: 'unknown', at: new Date(now()).toISOString() });
      // The agent must not tell the caller that someone will call back.
      throw toolError('owner_delivery_unknown', 'Owner delivery needs review. Do not promise a callback.', 502);
    }
    await saveState(file, { state: 'accepted', at: new Date(now()).toISOString() });
    return { ok: true, notification_type: 'lead_intent', agent_reply: LEAD_ACCEPTED };
  }

  // --- tools ----------------------------------------------------------------

  async function searchSlots(args, call) {
    const selected = selectService(args);
    const earliest = now() + minNotice;
    const requestedStart = args.startAt ? Date.parse(args.startAt) : earliest;
    const requestedEnd = args.endAt ? Date.parse(args.endAt) : null;
    if (!Number.isFinite(requestedStart) || (args.endAt && (!Number.isFinite(requestedEnd) || requestedEnd <= requestedStart))) {
      throw toolError('invalid_window', 'Confirm a valid future date and time.');
    }
    const window = {
      startAt: new Date(Math.max(requestedStart, earliest)).toISOString(),
      endAt: args.endAt || null,
      strict: Boolean(args.startAt), // the caller named a time; do not silently widen it
    };
    const result = await findSlots({ ...selected, window, source: 'voice_agent' });
    const slots = result.slots || [];
    const nextAvailable = result.nextAvailableSlots || [];

    // Remember exactly what was offered. Only these slots can be finalized on this call.
    await saveState(stateFile(call.call_id, 'offers'), { ...selected, at: now(), slots: [...slots, ...nextAvailable] });
    return { ok: true, slots, next_available_slots: nextAvailable, time_zone: config.timeZone, appointment_confirmed: false };
  }

  function inboundVariables(call) {
    const caller = normalizePhone(call.from_number);
    return {
      call_inbound: {
        dynamic_variables: {
          agent_name: config.agentName,
          business_name: config.businessName,
          phone_number: config.businessPhone,
          caller_number: caller,
          call_direction: 'inbound',
          // Decided here, on the server clock, so the prompt never guesses business hours.
          owner_transfer_available: String(isOpen(config.hours, config.timeZone, new Date(now()))),
        },
      },
    };
  }

  async function handle(pathname, payload) {
    if (pathname === INBOUND_ROUTE) {
      validateCall(payload.call_inbound, { inbound: true });
      return inboundVariables(payload.call_inbound);
    }

    const call = payload.call;
    validateCall(call);
    return serial(call.call_id, async () => {
      if (pathname === EVENTS_ROUTE) {
        // Hang-ups and silent calls do not page the owner.
        if (payload.event !== 'call_ended' || !CUSTOMER_TURN.test(call.transcript || '')) return { ok: true, ignored: true };
        return notifyLead(call);
      }

      // Tool arguments arrive inside a signed envelope together with the call
      // object, so the call binding above cannot be skipped by a tool request.
      const args = payload.args;
      if (payload.name !== TOOL_ROUTES[pathname] || !args || typeof args !== 'object' || Array.isArray(args)) {
        throw toolError('invalid_tool', 'A signed tool envelope is required.');
      }

      if (pathname === '/voice/tools/slots') return searchSlots(args, call);
      if (pathname === '/voice/tools/request') {
        if (args.consent !== true || !normalizePhone(args.phone) || !clean(args.name) || !clean(args.message)) {
          throw toolError('request_consent_required', 'Confirm the request, contact details and permission to follow up.');
        }
        return notifyLead(call, args);
      }
      return sendLink(pathname.endsWith('/manage-link') ? 'manage' : 'finalization', args, call);
    });
  }

  return {
    enabled: Boolean(config.enabled),
    matches: (pathname) => Object.hasOwn(TOOL_ROUTES, pathname) || pathname === INBOUND_ROUTE || pathname === EVENTS_ROUTE,
    /** @param {string} rawBody the unparsed request body, exactly as received */
    async request(pathname, rawBody, signatureHeader) {
      if (!config.enabled) throw toolError('not_found', 'Not found', 404);
      if (!verifyRetellSignature(rawBody, signatureHeader, config.signingKey, { now: now() })) {
        throw toolError('invalid_signature', 'Invalid signature', 401);
      }
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        throw toolError('invalid_json', 'Invalid JSON');
      }
      if (!payload || typeof payload !== 'object') throw toolError('invalid_json', 'Invalid JSON');
      return handle(pathname, payload);
    },
  };
}

module.exports = { createVoiceTools, TOOL_ROUTES, INBOUND_ROUTE, EVENTS_ROUTE };
