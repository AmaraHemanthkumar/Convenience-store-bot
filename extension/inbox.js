// ================= Inbox: Gmail, Woolworths / Coles accounts, photos, fetch history =================
// Loaded after dashboard.js (shares its helpers: $, log, esc, m, sleep, exec, waitComplete, loadFiles, state …)
const GM = window.CSB_GMAIL, SHOPINV = window.CSB_SHOPINV, PHOTO = window.CSB_PHOTO;
let inbox = { clientId: '', senders: [], accounts: [], shopAccounts: [], history: [] };
const gmTokens = {};            // email -> {token, expiresAt}; kept only while the browser is open

async function loadInbox() {
  const d = await chrome.storage.local.get('inbox');
  inbox = Object.assign(inbox, d.inbox || {});
  try { const t = await chrome.storage.session.get('gmTokens'); Object.assign(gmTokens, t.gmTokens || {}); } catch (e) { /* no session storage */ }
  renderInbox();
}
function saveInbox() { return chrome.storage.local.set({ inbox }); }
function saveTokens() { try { chrome.storage.session.set({ gmTokens }); } catch (e) { /* ignore */ } }

// ---------- fetch history ----------
const histHas = (key) => inbox.history.some((h) => h.key === key);
const histByHash = (hash) => inbox.history.find((h) => h.hash && h.hash === hash);
function addHistory(entry) {
  inbox.history.unshift(Object.assign({ fetchedAt: Date.now() }, entry));
  if (inbox.history.length > 3000) inbox.history.length = 3000;
  saveInbox();
}
async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
// called by loadFiles (dashboard.js) for every file that was loaded, whatever its source
function recordLoaded(meta, fileName, loadedAs) {
  addHistory({ key: meta.key || ('computer|' + fileName + '|' + Date.now()), hash: meta.hash || '', source: meta.source || 'computer', account: meta.account || '',
    from: meta.from || '', subject: meta.subject || '', emailAt: meta.emailAt || 0, fetchedAt: meta.fetchedAt || Date.now(), fileName, loadedAs: loadedAs || '', order: meta.order || '' });
  renderHistory();
}
function renderHistory() {
  const h = inbox.history;
  $('histInfo').textContent = h.length ? h.length + ' files' : '';
  $('histTable').innerHTML = '<thead><tr><th>Added</th><th>From where</th><th>Account</th><th>Sender</th><th>Subject / order</th><th>Email time</th><th>File</th><th>In Items &amp; prices as</th></tr></thead><tbody>' +
    (h.length ? h.slice(0, 300).map((x) => '<tr><td>' + esc(fmtTime(x.fetchedAt)) + '</td><td>' + esc(x.source) + '</td><td>' + esc(x.account) + '</td><td>' + esc(x.from) + '</td><td>' + esc(x.subject || x.order) +
      '</td><td>' + esc(fmtTime(x.emailAt)) + '</td><td>' + esc(x.fileName) + '</td><td>' + esc(x.loadedAs) + '</td></tr>').join('')
      : '<tr><td colspan="8" class="muted">Nothing fetched yet.</td></tr>') + '</tbody>';
}
$('histExport').addEventListener('click', () => {
  if (!inbox.history.length) { log('No fetch history yet.', 'err'); return; }
  writeSheet(inbox.history.map((x) => ({ 'Added': new Date(x.fetchedAt).toLocaleString('en-AU'), 'From where': x.source, Account: x.account, Sender: x.from, 'Subject / order': x.subject || x.order,
    'Email time': x.emailAt ? new Date(x.emailAt).toLocaleString('en-AU') : '', File: x.fileName, 'Loaded as': x.loadedAs })), 'fetch-history-' + saveStamp() + '.xlsx', 'History');
});

