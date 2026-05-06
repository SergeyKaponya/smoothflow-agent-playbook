# SmoothFlow AI Agent Playbook

Sanitized operating guide for designing, shipping, reviewing, and maintaining
SmoothFlow AI agents.

This document intentionally does not contain production prompts, customer
secrets, provider credentials, phone numbers, account IDs, Retell agent IDs, or
client-private operating details. It describes the architecture, policy shape,
QA process, and release discipline that production agents should follow.

Related docs:

- `docs/architecture.md`
- `docs/ai-decision-matrix.md`
- `docs/runtime/client-playbooks.md`
- `docs/runtime/voice-managed-turn-contract.md`
- `docs/runtime/multichannel-smoke-matrix.md`

## 1. Purpose

SmoothFlow agents are front-desk and lead-conversion assistants for small
businesses. They must answer quickly, collect the right information, avoid
unsafe promises, route edge cases to the owner, and leave a useful audit trail.

The goal is not to make one universal agent. Each client should have a
versioned playbook that compiles into channel-specific runtime behavior.

Production behavior should be:

- tenant-scoped
- versioned
- observable
- reversible
- easy to test with realistic calls/messages
- safe when the model, STT, provider, or customer input is uncertain

## 2. Sanitization Rules

Do not commit or paste into this document:

- full production prompts
- real API keys, auth tokens, webhook secrets, or encryption keys
- Retell agent IDs, LLM IDs, call IDs, account SIDs, phone numbers, or bundle
  SIDs
- live customer transcripts with personally identifiable information
- client-private pricing exceptions, staff schedules, escalation names, or
  internal notes
- finalization URLs, payment URLs, or secure intake URLs

Allowed in this document:

- provider names
- non-secret file paths
- generic schemas
- pseudocode prompt sections
- anonymized transcripts
- placeholder IDs such as `<retell_agent_id>`
- public operational concepts such as A2P, Retell, Twilio, Yelp, Thumbtack, and
  Google Calendar

## 3. Runtime Surfaces

SmoothFlow currently has two AI surfaces.

### Text And Messaging Agent

Used for SMS, Yelp, and similar message channels.

Primary path:

- `server/src/runtime/workflows.ts`
- `server/src/runtime/ai.ts`
- `server/src/services/contactDetection.ts`
- `server/src/services/escalationDetector.ts`
- `server/src/runtime/categories.ts`
- `server/src/runtime/intake-schemas.ts`

The text agent is a decision engine. It builds context, applies hard rules,
optionally calls the model, validates the result, and sends or withholds the
reply according to policy.

### Voice Agent

Used for Retell-powered phone conversations.

Primary platform boundary:

- Retell owns live STT, TTS, interruption handling, barge-in, and turn timing.
- SmoothFlow owns dynamic variables, playbook/profile projection, webhooks,
  post-call processing, booking/intake state, owner notifications, and
  observability.

Relevant files:

- `server/src/adapters/retell.ts`
- `server/src/services/agentPrompt.v2.ts`
- `server/src/prompts/**`
- `server/src/runtime/voice/managedRetell.ts`
- `server/src/runtime/voiceBookingIntents.ts`
- `docs/runtime/voice-managed-turn-contract.md`

Some clients may also have isolated voice-agent source folders outside the main
SmoothFlow repo. Treat those as client-specific source of truth and keep
production prompts out of shared docs.

## 4. Source-Of-Truth Layers

Use separate layers so production can be changed deliberately.

| Layer | Source | Purpose |
| --- | --- | --- |
| Product contract | docs | Architecture, policies, release process |
| Client playbook | `client_playbooks` | Versioned tenant behavior |
| Runtime profile | `client_ai_runtime_profiles` | Compiled channel-ready settings |
| Provider config | Retell/Twilio/Yelp/etc. | What is live now |
| Runtime events | database logs | Audit and debugging |

