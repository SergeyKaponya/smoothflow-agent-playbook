'use strict';
// Contact fields arrive from speech-to-text and SMS, so they are normalized
// strictly and rejected rather than guessed.

/** Returns a US number in E.164 form, or '' when the input is not one. */
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

const PLACEHOLDER_DOMAIN = /@(example\.(com|org|net)|test\.com)$/i;

/** A model that lacks an address tends to invent a placeholder one; reject those too. */
function isDeliverableEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && !PLACEHOLDER_DOMAIN.test(email);
}

module.exports = { normalizePhone, isDeliverableEmail };