// ---------- Gmail: senders, accounts ----------
function renderInbox() {
  $('gmRedirect').textContent = GM.redirectUrl();
  $('gmClientId').value = inbox.clientId || '';
  $('gmClientState').textContent = inbox.clientId ? 'done ✓' : 'not set up yet';
  $('gmSenders').innerHTML = inbox.senders.length ? inbox.senders.map((s, i) =>
    '<span class="chip' + (s.on === false ? ' off' : '') + '" data-i="' + i + '"><label><input type="checkbox" class="gm-on"' + (s.on === false ? '' : ' checked') + '> <b>' + esc(s.label || s.email) + '</b> ' + (s.label ? esc(s.email) : '') + '</label><button class="gm-del" title="Remove">✕</button></span>').join('')
    : '<span class="muted small-note">No senders yet – add your suppliers\' invoice addresses and your own address (for barcode sheets).</span>';
  $('gmAccounts').innerHTML = inbox.accounts.length ? inbox.accounts.map((a, i) =>
    '<span class="chip" data-i="' + i + '">📧 ' + esc(a.email) + ' <button class="gm-acc-del" title="Remove">✕</button></span>').join('')
    : '<span class="muted small-note">No Gmail account linked yet.</span>';
  $('gmFrom').innerHTML = '<option value="">all approved senders</option>' + inbox.senders.filter((s) => s.on !== false).map((s) => '<option value="' + esc(s.email) + '">only ' + esc(s.label || s.email) + '</option>').join('');
  $('gmAccount').innerHTML = (inbox.accounts.length > 1 ? '<option value="">all Gmail accounts</option>' : '') + inbox.accounts.map((a) => '<option>' + esc(a.email) + '</option>').join('');
  $('shAccounts').innerHTML = inbox.shopAccounts.map((a) => '<option value="' + esc(a) + '">').join('');
  if (!$('shAccount').value && inbox.shopAccounts.length) $('shAccount').value = inbox.shopAccounts[0];
  renderHistory();
}
$('gmSaveClient').addEventListener('click', () => {
  const v = $('gmClientId').value.trim();
  if (v && !/\.apps\.googleusercontent\.com$/.test(v)) { log('That does not look like a Google client ID (it ends in .apps.googleusercontent.com).', 'err'); return; }
  inbox.clientId = v; saveInbox(); renderInbox(); log('Google client ID saved.', 'ok');
});
$('gmAddSender').addEventListener('click', () => {
  const email = $('gmNewSender').value.trim().toLowerCase(), label = $('gmNewLabel').value.trim();
  if (!/^@?[\w.+-]*@?[\w-]+\.[\w.-]+$/.test(email)) { log('Type an email address (orders@supplier.com.au) or a whole company (@supplier.com.au).', 'err'); return; }
  if (inbox.senders.some((s) => s.email === email)) { log(email + ' is already on the list.'); return; }
  inbox.senders.push({ email, label, on: true });
  $('gmNewSender').value = ''; $('gmNewLabel').value = '';
  saveInbox(); renderInbox();
});
$('gmSenders').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  const s = inbox.senders[Number(chip.dataset.i)];
  if (e.target.classList.contains('gm-del')) { if (confirm('Stop fetching from ' + (s.label || s.email) + '?')) inbox.senders.splice(Number(chip.dataset.i), 1); }
  else if (e.target.classList.contains('gm-on')) s.on = e.target.checked;
  else return;
  saveInbox(); renderInbox();
});
$('gmAccounts').addEventListener('click', (e) => {
  if (!e.target.classList.contains('gm-acc-del')) return;
  const i = Number(e.target.closest('.chip').dataset.i);
  if (!confirm('Unlink ' + inbox.accounts[i].email + '? (Nothing in the mailbox changes.)')) return;
  delete gmTokens[inbox.accounts[i].email]; saveTokens();
  inbox.accounts.splice(i, 1); saveInbox(); renderInbox();
});
$('gmAddAccount').addEventListener('click', async () => {
  try {
    const t = await GM.signIn(inbox.clientId, '', true);
    if (!t.email) throw new Error('Google did not say which account that was.');
    gmTokens[t.email] = { token: t.token, expiresAt: t.expiresAt }; saveTokens();
    if (!inbox.accounts.some((a) => a.email === t.email)) inbox.accounts.push({ email: t.email, addedAt: Date.now() });
    saveInbox(); renderInbox(); log('Gmail ' + t.email + ' linked (read-only).', 'ok');
  } catch (err) { log('Gmail sign-in: ' + err.message, 'err'); }
});
$('gmSince').addEventListener('change', () => $('gmSinceDate').classList.toggle('hidden', $('gmSince').value !== 'date'));

async function gmToken(email) {
  const t = gmTokens[email];
  if (t && t.expiresAt > Date.now()) return t.token;
  let fresh = null;
  try { fresh = await GM.signIn(inbox.clientId, email, false); } catch (e) { fresh = await GM.signIn(inbox.clientId, email, true); }
  gmTokens[email] = { token: fresh.token, expiresAt: fresh.expiresAt }; saveTokens();
  return fresh.token;
}