Client-specific playbooks belong in tenant-scoped rows, not committed files.
Repo examples must stay sanitized.

## 5. Playbook Shape

A client playbook is the business contract for an agent. It should be structured
data first, prompt text second.

Core metadata:

```yaml
client_id: <tenant_id>
channel: voice | sms | email | web | multichannel
vertical_type: wellness | cpa | legal | it | home_services | custom
playbook_version: 1
status: draft | active | archived
base_template_key: <vertical_template_key>
intent_type: <intent_type>
state_machine_key: <state_machine_key>
```

Policy bundles:

```yaml
intake_schema: {}
service_catalog: []
booking_policy: {}
conversion_policy: {}
compliance_policy: {}
channel_policy: {}
handoff_policy: {}
spam_policy: {}
prompt_overrides: {}
test_scenarios: []
```

Prompt overrides must be short, policy-oriented, and reviewable. If a behavior
needs many instructions, prefer structured policy and compiler logic over
stuffing the production prompt.

## 6. Prompt Architecture

Production prompts should be generated from composable sections.

Recommended order:

1. Identity and role
2. Language policy
3. Conversation style and pacing
4. Safety and compliance rules
5. Business rules from the active playbook
6. Channel-specific behavior
7. Tool usage rules
8. Handoff rules
9. Confirmation and closing rules

Sanitized skeleton:

```text
You are the front desk assistant for {{business_name}}.

LANGUAGE POLICY:
Use only the languages enabled in {{supported_languages}}.
Default to {{default_language}} unless the caller clearly chooses another
enabled language.

BUSINESS RULES:
Use the active playbook. Do not invent services, prices, availability, policies,
or guarantees.

TOOLS:
Use tools only when their preconditions are met. Confirm sensitive contact
fields before calling booking, payment, or finalization tools.

HANDOFF:
If confidence is low, the request is unsafe, or the policy requires owner
review, collect safe contact details and route to owner follow-up.
```

Do not use this skeleton directly as a production prompt. It is a shape, not a
complete agent.

## 7. Language Policy

Language behavior must be tenant-configured.

Recommended fields:

```yaml
language_policy:
  default_language: en
  supported_languages: [en]
  allow_mid_call_switch: true
  require_clear_signal_for_switch: true
  fallback_on_language_mismatch: owner_callback
```

Rules:

- English is the default unless the tenant config says otherwise.
- The agent may use only configured languages.
- Do not switch language because of one weak word, a noisy yes/no, or an STT
  fragment.
- Once language is selected, stay in that language unless the customer clearly
  switches.
- If STT is uncertain, ask a short clarification in the current language.
- If the customer appears to struggle in English, offer only the enabled
  alternatives.
- Translate customer-facing service descriptions naturally, but keep internal
  service IDs canonical.
- Log detected language and language-switch events when available.

For multilingual voice agents, keep the base prompt compact and retrieve large
catalog or policy detail through tools. Long multilingual prompts increase
latency and make language switching less stable.

## 8. Tool Design Rules

Tools should be narrow, typed, idempotent where possible, and safe to call
after a partial conversation.

Every production tool should define:

- purpose
- required inputs
- preconditions
- whether the agent may speak during execution
- timeout
- success payload
- failure payload
- customer-safe error wording
- audit fields

Recommended voice settings:

- `speak_during_execution: false` for tools that may return customer-facing
  data
- short localized filler phrase before tool calls if silence would feel awkward
- no large spoken payloads from tools unless the agent asks for a summary
- strict schema validation for booking/finalization tools

Never let a tool failure cause the agent to pretend success. If confirmation,
payment, or owner notification fails, the agent should say that staff will
follow up.

## 9. Booking And Intake Protocols

Choose one protocol per intent. Do not mix protocols inside one conversation
unless the playbook explicitly defines the transition.

### Protocol A: Direct Confirm

Use when the business allows the system to create a confirmed appointment.

Required:

- service
- duration or job type
- time window or selected slot
- name
- phone or email
- explicit final confirmation

