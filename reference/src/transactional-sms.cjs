'use strict';
// Appointment SMS (confirmation, reschedule, cancellation, 24-hour reminder).
//
// Three rules shape this module:
//   1. Consent is re-checked at send time, not only when the job was queued.
//   2. Job ids are derived from the booking, so replays and races collapse into one job.
//   3. A send whose outcome is not known is parked as `unknown` and never retried
//      automatically. A duplicate text to a customer is worse than a missing one.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizePhone } = require('./contact.cjs');

const KINDS = ['confirmation', 'rescheduled', 'cancellation', 'reminder_24h'];
const DAY = 24 * 60 * 60 * 1000;
const TWILIO_OPTED_OUT = 21610;

const sha = (value) => createHash('sha256').update(value).digest('hex');

/** The customer's phone, but only if transactional consent was given for that same number. */
function consentPhone(intent) {
  const phone = normalizePhone(intent?.customer?.phone);
  const consent = intent?.sms_consent;
  return phone && consent?.transactional === true && normalizePhone(consent.phone) === phone ? phone : '';
}

function createTransactionalSms({ env = process.env, getIntent, buildBody, fetchImpl = fetch, now = Date.now }) {
  const enabled = env.BOOKING_SMS_ENABLED === '1';
  const mock = env.BOOKING_SMS_PROVIDER === 'mock';
  // A mock SMS provider next to a live booking provider would silently drop real messages.
  if (enabled && mock && env.BOOKING_PROVIDER_MODE !== 'mock') throw new Error('Mock SMS requires a mock booking provider');

  const jobsFile = path.join(env.BOOKING_DATA_DIR, 'transactional_sms_jobs.json');
  const optOutFile = path.join(env.BOOKING_DATA_DIR, 'sms_optouts.json');
  const account = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const service = env.TWILIO_MESSAGING_SERVICE_SID;

  // One in-process queue: every read-modify-write of the job file runs in order.
  let lock = Promise.resolve();
  const serial = (work) => {
    const pending = lock.then(work);
    lock = pending.catch(() => {});
    return pending;
  };
  const iso = () => new Date(now()).toISOString();

  async function read(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function write(jobs) {
    await fs.mkdir(path.dirname(jobsFile), { recursive: true, mode: 0o700 });
    const temp = `${jobsFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(jobs, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, jobsFile);
  }

  const startAt = (intent) => intent?.booking?.start_at || intent?.slot?.start_at || '';

  async function enqueue(intent, kind) {
    if (!enabled) return { scheduled: 0, skipped: 'disabled' };
    if (!KINDS.includes(kind)) throw new Error('Unknown SMS kind');
    if (!intent?.booking?.id || !consentPhone(intent)) return { scheduled: 0, skipped: 'consent_or_booking_missing' };
    const expectedState = kind === 'cancellation' ? 'cancelled' : 'confirmed';
    if (intent.state !== expectedState) return { scheduled: 0, skipped: 'booking_state' };

    const start = startAt(intent);
    const due = kind === 'reminder_24h' ? Date.parse(start) - DAY : now();
    if (!Number.isFinite(due) || (kind === 'reminder_24h' && due <= now() + 5 * 60 * 1000)) {
      return { scheduled: 0, skipped: 'no_future_reminder' };
    }

    // The revision makes a second reschedule a new job while a replay of the same one is not.
    const revision = kind === 'rescheduled' ? `${start}|${intent.booking.version || ''}` : kind === 'reminder_24h' ? start : '';
    const id = `sms_${sha([intent.id, intent.booking.id, revision, kind].join('|')).slice(0, 32)}`;

    return serial(async () => {
      const jobs = await read(jobsFile);
      const reusableReminder = kind === 'reminder_24h' && jobs[id]?.status === 'cancelled';
      if (jobs[id] && !reusableReminder) return { scheduled: 0, id, duplicate: true };
      jobs[id] = {
        id,
        kind,
        intent_id: intent.id,
        booking_id: intent.booking.id,
        start_at: start,
        phone_hash: sha(consentPhone(intent)), // the number itself is never stored in the queue
        status: 'pending',
        due_at: new Date(due).toISOString(),
        created_at: iso(),
      };
      await write(jobs);
      return { scheduled: 1, id };
    });
  }

  async function cancelReminders(intent) {
    if (!enabled) return { cancelled: 0 };
    return serial(async () => {
      const jobs = await read(jobsFile);
      let count = 0;
      for (const job of Object.values(jobs)) {
        if (job.intent_id === intent?.id && job.kind === 'reminder_24h' && job.status === 'pending') {
          job.status = 'cancelled';
          job.updated_at = iso();
          count++;
        }
      }
      if (count) await write(jobs);
      return { cancelled: count };
    });
  }

  const headers = () => ({
    Authorization: `Basic ${Buffer.from(`${account}:${token}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  async function send(to, body, id) {
    if (mock) return { sid: `SMmock${sha(id).slice(0, 24)}`, status: 'delivered' };
    if (!account || !token || !service) throw new Error('Twilio configuration missing');
    const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}/Messages.json`, {
      method: 'POST',
      headers: headers(),
      signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ To: to, MessagingServiceSid: service, Body: body }),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(`Twilio HTTP ${response.status}`);
      error.providerCode = result.code || null;
      // A 4xx is a definite rejection. A 5xx may still have been accepted upstream.
      error.definiteFailure = response.status < 500;
      throw error;
    }
    if (!/^SM[a-zA-Z0-9]+$/.test(result.sid || '')) throw new Error('Twilio response missing message SID');
    return result;
  }

  function stillAllowed(job, intent, phone, optOuts) {
    const expectedState = job.kind === 'cancellation' ? 'cancelled' : 'confirmed';
    return Boolean(
      intent &&
        intent.state === expectedState &&
        intent.booking?.id === job.booking_id &&
        startAt(intent) === job.start_at &&
        phone &&
        sha(phone) === job.phone_hash &&
        !optOuts[sha(phone)] &&
        (job.kind === 'cancellation' || Date.parse(job.start_at) > now()),
    );
  }

  async function runDue({ limit = 10, onlyIntentId } = {}) {
    if (!enabled) return { processed: 0 };
    return serial(async () => {
      const jobs = await read(jobsFile);
      const optOuts = await read(optOutFile);
      let processed = 0;

      // The process may have stopped after the provider accepted the message.
      for (const job of Object.values(jobs)) {
        if (job.status === 'sending') {
          job.status = 'unknown';
          job.error = 'Interrupted send; requires reconciliation';
        }
      }

      const pending = Object.values(jobs)
        .filter((job) => job.status === 'pending' && Date.parse(job.due_at) <= now())
        .filter((job) => !onlyIntentId || job.intent_id === onlyIntentId)
        .sort((a, b) => a.due_at.localeCompare(b.due_at))
        .slice(0, limit);

      for (const job of pending) {
        // Re-read the booking: it may have moved, been cancelled, or lost consent since queueing.
        const intent = await getIntent(job.intent_id).catch(() => null);
        const phone = consentPhone(intent);
        if (!stillAllowed(job, intent, phone, optOuts)) {
          job.status = 'skipped';
          job.reason = 'booking_changed_or_sms_not_allowed';
          job.updated_at = iso();
          continue;
        }
        const body = buildBody(intent, job.kind);
        if (!body) {
          job.status = 'skipped';
          job.reason = 'empty_body';
          continue;
        }

        job.status = 'sending';
        job.attempted_at = iso();
        await write(jobs); // persisted before the provider call

        try {
          const result = await send(phone, body, job.id);
          job.message_sid = result.sid;
          job.provider_status = result.status;
          job.status = result.status === 'delivered' ? 'delivered' : 'accepted';
          job.accepted_at = iso();
        } catch (error) {
          job.status = error.providerCode === TWILIO_OPTED_OUT ? 'opted_out' : error.definiteFailure ? 'failed' : 'unknown';
          job.provider_error_code = error.providerCode || null;
          job.error = error.message;
          console.error(`[transactional-sms] ${job.kind} ${job.status} job=${job.id} code=${job.provider_error_code || 'unknown'}`);
        }
        job.updated_at = iso();
        processed++;
        await write(jobs);
      }

      // Delivery receipts: polling a status is safe to repeat, sending is not.
      if (!mock && !onlyIntentId) {
        const accepted = Object.values(jobs)
          .filter((job) => job.status === 'accepted' && job.message_sid)
          .filter((job) => !job.last_status_check || now() - Date.parse(job.last_status_check) > 60000)
          .slice(0, limit);
        for (const job of accepted) {
          try {
            const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}/Messages/${encodeURIComponent(job.message_sid)}.json`;
            const response = await fetchImpl(url, { headers: headers(), signal: AbortSignal.timeout(10000) });
            if (response.ok) {
              const result = await response.json();
              job.provider_status = result.status;
              job.provider_error_code = result.error_code || null;
              if (result.status === 'delivered') job.status = 'delivered';
              if (['failed', 'undelivered'].includes(result.status)) job.status = 'failed';
            }
          } catch {
            // Checked again on the next tick.
          }
          job.last_status_check = iso();
        }
      }

      if (Object.keys(jobs).length) await write(jobs);
      return { processed };
    });
  }

  async function notify(intent, kind) {
    await enqueue(intent, kind);
    await runDue({ onlyIntentId: intent.id });
    return intent;
  }

  function start() {
    if (!enabled) return;
    const tick = () => runDue().catch((error) => console.error('[transactional-sms] worker:', error.message));
    setInterval(tick, 60000).unref();
    void tick();
  }

  return { enabled, enqueue, notify, cancelReminders, runDue, start };
}

module.exports = { createTransactionalSms, consentPhone };
