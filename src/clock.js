// Request-time clock context for the Dialogue model (Specification 0001 section 3). Stored instants are UTC ISO
// strings; each one is localized in the user's browser time zone with its own offset, so DST is handled per instant.
// Without a valid browser zone, everything is labeled UTC; the server's own time zone is never used.

export const UTC_ZONE = "UTC";

// A browser-reported IANA time zone, or null when absent or unknown to this Node.js runtime. The browser's spelling
// is kept (Intl would canonicalize Europe/Kyiv to the legacy Europe/Kiev).
export function validTimeZone(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(value) || value.length > 64) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); } catch { return null; }
  return /^(Etc\/)?(UTC|GMT|Zulu|UCT|Universal)$/i.test(value) ? UTC_ZONE : value;
}

function isoSeconds(date) { return date.toISOString().replace(/\.\d{3}Z$/, "Z"); }

// "Sun 1 Nov 2026, 09:12 Europe/Kyiv (GMT+2)", or "Sun 1 Nov 2026, 07:12 UTC" for the UTC fallback.
export function localLabel(date, timeZone) {
  const zone = timeZone || UTC_ZONE;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" }).formatToParts(date).map((part) => [part.type, part.value]));
  const base = `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
  return zone === UTC_ZONE ? `${base} UTC` : `${base} ${zone} (${parts.timeZoneName})`;
}

// The per-message metadata marker. Its exact shape is also what stripTimestampEcho removes from replies.
export function timestampMarker(createdAt, timeZone) {
  const date = new Date(createdAt);
  return `[sent ${isoSeconds(date)} | ${localLabel(date, timeZone)}]`;
}

const MARKER_ECHO = /^(?:\s*\[sent \d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z \|[^\]\n]*\])+\s*/;

// Removes timestamp markers the model copied to the start of its reply; the rest of the text is untouched.
export function stripTimestampEcho(text) {
  const stripped = String(text).replace(MARKER_ECHO, "");
  return { text: stripped, stripped: stripped !== text };
}

function elapsedLabel(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "less than a minute";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const unit = (count, name) => `${count} ${name}${count === 1 ? "" : "s"}`;
  if (days) return [unit(days, "day"), hours ? unit(hours, "hour") : null].filter(Boolean).join(" ");
  if (hours) return [unit(hours, "hour"), rest ? unit(rest, "minute") : null].filter(Boolean).join(" ");
  return unit(rest, "minute");
}

// Current-clock context, computed from absolute instants when the Dialogue request is assembled. Elapsed times are
// precomputed from instants so the model need not subtract local clock labels across DST changes.
export function clockContext({ now, timeZone, lastMessageAt = null, previousMessageAt = null }) {
  const zone = validTimeZone(timeZone);
  return {
    timeZone: zone || UTC_ZONE,
    timeZoneKnown: zone !== null,
    nowIso: isoSeconds(now),
    nowLocal: localLabel(now, zone),
    sinceLastMessage: lastMessageAt ? elapsedLabel(now.getTime() - new Date(lastMessageAt).getTime()) : null,
    gapBeforeLastMessage: lastMessageAt && previousMessageAt ? elapsedLabel(new Date(lastMessageAt).getTime() - new Date(previousMessageAt).getTime()) : null
  };
}
