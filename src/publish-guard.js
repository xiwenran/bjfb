function toIsoString(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizePublishedEntry(value, now = Date.now()) {
  if (!value) return null;

  if (value === true) {
    return {
      submittedAt: toIsoString(now),
      observedPublishedAt: null,
    };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const submittedAt = toIsoString(
    value.submittedAt
    || value.lastSubmittedAt
    || value.createdAt
    || now
  );

  return {
    submittedAt,
    observedPublishedAt: toIsoString(
      value.observedPublishedAt
      || value.publishedAt
      || value.lastPublishedAt
      || null
    ),
  };
}

function createSubmittedEntry(now = Date.now()) {
  return {
    submittedAt: toIsoString(now),
    observedPublishedAt: null,
  };
}

function markEntryObservedPublished(entry, now = Date.now()) {
  const normalized = normalizePublishedEntry(entry, now) || createSubmittedEntry(now);
  return {
    ...normalized,
    observedPublishedAt: toIsoString(now),
  };
}

function shouldKeepEntryForPendingStatus(entry, now = Date.now(), guardMs = 2 * 60 * 1000) {
  const normalized = normalizePublishedEntry(entry, now);
  if (!normalized) return false;
  if (normalized.observedPublishedAt) return false;

  const submittedAt = Date.parse(normalized.submittedAt || '');
  if (!Number.isFinite(submittedAt)) return false;

  return now - submittedAt < guardMs;
}

module.exports = {
  normalizePublishedEntry,
  createSubmittedEntry,
  markEntryObservedPublished,
  shouldKeepEntryForPendingStatus,
};