### Protocol B: Secure Finalization

Use when the customer must complete a secure booking, payment, consent, or
card-on-file step.

Rules:

- Do not say the appointment is confirmed.
- Do not collect card details by voice or SMS.
- Send the secure link only after name, phone, email, service, and time are
  understood and confirmed.
- Say the slot is not held unless the implementation actually supports a hold.

### Protocol C: Owner Confirm

Use when staff must review before confirming.

Rules:

- Collect safe basics.
- Explain that staff will confirm.
- Create an owner task/notification.
- Avoid exact promises beyond the configured callback SLA.

### Protocol D: Gated Compliance Review

Use for legal, CPA, medical-adjacent, finance, insurance, and other higher-risk
verticals.

Rules:

- No professional advice.
- No sensitive document collection over insecure channels.
- No relationship/engagement implication.
- Route to secure intake or owner review.

## 10. Contact Field Capture

Names, emails, and phone numbers are high-risk for voice STT.

Rules:

- Ask for phone numbers digit-by-digit in chunks.
- For email, ask the customer to spell the local part and domain when needed.
- Read back email addresses in a compact but unambiguous way.
- Do not infer unusual names or emails from accent, nationality, or prior
  guesses.
- After two failed attempts, route to owner follow-up rather than continuing to
  guess.
- If SMS is available and compliant, prefer sending links by SMS for callers who
  struggle with email.

Do not build custom pronunciation hacks into the prompt for individual names
unless the customer or tenant explicitly requested it and it is stored as
structured client data.

## 11. Escalation And Handoff

Handoff is a normal success path, not a failure.

Escalate or notify owner when:

- customer is angry, threatening, or mentions liability
- emergency or safety terms appear
- requested service is not offered
- customer is outside service area
- model confidence is low
- STT repeatedly misunderstands name, phone, email, or date
- booking/payment/finalization tool fails
- customer asks for the owner or staff
- policy or compliance says review is required

Owner notifications should include:

- tenant
- source channel
- customer contact info, if known
- detected intent
- short summary
- reason for escalation
- action requested from owner
- relevant links to internal dashboard or provider logs

Do not include secrets or secure tokens in notifications.

## 12. Observability

Log enough data to debug without re-listening to every call.

Recommended event fields:

```yaml
agent_version: <provider_version>
playbook_version: <playbook_version>
channel: voice | sms | yelp | thumbtack
intent_type: <intent_type>
detected_language: en | es | ru | unknown
language_switch_events: []
tool_calls: []
handoff_reason: <reason>
confidence_flags: []
latency_ms: {}
final_state: <state>
```

Voice-specific metrics:

- call duration
- transcript availability
- recording availability
- Retell webhook event type
- call-ended processing latency
- call-analyzed processing latency
- owner notification latency
- booking/finalization intent state
- tool failure reason

Language QA flags:

- switched from language A to B
- switch source was weak/ambiguous
- customer corrected agent language
- STT mismatch suspected
- owner callback caused by language mismatch

## 13. Testing Matrix

Each production agent needs tests at four layers.

### Unit Tests

Test structured logic:

- playbook loading
- runtime profile projection
- intake schema readiness
- escalation rules
- service mapping
- language gating
- tool input validation

### Prompt/Config Smoke Tests

Test generated artifacts:

- prompt builds without secrets
- prompt length stays under channel target
- required tool schemas exist
- required dynamic variables exist
- production-only fields are not included in sanitized output

### Provider Diff Tests

Before publish:

- compare desired Retell/Twilio/provider config with live config
- ensure target version is explicit
- ensure production mutation requires an explicit apply flag
- store sanitized publish artifact

### Manual QA

Run realistic calls/messages:

- normal new lead
- returning customer
- reschedule/cancel request
- price question
- unsupported service
- angry customer
- emergency phrase
- unclear name
- unclear email
- noisy audio
- non-native English
- each enabled language
- customer switches language mid-call
- tool timeout/failure

