// utils/telemetry.js
// Lightweight, in-memory telemetry for debugging (no network)

const counters = Object.create(null);
const last = Object.create(null);
const recent = [];
const MAX_RECENT = 50;

function record(event, data = {}) {
  counters[event] = (counters[event] || 0) + 1;
  last[event] = { t: Date.now(), ...data };
  recent.push({ event, t: Date.now(), ...data });
  if (recent.length > MAX_RECENT) recent.shift();
}

export const telemetry = {
  record,
  counters,
  last,
  recent,
  snapshot() {
    return {
      t: Date.now(),
      counters: { ...counters },
      last: { ...last },
      recent: [...recent]
    };
  },
  reset() {
    for (const k of Object.keys(counters)) delete counters[k];
    for (const k of Object.keys(last)) delete last[k];
    recent.length = 0;
  }
};

try {
  if (typeof window !== 'undefined') {
    window.__dcTelemetry = telemetry;
    // Convenience alias
    window._dcTelemetry = telemetry;
  }
} catch {}
