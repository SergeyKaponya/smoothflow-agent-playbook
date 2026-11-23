# Reference Code

Modules and tests from the server side of a production voice and SMS booking
agent (Retell for voice, Twilio for SMS, Square for bookings), published to
show how the [playbook](../README.md) rules are enforced in code.

```sh
npm test
```

Node.js 20 or later. No dependencies.

## What this is

The code was extracted from one client deployment and then anonymized and
generalized. It is not a verbatim copy:

- Business names, people, phone numbers, prices, and schedules were removed.
  Tenant values now arrive through a `config` object.
- Provider calls that lived inline (catalog lookup, availability search, email
  and SMS delivery) are passed in as functions, so each module runs on its own.
- All identifiers in the tests are fixtures. Phone numbers use the reserved
  `555-01xx` range and domains use `.invalid`.

The control flow, state handling, and failure rules are the ones that run in
production.

## What is not here

The HTTP server, the booking and payment integration, the conversational SMS
agent, production prompts, and the provider configuration are private. This
directory is a sample, not a framework.

## Modules

| File | What it does |
| --- | --- |
| [`src/voice-tools.cjs`](src/voice-tools.cjs) | Inbound-call webhook, call-ended webhook, and four custom tools for a Retell agent. The agent can search availability and send a secure link; it cannot confirm a booking. |
| [`src/transactional-sms.cjs`](src/transactional-sms.cjs) | Appointment texts: confirmation, reschedule, cancellation, 24-hour reminder. Consent is re-checked at send time. |
| [`src/booking-lifecycle.cjs`](src/booking-lifecycle.cjs) | Maps booking-provider statuses to local state and to owner notifications. Unknown statuses fail closed. |
| [`src/validate-config.cjs`](src/validate-config.cjs) | Boot-time checks. The process does not start if test and live settings are mixed. |
| [`src/signatures.cjs`](src/signatures.cjs) | Retell and Twilio webhook signature checks. |
| [`src/contact.cjs`](src/contact.cjs), [`src/business-hours.cjs`](src/business-hours.cjs) | Phone and email validation; whether a human transfer is available now. |

## Design rules worth reading the code for

**The prompt is not the safety layer.** A voice model can mishear a time,
invent a slot, or call a tool twice. The tool layer assumes all three.
`send_booking_finalization_link` only accepts a slot that
`get_available_slots` returned earlier on the same call, for the same service,
within the last 30 minutes.

**Persist, then send.** Before any text or email leaves, the operation is
written to disk as `sending`. If the process stops mid-send, the record is
treated as `unknown`. Unknown is never retried automatically and is never
reported to the caller as sent, because a duplicate message to a customer is
worse than a missing one that a person follows up on.

**Errors are written for the agent.** Each tool error has a `code` for logs
and a `message` that tells the agent what to do next, for example "Owner
delivery needs review. Do not promise a callback."

**Two owner notifications, kept apart.** A lead-intent notification means
someone tried to book or needs attention. A booking-confirmed notification
means an appointment exists, and only the booking provider can trigger it. The
voice layer sends the first kind, once per call.

## License

The code in this directory is released under the [MIT License](LICENSE). The
playbook text is CC BY 4.0, as stated in the repository root.
