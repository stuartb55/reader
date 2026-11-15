// A small client for FreshRSS's Google Reader API. Holds the login and the
// write token, and turns failures into errors the page can explain.
'use strict';

function upstream(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function createClient({ url, user, pass, fetchImpl = fetch, retryDelayMs = 300 }) {
  const base = url.replace(/\/$/, '') + '/api/greader.php';
  let auth = null;
  let loggingIn = null;
  let token = null;

  // One retry for a dropped connection; every call this app makes is safe to repeat.
  async function send(target, init, attempt = 0) {
    try {
      return await fetchImpl(target, { ...init, signal: AbortSignal.timeout(20000) });
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        return send(target, init, 1);
      }
      throw upstream(503, 'freshrss_unreachable', `FreshRSS can’t be reached (${err.cause?.code || err.name})`);
    }
  }

  // Requests that arrive together share one login.
  function login() {
    loggingIn ??= (async () => {
      const res = await send(`${base}/accounts/ClientLogin`, {
        method: 'POST',
        body: new URLSearchParams({ Email: user, Passwd: pass }),
      });
      const text = await res.text();
      const m = text.match(/^Auth=(.+)$/m);
      if (res.status === 401 || res.status === 403) {
        throw upstream(502, 'freshrss_auth', 'FreshRSS rejected the API user or password');
      }
      if (!res.ok || !m) throw upstream(502, 'freshrss_error', `FreshRSS login failed (${res.status})`);
      auth = m[1].trim();
    })().finally(() => {
      loggingIn = null;
    });
    return loggingIn;
  }

  async function greader(pathname, { params, body } = {}, retry = true) {
    if (!auth) await login();
    const res = await send(`${base}/reader/api/0/${pathname}${params ? `?${params}` : ''}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `GoogleLogin auth=${auth}` },
      body,
    });
    if (res.status === 401 && retry) {
      auth = null;
      token = null;
      return greader(pathname, { params, body }, false);
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => {});
      throw Object.assign(upstream(502, 'freshrss_error', `FreshRSS ${pathname} returned ${res.status}`), {
        upstreamStatus: res.status,
      });
    }
    return res;
  }

  async function json(pathname, options) {
    return (await greader(pathname, options)).json();
  }

  // The write token stays valid for a long time, so keep it and only fetch a
  // new one when FreshRSS refuses it.
  async function write(pathname, fields, retry = true) {
    token ??= (await (await greader('token')).text()).trim();
    const body = new URLSearchParams(fields);
    body.append('T', token);
    try {
      await (await greader(pathname, { body })).arrayBuffer();
    } catch (err) {
      if (retry && [400, 401, 403].includes(err.upstreamStatus)) {
        token = null;
        return write(pathname, fields, false);
      }
      throw err;
    }
  }

  // Confirms FreshRSS answers and accepts the credentials.
  async function check() {
    await (await greader('token')).arrayBuffer();
  }

  return { greader, json, write, check, base };
}

module.exports = { createClient };