let fetching = false;
$('gmFetch').addEventListener('click', () => fetchGmail());
async function fetchGmail() {
  if (fetching) return;
  if (!inbox.clientId) { log('Gmail is not set up yet – open "One-time setup" in the Inbox tab.', 'err'); return; }
  if (!inbox.accounts.length) { log('Link a Gmail account first ("+ Add a Gmail account").', 'err'); return; }
  const senders = inbox.senders.filter((s) => s.on !== false && (!$('gmFrom').value || s.email === $('gmFrom').value)).map((s) => s.email);
  if (!senders.length) { log('Add at least one approved sender first.', 'err'); return; }
  const accounts = $('gmAccount').value ? [$('gmAccount').value] : inbox.accounts.map((a) => a.email);
  const sv = $('gmSince').value;
  const since = sv === 'date' ? ($('gmSinceDate').value ? new Date($('gmSinceDate').value + 'T00:00:00') : null) : new Date(Date.now() - (Number(sv) - (sv === '1' ? 1 : 0)) * 86400000);
  if (!since) { log('Pick the date to fetch from.', 'err'); return; }
  fetching = true; $('gmFetch').disabled = true;
  const entries = []; let mails = 0, skipped = 0, same = 0;
  try {
    for (const acc of accounts) {
      $('gmInfo').textContent = 'Checking ' + acc + '…';
      let token = await gmToken(acc);
      const q = GM.buildQuery(senders, since);
      let ids;
      try { ids = await GM.listMessages(token, q, 300); } catch (e) { if (!e.expired) throw e; delete gmTokens[acc]; token = await gmToken(acc); ids = await GM.listMessages(token, q, 300); }
      for (const id of ids) {
        const msg = await GM.getMessage(token, id);
        if (!GM.senderAllowed(msg.from, senders)) continue;           // Gmail search is loose – check the sender ourselves
        mails++;
        for (const att of msg.attachments) {
          const key = GM.fetchKey(acc, msg.id, att.filename);
          if (histHas(key)) { skipped++; continue; }
          $('gmInfo').textContent = 'Downloading ' + att.filename + ' (' + GM.emailOf(msg.from) + ')…';
          const bytes = await GM.getAttachment(token, msg.id, att);
          const hash = await sha256(bytes);
          const dup = histByHash(hash);
          if (dup) { same++; addHistory({ key, hash, source: 'gmail', account: acc, from: GM.emailOf(msg.from), subject: msg.subject, emailAt: msg.emailAt, fileName: att.filename, loadedAs: 'skipped – same file as ' + (dup.fileName || '') + ' (' + fmtTime(dup.fetchedAt) + ')' }); continue; }
          entries.push({ file: new File([bytes], att.filename, { type: att.mimeType || '' }),
            meta: { source: 'gmail', account: acc, from: GM.emailOf(msg.from), subject: msg.subject, emailAt: msg.emailAt, fetchedAt: Date.now(), key, hash } });
        }
      }
    }
    entries.sort((a, b) => a.meta.emailAt - b.meta.emailAt);
    const n = entries.length ? await loadFiles(entries) : 0;
    const msgTxt = 'Gmail: ' + mails + ' emails from your approved senders · ' + n + ' new file' + (n === 1 ? '' : 's') + ' loaded' +
      (skipped ? ' · ' + skipped + ' fetched before (skipped)' : '') + (same ? ' · ' + same + ' identical to a file you already have (skipped)' : '');
    $('gmInfo').textContent = msgTxt; log(msgTxt + (n ? ' – see Items & prices.' : '.'), 'ok');
  } catch (err) {
    $('gmInfo').textContent = 'Stopped: ' + err.message; log('Gmail fetch: ' + err.message, 'err');
  } finally { fetching = false; $('gmFetch').disabled = false; renderHistory(); }
}

