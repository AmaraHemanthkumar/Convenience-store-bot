// Gmail: read-only fetch of invoice PDFs / Excel sheets / photos from approved senders.
// Sign-in uses chrome.identity.launchWebAuthFlow (works in Brave, where getAuthToken does not),
// with your own Google "Web application" OAuth client. The bot only asks for gmail.readonly.
(function (root) {
  const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email';
  const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
  const WANT = /\.(pdf|xlsx|xls|csv|jpe?g|png|webp|heic)$/i;

  // ---------- pure helpers (tested in node) ----------
  function ymd(d) {
    const x = new Date(d);
    return x.getFullYear() + '/' + String(x.getMonth() + 1).padStart(2, '0') + '/' + String(x.getDate()).padStart(2, '0');
  }
  // Gmail search: only these senders, only mails with attachments, from this day on
  function buildQuery(senders, since) {
    const list = (senders || []).map((s) => String(s || '').trim()).filter(Boolean);
    const parts = [];
    if (list.length) parts.push('from:(' + list.join(' OR ') + ')');
    parts.push('has:attachment');
    if (since) parts.push('after:' + ymd(since));
    return parts.join(' ');
  }
  // all attachments in a message payload (parts can be nested)
  function attachmentsOf(payload) {
    const out = [];
    (function walk(p) {
      if (!p) return;
      if (p.filename && p.body && (p.body.attachmentId || p.body.data) && WANT.test(p.filename)) {
        out.push({ filename: p.filename, mimeType: p.mimeType || '', attachmentId: p.body.attachmentId || '', data: p.body.data || '', size: p.body.size || 0 });
      }
      (p.parts || []).forEach(walk);
    })(payload);
    return out;
  }
  function header(payload, name) {
    const h = ((payload && payload.headers) || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  }
  // "The Distributors <orders@thedistributors.com.au>" -> "orders@thedistributors.com.au"
  function emailOf(from) {
    const m = String(from || '').match(/<([^>]+)>/);
    return (m ? m[1] : String(from || '')).trim().toLowerCase();
  }
  function senderAllowed(from, senders) {
    const e = emailOf(from);
    return (senders || []).some((s) => {
      const t = String(s || '').trim().toLowerCase();
      if (!t) return false;
      return t.startsWith('@') ? e.endsWith(t) : (t.includes('@') ? e === t : e.endsWith('@' + t) || e.endsWith('.' + t));
    });
  }
  function b64urlToBytes(s) {
    const b = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = typeof atob === 'function' ? atob(b + '==='.slice((b.length + 3) % 4)) : Buffer.from(b, 'base64').toString('binary');
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  // one key per attachment, so the same attachment is never loaded twice
  const fetchKey = (account, messageId, filename) => [String(account || '').toLowerCase(), messageId, filename].join('|');
  function tokenFromRedirect(url) {
    const frag = String(url || '').split('#')[1] || '';
    const p = new URLSearchParams(frag);
    if (p.get('error')) throw new Error('Google said: ' + p.get('error'));
    const token = p.get('access_token');
    if (!token) throw new Error('No sign-in token came back from Google.');
    return { token, expiresAt: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000 - 60000 };
  }

  // ---------- browser side ----------
  function redirectUrl() { return chrome.identity.getRedirectURL('gmail'); }
  async function signIn(clientId, hintEmail, interactive) {
    if (!clientId) throw new Error('Add your Google client ID in the Inbox tab first (one-time setup).');
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('response_type', 'token');
    u.searchParams.set('redirect_uri', redirectUrl());
    u.searchParams.set('scope', SCOPE);
    u.searchParams.set('include_granted_scopes', 'true');
    if (hintEmail) u.searchParams.set('login_hint', hintEmail);
    if (!interactive) u.searchParams.set('prompt', 'none');            // quiet renewal of a known account
    else if (!hintEmail) u.searchParams.set('prompt', 'select_account consent');
    const back = await chrome.identity.launchWebAuthFlow({ url: u.toString(), interactive: !!interactive });
    const t = tokenFromRedirect(back);
    const who = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + t.token } }).then((r) => r.json()).catch(() => ({}));
    t.email = (who.email || hintEmail || '').toLowerCase();
    return t;
  }
  async function api(token, path) {
    const res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) { const e = new Error('Gmail sign-in expired'); e.expired = true; throw e; }
    if (!res.ok) throw new Error('Gmail ' + res.status + ': ' + (await res.text()).slice(0, 200));
    return res.json();
  }
  async function listMessages(token, q, max) {
    const ids = [];
    let page = '';
    do {
      const d = await api(token, 'messages?maxResults=100&q=' + encodeURIComponent(q) + (page ? '&pageToken=' + page : ''));
      (d.messages || []).forEach((m) => ids.push(m.id));
      page = d.nextPageToken || '';
    } while (page && ids.length < (max || 300));
    return ids;
  }
  async function getMessage(token, id) {
    const m = await api(token, 'messages/' + id + '?format=full');
    return {
      id: m.id, from: header(m.payload, 'From'), subject: header(m.payload, 'Subject'),
      emailAt: Number(m.internalDate) || Date.parse(header(m.payload, 'Date')) || 0, attachments: attachmentsOf(m.payload),
    };
  }
  async function getAttachment(token, messageId, att) {
    if (att.data) return b64urlToBytes(att.data);
    const d = await api(token, 'messages/' + messageId + '/attachments/' + att.attachmentId);
    return b64urlToBytes(d.data);
  }

  root.CSB_GMAIL = { SCOPE, buildQuery, attachmentsOf, header, emailOf, senderAllowed, b64urlToBytes, fetchKey, tokenFromRedirect, redirectUrl, signIn, listMessages, getMessage, getAttachment };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CSB_GMAIL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
