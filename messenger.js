/*
 * messenger.js — Facebook Messenger integration layer for West Coast Socials.
 *
 * This is the ONLY place that talks to the Facebook Graph / Messenger Platform.
 * The rest of the app treats Messenger as an opaque channel and calls:
 *
 *     Messenger.isConnected()
 *     Messenger.getConfig()
 *     Messenger.connect({ pageId, pageName, accessToken, verifyToken, live })
 *     Messenger.disconnect()
 *     Messenger.send({ recipientId, text })            -> Promise<{ ok, messageId, simulated }>
 *     Messenger.buildSendRequest({ recipientId, text }) -> the exact Graph request
 *
 * PROTOTYPE MODE (default): send() resolves locally after a short delay and never
 * touches the network, matching the rest of this localStorage-only app. The real
 * Graph API request is still constructed by buildSendRequest() so the wire format
 * is correct and code-reviewable.
 *
 * GOING LIVE: connect({ ..., live: true }) with a real Page ID + Page access token.
 * send() will then POST to the Graph Send API. In production the token must move
 * server-side and a webhook endpoint is required to receive inbound messages — a
 * static page can neither safely hold a long-lived page token nor receive webhooks.
 *
 * WEBHOOK NOTES (server-side, out of scope for this static prototype):
 *   GET  /webhook  -> echo hub.challenge when hub.verify_token === verifyToken
 *   POST /webhook  -> entry[].messaging[] -> { sender.id (PSID), message.text }
 *                     map the PSID to a contact, then append an inbound message.
 */
(function () {
  const STORAGE_KEY = 'wcs.messenger.v1';
  const GRAPH_VERSION = 'v19.0';

  const defaultConfig = () => ({
    connected: false,
    live: false, // false = simulate locally, true = real Graph API calls
    pageId: '',
    pageName: '',
    accessToken: '',
    verifyToken: '',
    connectedAt: null,
  });

  let config = loadConfig();

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...defaultConfig(), ...JSON.parse(raw) } : defaultConfig();
    } catch {
      return defaultConfig();
    }
  }
  function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  function getConfig() {
    return { ...config };
  }
  function isConnected() {
    return !!config.connected;
  }

  function connect(next = {}) {
    config = { ...config, ...next };
    config.connected = !!(config.pageId && config.accessToken);
    config.connectedAt = config.connected ? new Date().toISOString() : null;
    saveConfig();
    return getConfig();
  }
  function disconnect() {
    config = defaultConfig();
    saveConfig();
    return getConfig();
  }

  // Build the exact Graph Send API request. Mirrors the documented
  // POST /{page-id}/messages call so it can be lifted into a backend as-is.
  // The access token is kept out of the body/url here so it is never logged inline.
  function buildSendRequest({ recipientId, text, messagingType = 'RESPONSE' }) {
    return {
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(config.pageId || 'PAGE_ID')}/messages`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      query: { access_token: config.accessToken || 'PAGE_ACCESS_TOKEN' },
      body: {
        recipient: { id: recipientId },
        messaging_type: messagingType,
        message: { text },
      },
    };
  }

  function send({ recipientId, text }) {
    if (!isConnected()) {
      return Promise.reject(
        new Error('Messenger is not connected. Add a Page ID and access token in Accounts → Messaging channels.')
      );
    }
    if (!recipientId) {
      return Promise.reject(new Error('This contact has no Messenger ID (PSID).'));
    }

    const req = buildSendRequest({ recipientId, text });

    if (!config.live) {
      // PROTOTYPE: log the request we *would* send, then resolve locally.
      console.info('[Messenger:simulate] POST', req.url, req.body);
      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              ok: true,
              simulated: true,
              messageId: 'mid.sim_' + Math.random().toString(36).slice(2, 12),
              recipientId,
            }),
          500 + Math.random() * 400
        );
      });
    }

    // LIVE: real Graph Send API call. Token in the query string is fine only for
    // throwaway testing — production must proxy this through a server.
    const url = req.url + '?access_token=' + encodeURIComponent(req.query.access_token);
    return fetch(url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(data?.error?.message || 'Graph API error ' + r.status);
      }
      return { ok: true, simulated: false, messageId: data.message_id, recipientId };
    });
  }

  window.Messenger = {
    GRAPH_VERSION,
    getConfig,
    isConnected,
    connect,
    disconnect,
    buildSendRequest,
    send,
  };
})();
