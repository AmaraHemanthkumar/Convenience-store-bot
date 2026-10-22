/*
 * Convenience Store Bot - PosPort catalogue capture.
 * Runs in the PAGE (main world) of manager.posport.com.au from the moment it loads.
 * It does not send anything anywhere: it only watches the item lists the Back Office
 * already downloads for you and keeps id / name / price / barcode in this site's
 * localStorage, so the bot can match barcodes and open the label page directly.
 */
(function () {
  'use strict';
  if (window.__CSB_CAPTURE_INSTALLED) return;
  window.__CSB_CAPTURE_INSTALLED = true;

  const KEY = '__csb_items';
  const ID_KEYS = ['id', '_id', 'uuid', 'itemId', 'item_id'];
  const NAME_KEYS = ['name', 'itemName', 'item_name', 'displayName', 'title'];
  const PRICE_KEYS = ['price', 'sellingPrice', 'selling_price', 'salePrice', 'basePrice', 'base_price', 'defaultPrice', 'retailPrice', 'unitPrice', 'amount'];
  // real barcode fields first; an SKU / PLU / code is only used when it looks like a barcode (8-14 digits)
  const BARCODE_KEYS = ['barcode', 'barCode', 'bar_code', 'barcodeNumber', 'barcode_number', 'upc', 'ean', 'ean13', 'gtin', 'apn'];
  const MAYBE_KEYS = ['sku', 'plu', 'code', 'itemCode', 'item_code', 'productCode'];
  const CAT_KEYS = ['categoryName', 'category_name', 'category'];

  function pick(o, keys) {
    for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return { key: k, value: o[k] };
    return null;
  }

  function priceOf(o) {
    let p = pick(o, PRICE_KEYS);
    if (p && typeof p.value === 'object') p = pick(p.value, ['amount', 'value', 'price']);
    if (!p && Array.isArray(o.variants) && o.variants[0]) p = pick(o.variants[0], PRICE_KEYS);
    if (!p) return null;
    const n = parseFloat(p.value);
    if (!isFinite(n)) return null;
    const cents = /cent/i.test(p.key);
    return { value: cents ? n / 100 : n, key: p.key };
  }

  const digits = (v) => String(v === null || v === undefined ? '' : v).replace(/\s/g, '');
  const looksLikeBarcode = (v) => /^\d{8,14}$/.test(digits(v));
  function gs1ok(b) {
    const d = digits(b);
    if (!/^\d{8,14}$/.test(d)) return false;
    let sum = 0;
    for (let i = d.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(d[i]) * w;
    return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
  }
  // Every barcode an item has: top-level fields, a barcodes list, and each variant (sizes / flavours).
  function barcodesOf(o) {
    const found = [];
    const add = (v) => {
      if (v && typeof v === 'object') v = v.code || v.barcode || v.value || v.number || '';
      const d = digits(v);
      if (d && !found.includes(d)) found.push(d);
    };
    const fromObj = (x) => {
      if (!x || typeof x !== 'object') return;
      BARCODE_KEYS.forEach((k) => { if (x[k] !== undefined && x[k] !== null && x[k] !== '') (Array.isArray(x[k]) ? x[k] : [x[k]]).forEach(add); });
      ['barcodes', 'barCodes', 'eans', 'upcs'].forEach((k) => { if (Array.isArray(x[k])) x[k].forEach(add); });
      MAYBE_KEYS.forEach((k) => { if (looksLikeBarcode(x[k])) add(x[k]); });
    };
    fromObj(o);
    ['variants', 'items', 'skus', 'options'].forEach((k) => { if (Array.isArray(o[k])) o[k].slice(0, 50).forEach(fromObj); });
    // real barcodes first (8-14 digits with a correct check digit), then other digit codes
    return found.sort((a, b) => (gs1ok(b) - gs1ok(a)) || (looksLikeBarcode(b) - looksLikeBarcode(a)));
  }
  function barcodeOf(o) { return barcodesOf(o)[0] || ''; }

  function asItem(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const id = pick(o, ID_KEYS);
    const name = pick(o, NAME_KEYS);
    if (!id || !name || typeof name.value !== 'string') return null;
    const price = priceOf(o);
    if (!price) return null;
    let cat = pick(o, CAT_KEYS);
    if (cat && typeof cat.value === 'object') cat = pick(cat.value, ['name', 'title']);
    return {
      id: String(id.value),
      name: name.value.trim(),
      price: price.value,
      priceKey: price.key,
      barcode: barcodeOf(o),
      barcodes: barcodesOf(o),
      category: cat ? String(cat.value) : '',
      active: o.isActive !== undefined ? !!o.isActive : (o.status !== undefined ? String(o.status) : ''),
      seen: Date.now(),
    };
  }

  function collect(node, out, depth) {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      let hits = 0;
      for (const el of node) {
        const it = asItem(el);
        if (it) { out.push(it); hits++; }
      }
      if (!hits) node.slice(0, 200).forEach((el) => collect(el, out, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      const single = asItem(node);
      if (single && depth > 0) out.push(single);
      for (const k in node) if (node[k] && typeof node[k] === 'object') collect(node[k], out, depth + 1);
    }
  }

  function save(items) {
    if (!items.length) return;
    let store = {};
    try { store = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { store = {}; }
    items.forEach((it) => { store[it.id] = Object.assign(store[it.id] || {}, it); });
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* storage full - ignore */ }
    window.dispatchEvent(new CustomEvent('csb-captured', { detail: items.length }));
  }

  function handle(url, text) {
    if (!text || (text[0] !== '{' && text[0] !== '[')) return;
    if (/\.(js|css|png|svg)(\?|$)/.test(url)) return;
    try {
      const data = JSON.parse(text);
      const out = [];
      collect(data, out, 0);
      save(out);
      // Keep the raw answers in memory (this page only) for "Back up all Back Office data".
      // Nothing is sent anywhere; the bot reads this when you ask for a backup.
      const raw = (window.__csbRaw = window.__csbRaw || { size: 0, items: {} });
      if (raw.size + text.length < 60e6) {
        const key = String(url).replace(/^https?:\/\/[^/]+/, '');
        if (!raw.items[key]) raw.size += text.length;
        raw.items[key] = { url: key, at: Date.now(), data };
      }
    } catch (e) { /* not JSON */ }
  }

  window.__CSB_CAPTURE = { asItem, barcodesOf, collect };      // used by the bot's own tests

  const origFetch = window.fetch;
  window.fetch = function () {
    const p = origFetch.apply(this, arguments);
    try {
      const url = String((arguments[0] && arguments[0].url) || arguments[0] || '');
      p.then((res) => {
        const ct = res.headers.get('content-type') || '';
        if (/json/.test(ct)) res.clone().text().then((t) => handle(url, t)).catch(() => {});
      }).catch(() => {});
    } catch (e) { /* never break the site */ }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__csbUrl = String(url || '');
    this.addEventListener('load', function () {
      try {
        if (this.responseType === '' || this.responseType === 'text') handle(this.__csbUrl, this.responseText);
        else if (this.responseType === 'json') handle(this.__csbUrl, JSON.stringify(this.response));
      } catch (e) { /* ignore */ }
    });
    return origOpen.apply(this, arguments);
  };
})();
