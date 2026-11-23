'use strict';
// Maps booking-provider statuses (Square Bookings here) to local state and to
// the owner notification each one triggers. Unknown statuses fail closed: they
// are never treated as confirmed and never notify the owner.

const CONFIRMED_STATUSES = new Set(['ACCEPTED', 'PENDING', 'COMPLETED']);

// Each key doubles as the idempotency key for that notification.
const OWNER_NOTIFICATION_KEYS = Object.freeze({
  booking_cancelled: 'owner_booking_cancelled',
  booking_rescheduled: 'owner_booking_rescheduled',
  booking_no_show: 'owner_booking_no_show',
  booking_declined: 'owner_booking_declined',
});

function normalizeBookingStatus(status) {
  return String(status || '').trim().toUpperCase();
}

function classifyBookingStatus(status) {
  const providerStatus = normalizeBookingStatus(status);

  if (CONFIRMED_STATUSES.has(providerStatus)) {
    return { kind: 'confirmed', localBookingStatus: 'created', terminalIntentState: null, ownerNotificationType: null };
  }
  if (providerStatus.includes('CANCELLED') || providerStatus.includes('CANCELED')) {
    return { kind: 'cancelled', localBookingStatus: 'cancelled', terminalIntentState: 'cancelled', ownerNotificationType: 'booking_cancelled' };
  }
  if (providerStatus === 'NO_SHOW') {
    return { kind: 'no_show', localBookingStatus: 'no_show', terminalIntentState: 'no_show', ownerNotificationType: 'booking_no_show' };
  }
  if (providerStatus === 'DECLINED') {
    return { kind: 'declined', localBookingStatus: 'declined', terminalIntentState: 'declined', ownerNotificationType: 'booking_declined' };
  }
  return { kind: 'failed', localBookingStatus: 'failed', terminalIntentState: null, ownerNotificationType: null };
}

function isOwnerLifecycleNotificationType(notificationType) {
  return Object.hasOwn(OWNER_NOTIFICATION_KEYS, notificationType);
}

function getOwnerLifecycleNotificationKey(notificationType) {
  return OWNER_NOTIFICATION_KEYS[notificationType] || null;
}

module.exports = {
  classifyBookingStatus,
  getOwnerLifecycleNotificationKey,
  isOwnerLifecycleNotificationType,
  normalizeBookingStatus,
};