Use natural test phrases first. Adversarial mixed-language nonsense is useful,
but it should not be the only measure of production readiness.

## 14. Release Process

Use staging first whenever provider support allows it.

1. Read current live config.
2. Save a before artifact.
3. Build the desired config from source.
4. Run unit tests.
5. Run prompt/config smoke tests.
6. Run provider diff.
7. Publish to staging.
8. Run manual QA.
9. Publish to production with an explicit apply flag.
10. Pin phone/webhook routing to the published version.
11. Update tenant runtime metadata.
12. Run live diff.
13. Save an after artifact.
14. Monitor first real calls/messages.

Production mutation commands must be explicit. A normal build or diff command
must never modify live provider state.

## 15. Rollback Process

Every provider publish should leave enough data to roll back.

Minimum rollback data:

- prior provider version
- prior phone routing
- prior runtime metadata
- before/after artifacts
- deployment timestamp
- operator note

Rollback steps:

1. Rebind phone/webhook routing to the prior known-good version.
2. Restore runtime metadata if it points at a newer version.
3. Run provider diff.
4. Run one smoke call or test message.
5. Note the incident reason and link artifacts.

Never delete the failed version immediately. Keep it for comparison and review.

## 16. Incident Review

For a bad call or message, collect:

- provider call/message ID
- timestamp
- agent/provider version
- playbook version
- transcript
- recording, if voice and permitted
- tool calls and responses
- owner/customer outcome
- suspected failure class

Failure classes:

- STT/transcription error
- TTS/voice pacing issue
- prompt instruction gap
- tool schema gap
- tool backend failure
- business policy missing
- unsafe model inference
- provider routing/config issue
- compliance/channel issue

Review order:

1. Check provider transcript against independent transcript if audio is
   available.
2. Check whether the agent followed the prompt it actually had.
3. Check tool payloads and backend logs.
4. Decide whether the fix belongs in structured data, tool validation, prompt
   wording, provider config, or owner process.
5. Add or update tests before publishing a behavior fix.

## 17. Multichannel SMS Notes

SMS is not just a fallback. It needs compliance and opt-in.

Rules:

- Use A2P registration where required.
- Respect opt-out keywords.
- Keep sample messages aligned with real traffic.
- Do not send marketing content under a transactional campaign.
- Log delivery status callbacks.
- Prefer short links only when policy and carrier filtering allow it.
- For voice booking, SMS can reduce email capture failures once compliance is
  complete.

Transactional examples should be stored as sanitized templates in code or docs,
not copied from private client traffic.

## 18. Client Acceptance Criteria

An agent is production-ready when:

- client playbook is active and versioned
- live provider version is pinned
- owner handoff path is tested
- at least one normal path completes end to end
- at least one failure path routes safely
- prompt/config has no secrets
- provider diff is clean
- tests pass
- owner knows what the agent can and cannot do
- rollback version is known

For voice, add:

- real call test passed
- recording/transcript retrieval verified
- tool calls complete within expected latency
- agent does not overtalk during slow customer speech
- contact field capture has a safe fallback
- multilingual behavior matches tenant config

## 19. Backlog Principles

When improving agents, prefer this order:

1. Structured playbook data
2. Tool/schema validation
3. Runtime guards
4. Observability
5. Short prompt instruction
6. Provider tuning

Prompt patches are useful, but they should not carry the whole system. If the
same issue happens twice, make it structured, observable, or testable.

## 20. Quick Operator Checklist

Before changing a live agent:

- Confirm tenant and channel.
- Read live provider config.
- Save before artifact.
- Identify source of truth for this client.
- Make scoped change.
- Run tests and smoke checks.
- Diff desired vs live.
- Publish only with explicit apply flag.
- Update runtime metadata.
- Verify phone/webhook routing.
- Save after artifact.
- Write a short client-facing summary.

