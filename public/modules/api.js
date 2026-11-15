// Calls to the reader's own server.
export async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code, status: res.status });
  return data;
}

// True when the request never got an answer from FreshRSS: either this device
// is offline or the reader's server cannot reach FreshRSS. Worth retrying later.
export const unreachable = (err) => err instanceof TypeError || err.code === 'freshrss_unreachable';

export function explain(err) {
  if (err instanceof TypeError) return 'you appear to be offline, or the reader can’t be reached';
  if (err.code === 'freshrss_unreachable') return 'the reader is running but FreshRSS can’t be reached';
  if (err.code === 'freshrss_auth') return 'FreshRSS rejected the reader’s API password';
  return err.message;
}