// ---------- Woolworths / Coles invoices ----------
$('shWW').addEventListener('click', () => shopInvoices('Woolworths'));
$('shColes').addEventListener('click', () => shopInvoices('Coles'));
async function shopInvoices(store) {
  if (fetching) return;
  const account = ($('shAccount').value || '').trim() || 'main';
  if (!inbox.shopAccounts.includes(account)) { inbox.shopAccounts.push(account); saveInbox(); renderInbox(); }
  const max = Math.max(1, Math.min(60, Number($('shMax').value) || 10));
  const gap = store === 'Coles' ? 3000 : 1500;
  const info = (t) => { $('shInfo').textContent = t; };
  fetching = true; $('shWW').disabled = $('shColes').disabled = true;
  let tabId = null;
  try {
    info('Opening your ' + store + ' orders…');
    const t = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabId = t.id;
    await sleep(800);
    await chrome.tabs.update(tabId, { url: SHOPINV.SHOPS[store].orders });
    await sleep(300);
    await waitComplete(tabId, 40000); await sleep(4000);
    let page = await exec(tabId, null, SHOPINV.scanPage);
    if (page && page.challenge) { info(store + ' is showing a "not a robot" check. Open the ' + store + ' tab, finish the check, then press the button again.'); log(store + ' asked for a robot check – finish it in the ' + store + ' tab, then press again.', 'err'); tabId = null; return; }
    if (page && page.signedOut) { info('Log in to ' + store + ' in this browser first (with the "' + account + '" account), then press again.'); log('Not logged in to ' + store + '.', 'err'); return; }
    const invoices = (page.invoices || []).slice();
    const orders = (page.orders || []).slice(0, max);
    for (let i = 0; i < orders.length && invoices.length < max; i++) {
      info('Looking at order ' + (i + 1) + ' of ' + orders.length + '…');
      await chrome.tabs.update(tabId, { url: orders[i].href });
      await sleep(500); await waitComplete(tabId, 40000); await sleep(2500);
      const p = await exec(tabId, null, SHOPINV.scanPage);
      if (p && p.challenge) { log(store + ' asked for a robot check part-way – stopped there. Finish the check in that tab and press again; the invoices so far are kept.', 'err'); break; }
      (p.invoices || []).forEach((x) => { if (!invoices.some((y) => y.href === x.href)) invoices.push(Object.assign({ orderHref: orders[i].href }, x)); });
      await sleep(gap);
    }
    if (!invoices.length) {
      info('No invoice links found on your ' + store + ' order pages.');
      log(store + ': no invoice links found (' + (page.orders || []).length + ' orders seen on ' + (page.url || JSON.stringify(page).slice(0, 200)) + '). Your account pages may be laid out differently – send me a screenshot of one order page and I will adjust the bot.', 'err');
      return;
    }
    const entries = []; let skipped = 0, notPdf = 0;
    for (const inv of invoices.slice(0, max)) {
      const order = SHOPINV.orderNumberOf(inv.href) || SHOPINV.orderNumberOf(inv.orderHref) || SHOPINV.orderNumberOf(inv.label);
      const key = store + '|' + account.toLowerCase() + '|' + (order || inv.href);
      if (histHas(key)) { skipped++; continue; }
      info('Downloading ' + store + ' invoice ' + (order || '') + '…');
      const r = await exec(tabId, null, SHOPINV.grabPdf, [inv.href]);
      if (!r || !r.ok) { notPdf++; continue; }
      const bin = atob(r.b64); const bytes = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      const name = r.name || (store + '-' + (order || entries.length + 1) + '.pdf');
      entries.push({ file: new File([bytes], name, { type: 'application/pdf' }), meta: { source: store, account, order, fetchedAt: Date.now(), key, hash: await sha256(bytes) } });
      await sleep(gap);
    }
    const n = entries.length ? await loadFiles(entries) : 0;
    const t2 = store + ' (' + account + '): ' + n + ' invoice' + (n === 1 ? '' : 's') + ' loaded' + (skipped ? ' · ' + skipped + ' downloaded before (skipped)' : '') + (notPdf ? ' · ' + notPdf + ' links were not PDFs' : '');
    info(t2); log(t2 + '.', 'ok');
  } catch (err) { info('Stopped: ' + err.message); log(store + ' invoices: ' + err.message, 'err'); }
  finally {
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
    fetching = false; $('shWW').disabled = $('shColes').disabled = false; renderHistory();
  }
}

// ---------- printed invoices from photos ----------
$('photoFile').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []); e.target.value = '';
  if (!files.length) return;
  await loadFiles(files.map((f) => ({ file: f, meta: { source: 'photo', fetchedAt: Date.now() } })));
});
async function readInvoicePhoto(file) {
  const show = (t) => { $('photoInfo').textContent = t; };
  show('Reading ' + file.name + '… 0%');
  log('Reading the photo ' + file.name + ' – about a minute on a slow laptop…');
  const inv = await PHOTO.readPhoto(file, (p) => show('Reading ' + file.name + '… ' + Math.round(p * 100) + '%'));
  if (!inv.items.length) { show(''); throw new Error('No item lines could be read from this photo (' + inv.lineCount + ' lines of text). Try a sharper, flatter photo in good light, or send it to me in the chat.'); }
  inv.id = 'inv-photo-' + (inv.number || file.name); inv.file = file.name; inv.loadedAt = Date.now();
  state.invoices = (state.invoices || []).filter((x) => x.id !== inv.id).concat([inv]);
  invIndex = null;
  show(file.name + ': ' + inv.items.length + ' lines read' + (inv.unsureCount ? ', ' + inv.unsureCount + ' to check' : '') + (inv.printedTotal ? ' · total on paper $' + inv.printedTotal.toFixed(2) + ', lines add up to $' + inv.total.toFixed(2) : ''));
  return inv;
}

loadInbox();
