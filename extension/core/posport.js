/*
 * Convenience Store Bot - PosPort Back Office actions.
 * Runs inside a manager.posport.com.au tab. Every function is one small, safe step
 * (fill a row, tick a box, set a price) so the controller can check the result of
 * each step and stop on the first problem.
 *
 * All text/placeholder matching lives in SEL so it can be adjusted from Settings
 * if PosPort renames something.
 */
(function (root) {
  'use strict';

  const SEL = {
    bulkNamePlaceholder: /^enter item name$/i,
    bulkBarcodePlaceholder: /^enter barcode$/i,
    categoryTriggerText: /^select category$/i,
    addRowButton: /^\+?\s*add row$/i,
    createButton: /^create\s+\d+\s+items?$/i,
    listSearchPlaceholder: /^search$/i,
    printLabelsButton: /print\s*labels?/i,
    saveButton: /^(save|save changes|update|update item|save item)$/i,
    priceLabel: /^(selling\s*)?price(\s*\(\$\))?\s*\*?$/i,
    successToast: /(success|created|updated|saved)/i,
    errorToast: /(error|failed|invalid|required|already exists)/i,
  };

  function applyOverrides(o) {
    if (!o) return;
    Object.keys(o).forEach((k) => {
      if (!o[k]) return;
      try { SEL[k] = new RegExp(o[k], 'i'); } catch (e) { /* bad pattern - ignore */ }
    });
  }

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const lc = (s) => norm(s).toLowerCase();

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  async function waitFor(fn, timeout, step) {
    const end = Date.now() + (timeout || 8000);
    while (Date.now() < end) {
      let v;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(step || 150);
    }
    return null;
  }

  function setValue(el, value) {
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function blur(el) {
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    if (el.blur) el.blur();
  }

  function realClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  function clickable(el) {
    return el.closest('button,[role="button"],[role="combobox"],a,label') || el;
  }

  function findByText(re, scope, selector) {
    if (selector) {
      // Looking for a button/link: match the button itself, even when its text sits in an inner <span>
      // (e.g. <button><svg/><span>Add Row</span></button>). Prefer an enabled one.
      const els = Array.from((scope || document).querySelectorAll(selector)).filter((e) => visible(e) && re.test(norm(e.textContent)));
      return els.find((e) => !e.disabled && e.getAttribute('aria-disabled') !== 'true') || els[0];
    }
    const els = Array.from((scope || document).querySelectorAll('button,[role="button"],a,span,div,li,p'));
    return els.find((e) => visible(e) && re.test(norm(e.textContent)) && !Array.from(e.children).some((c) => re.test(norm(c.textContent))));
  }

  function inputs(scope) {
    return Array.from((scope || document).querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]),textarea'));
  }

  function toasts() {
    const els = Array.from(document.querySelectorAll('[role="alert"],[role="status"],[data-sonner-toast],.toast,[class*="toast"],[class*="Toast"],[class*="notification"]'));
    return els.filter(visible).map((e) => norm(e.textContent)).filter(Boolean);
  }

  // ---------- page info ----------
  function pageInfo() {
    const path = location.pathname;
    let page = 'other';
    if (/\/catalog\/items\/bulk/.test(path)) page = 'bulk';
    else if (/\/catalog\/items\/?$/.test(path)) page = 'items';
    else if (/\/print\/labels/.test(path)) page = 'labels';
    else if (/\/catalog\/items\//.test(path)) page = 'item';
    else if (/login|sign-?in/i.test(path) || document.querySelector('input[type=password]')) page = 'login';
    return { ok: true, page, url: location.href, title: document.title };
  }

  // ---------- Bulk Create ----------
  function bulkRows() {
    const names = inputs().filter((i) => SEL.bulkNamePlaceholder.test(i.placeholder || ''));
    return names.map((nameInput) => {
      let row = nameInput.parentElement;
      // climb until the container also holds the category picker, but still only one item-name box
      while (row && row !== document.body) {
        const nm = inputs(row).filter((i) => SEL.bulkNamePlaceholder.test(i.placeholder || '')).length;
        if (nm > 1) { row = null; break; }
        if (row.matches('tr') || /categor/i.test(row.textContent) && inputs(row).length >= 3) break;
        row = row.parentElement;
      }
      if (!row || row === document.body) row = nameInput.closest('tr') || nameInput.parentElement.parentElement.parentElement;
      const all = inputs(row);
      const barcodeInput = all.find((i) => SEL.bulkBarcodePlaceholder.test(i.placeholder || ''));
      const after = all.filter((i) => i !== nameInput && i !== barcodeInput && !/search|variant|value|modifier/i.test(i.placeholder || ''));
      const priceInput = after.find((i) => (i.type === 'number' || /^\d*\.?\d*$/.test(i.value)) && !i.readOnly && !i.disabled) || null;
      return { row, nameInput, barcodeInput, priceInput };
    });
  }

  function bulkStatus() {
    const rows = bulkRows();
    const create = findByText(SEL.createButton, document, 'button');
    return {
      ok: true,
      rows: rows.length,
      filled: rows.filter((r) => norm(r.nameInput.value)).length,
      missingPrice: rows.filter((r) => !r.priceInput).length,
      createLabel: create ? norm(create.textContent) : null,
      addRowFound: !!findByText(SEL.addRowButton, document, 'button'),
      placeholders: Array.from(new Set(inputs().filter(visible).map((i) => i.placeholder || i.getAttribute('aria-label') || '(none)'))).slice(0, 15),
      toasts: toasts(),
    };
  }

  async function ensureRows(n, delay) {
    let guard = 0;
    while (bulkRows().length < n && guard++ < 200) {
      const btn = findByText(SEL.addRowButton, document, 'button');
      if (!btn) return { ok: false, error: 'Could not find the "+ Add Row" button.' };
      realClick(btn);
      const before = bulkRows().length;
      await waitFor(() => bulkRows().length > before, 3000);
      await sleep(delay || 150);
    }
    return { ok: bulkRows().length >= n, rows: bulkRows().length };
  }

  function categoryTrigger(row) {
    // The first dropdown in the row is Category. Before choosing it reads "Select Category".
    const leaf = findByText(SEL.categoryTriggerText, row);
    if (leaf) return clickable(leaf);
    const combos = Array.from(row.querySelectorAll('[role="combobox"],button[aria-haspopup],[aria-haspopup="listbox"]')).filter(visible);
    return combos[0] || null;
  }

  // Options of the open dropdown. Prefer the popup that holds the dropdown's own search box;
  // otherwise fall back to common listbox markup.
  function popupFrom(search) {
    let p = search.parentElement;
    for (let k = 0; k < 6 && p && p !== document.body; k++, p = p.parentElement) {
      if (leafOptions(p, search).length >= 2) return p;
    }
    return null;
  }
  function leafOptions(scope, exclude) {
    return Array.from(scope.querySelectorAll('div,li,span,button,p,[role="option"]')).filter((o) => {
      if (o === exclude || o.contains(exclude) || !visible(o)) return false;
      const t = norm(o.textContent);
      if (!t || t.length > 60 || o.querySelector('input')) return false;
      // leaf-ish: no child element carries the same text
      return !Array.from(o.children).some((c) => norm(c.textContent) === t);
    });
  }
  let currentPopup = null;
  function openOptions() {
    if (currentPopup && currentPopup.isConnected) return leafOptions(currentPopup, null);
    const opts = Array.from(document.querySelectorAll('[role="option"],[role="listbox"] li,[cmdk-item]'));
    return opts.filter((o) => visible(o) && norm(o.textContent) && norm(o.textContent).length < 60);
  }

  function dropdownSearch(exclude) {
    return inputs().filter((i) => visible(i) && SEL.listSearchPlaceholder.test(i.placeholder || '') && !exclude.includes(i)).pop();
  }

  async function chooseCategory(row, category, delay) {
    const trig = categoryTrigger(row);
    if (!trig) return { ok: false, error: 'Category dropdown not found in row.' };
    const before = inputs().filter((i) => visible(i) && SEL.listSearchPlaceholder.test(i.placeholder || ''));
    realClick(trig);
    await sleep(delay || 250);
    const search = await waitFor(() => dropdownSearch(before), 2500);
    currentPopup = search ? popupFrom(search) : null;
    if (search) {
      setValue(search, category);
      await sleep(delay || 350);
    }
    const want = lc(category);
    const opt = await waitFor(() => openOptions().find((o) => lc(o.textContent) === want), 3000);
    if (!opt) {
      currentPopup = null;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { ok: false, error: 'Category "' + category + '" not in the dropdown.' };
    }
    realClick(opt);
    currentPopup = null;
    await sleep(delay || 250);
    const shown = lc(row.textContent).includes(want);
    return { ok: shown, error: shown ? undefined : 'Category did not stick for "' + category + '".' };
  }

  async function fillBulkRow(index, item, delay) {
    const rows = bulkRows();
    const r = rows[index];
    if (!r) return { ok: false, error: 'Row ' + (index + 1) + ' does not exist.' };
    setValue(r.nameInput, item.name); blur(r.nameInput);
    await sleep(60);
    if (item.barcode) {
      if (!r.barcodeInput) return { ok: false, error: 'Barcode box not found in row ' + (index + 1) };
      setValue(r.barcodeInput, item.barcode); blur(r.barcodeInput);
    }
    await sleep(60);
    if (!r.priceInput) return { ok: false, error: 'Price box not found in row ' + (index + 1) };
    setValue(r.priceInput, Number(item.price).toFixed(2)); blur(r.priceInput);
    await sleep(80);
    if (item.category) {
      const c = await chooseCategory(r.row, item.category, delay);
      if (!c.ok) return Object.assign(c, { row: index + 1 });
    }
    // read back
    const fresh = bulkRows()[index];
    const okName = norm(fresh.nameInput.value) === norm(item.name);
    const okPrice = Math.abs(parseFloat(fresh.priceInput.value) - Number(item.price)) < 0.001;
    return { ok: okName && okPrice, row: index + 1, error: okName && okPrice ? undefined : 'Values did not stick in row ' + (index + 1) };
  }

  async function bulkGetCategories() {
    const r = bulkRows()[0];
    if (!r) return { ok: false, error: 'Open Catalog > Items > Bulk Create Items first.' };
    const trig = categoryTrigger(r.row);
    if (!trig) return { ok: false, error: 'Category dropdown not found.' };
    const before = inputs().filter((i) => visible(i) && SEL.listSearchPlaceholder.test(i.placeholder || ''));
    realClick(trig);
    await sleep(500);
    const search = await waitFor(() => dropdownSearch(before), 2500);
    currentPopup = search ? popupFrom(search) : null;
    const seen = new Set();
    let list = null;
    for (let i = 0; i < 40; i++) {
      const opts = openOptions();
      opts.forEach((o) => seen.add(norm(o.textContent)));
      if (!list && opts[0]) {
        let p = opts[0].parentElement;
        while (p && p.scrollHeight <= p.clientHeight + 2 && p !== document.body) p = p.parentElement;
        list = p;
      }
      if (!list || list === document.body) break;
      const prev = list.scrollTop;
      list.scrollTop = prev + list.clientHeight * 0.8;
      await sleep(150);
      if (list.scrollTop === prev) break;
    }
    currentPopup = null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (search) search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(150);
    if (search && search.isConnected && visible(search)) realClick(trig);
    await sleep(200);
    const cats = Array.from(seen).filter((c) => c && !/^search$/i.test(c) && !/select category/i.test(c));
    return { ok: cats.length > 0, categories: cats };
  }

  // Throw away a half-filled Bulk Create page: press Cancel and accept any "discard changes?" question.
  async function cancelBulk(delay) {
    const btn = findByText(/^cancel$/i, document, 'button,a,[role="button"]');
    if (btn) {
      realClick(btn);
      await sleep(delay || 500);
      const ok = await waitFor(() => findByText(/^(discard|discard changes|yes|leave|confirm|ok|cancel anyway)$/i, document.querySelector('[role="dialog"],[role="alertdialog"],.modal,[class*="dialog"],[class*="Dialog"]') || document, 'button'), 1500);
      if (ok) { realClick(ok); await sleep(delay || 500); }
    }
    // clear any leftover rows so a reload can't ask to keep them
    bulkRows().forEach((r) => { setValue(r.nameInput, ''); if (r.barcodeInput) setValue(r.barcodeInput, ''); });
    return { ok: true, pressedCancel: !!btn };
  }

  function clickCreate() {
    const btn = findByText(SEL.createButton, document, 'button');
    if (!btn) return { ok: false, error: 'Could not find the "Create N Items" button.' };
    const label = norm(btn.textContent);
    realClick(btn);
    return { ok: true, clicked: label };
  }

  // ---------- Items list ----------
  function listSearchInput() {
    return inputs().find((i) => visible(i) && SEL.listSearchPlaceholder.test(i.placeholder || ''));
  }

  function headerIndex() {
    const ths = Array.from(document.querySelectorAll('thead th, [role="columnheader"]'));
    const idx = (re) => ths.findIndex((t) => re.test(norm(t.textContent)));
    return { name: idx(/item name/i), price: idx(/price/i) };
  }

  function listRows() {
    let rows = Array.from(document.querySelectorAll('tbody tr, [role="row"]')).filter((r) => visible(r) && !r.querySelector('th'));
    const h = headerIndex();
    return rows.map((tr, i) => {
      const cells = Array.from(tr.querySelectorAll('td,[role="cell"],[role="gridcell"]'));
      const name = h.name >= 0 && cells[h.name] ? norm(cells[h.name].textContent) : '';
      const priceTxt = h.price >= 0 && cells[h.price] ? norm(cells[h.price].textContent) : (norm(tr.textContent).match(/\$\s?\d+(\.\d+)?/) || [''])[0];
      const cb = tr.querySelector('input[type=checkbox],[role="checkbox"],button[aria-checked]');
      const checked = cb ? (cb.checked === true || cb.getAttribute('aria-checked') === 'true' || cb.getAttribute('data-state') === 'checked') : false;
      const link = tr.querySelector('a[href*="/catalog/items/"]');
      return { i, el: tr, name, price: parseFloat(String(priceTxt).replace(/[^0-9.]/g, '')), checkbox: cb, checked, href: link ? link.href : '' };
    }).filter((r) => r.name);
  }

  function readListRows() {
    return { ok: true, rows: listRows().map(({ i, name, price, checked, href }) => ({ i, name, price, checked, href })) };
  }

  async function searchList(q, delay) {
    const s = listSearchInput();
    if (!s) return { ok: false, error: 'Items search box not found. Open Catalog > Items.' };
    const before = JSON.stringify(listRows().map((r) => r.name));
    setValue(s, q);
    s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    s.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await sleep(delay || 600);
    await waitFor(() => JSON.stringify(listRows().map((r) => r.name)) !== before, 4000);
    await sleep(300);
    return readListRows();
  }

  function findRow(name) {
    const rows = listRows();
    const want = lc(name);
    let r = rows.find((x) => lc(x.name) === want);
    if (!r) {
      const c = rows.filter((x) => lc(x.name).includes(want) || want.includes(lc(x.name)));
      if (c.length === 1) r = c[0];
    }
    return r || null;
  }

  // allowSingle: after searching by barcode the list shows only that item, so the single row is the one
  async function tickRow(name, allowSingle) {
    let r = findRow(name);
    if (!r && allowSingle) {
      const rows = listRows();
      if (rows.length === 1) r = rows[0];
      else if (rows.length > 1) return { ok: false, error: rows.length + ' items match "' + name + '" - use the item name instead.' };
    }
    if (!r) return { ok: false, error: 'Not found in Catalog > Items (search showed ' + listRows().length + ' rows).' };
    if (!r.checkbox) return { ok: false, error: 'No checkbox in the row for "' + name + '".' };
    if (!r.checked) {
      realClick(r.checkbox.closest('label') || r.checkbox);
      await sleep(250);
    }
    const again = findRow(name);
    return { ok: !!(again && again.checked), name: r.name, error: again && again.checked ? undefined : 'Checkbox did not tick for "' + name + '".' };
  }

  function clickPrintLabels() {
    const btn = findByText(SEL.printLabelsButton, document, 'button,a,[role="button"]');
    if (!btn) return { ok: false, error: 'Print labels button not found (tick at least one item first).' };
    realClick(btn);
    return { ok: true };
  }

  async function nextPage(delay) {
    const cands = Array.from(document.querySelectorAll('button,a,li,[role="button"]')).filter(visible);
    let next = cands.find((b) => /next/i.test(b.getAttribute('aria-label') || '') || /^(›|>|»|next)$/i.test(norm(b.textContent)));
    if (!next) return { ok: false, last: true };
    const disabled = next.disabled || next.getAttribute('aria-disabled') === 'true' || /disabled/.test(next.className);
    if (disabled) return { ok: false, last: true };
    const before = JSON.stringify(listRows().map((r) => r.name));
    realClick(next);
    const changed = await waitFor(() => JSON.stringify(listRows().map((r) => r.name)) !== before, 5000);
    await sleep(delay || 300);
    return { ok: !!changed, last: !changed };
  }

  async function openItem(name, delay) {
    const r = findRow(name);
    if (!r) return { ok: false, error: 'No exact match for "' + name + '".' };
    if (r.href) { location.href = r.href; return { ok: true, navigating: true }; }
    const cells = Array.from(r.el.querySelectorAll('td,[role="cell"]'));
    const h = headerIndex();
    const target = (h.name >= 0 && cells[h.name]) || r.el;
    realClick(target.querySelector('a,button,span,p,div') || target);
    await sleep(delay || 800);
    return { ok: true };
  }

  // ---------- item edit ----------
  function priceInputOnEdit() {
    const labels = Array.from(document.querySelectorAll('label,span,p,div')).filter((l) => visible(l) && SEL.priceLabel.test(norm(l.textContent)) && l.children.length <= 2);
    for (const l of labels) {
      if (l.htmlFor) { const el = document.getElementById(l.htmlFor); if (el) return el; }
      let p = l.parentElement;
      for (let k = 0; k < 3 && p; k++, p = p.parentElement) {
        const ins = inputs(p).filter((i) => visible(i) && !i.disabled && !i.readOnly);
        if (ins.length === 1) return ins[0];
        if (ins.length > 1) {
          const after = ins.find((i) => l.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING);
          if (after) return after;
        }
      }
    }
    return null;
  }

  function readEditPrice() {
    const el = priceInputOnEdit();
    return el ? { ok: true, price: parseFloat(el.value) } : { ok: false, error: 'Price box not found on this page.' };
  }

  async function setEditPrice(price, delay) {
    const el = await waitFor(priceInputOnEdit, 6000);
    if (!el) return { ok: false, error: 'Price box not found on the item page.' };
    const old = el.value;
    setValue(el, Number(price).toFixed(2)); blur(el);
    await sleep(delay || 300);
    const btn = findByText(SEL.saveButton, document, 'button');
    if (!btn) return { ok: false, error: 'Save/Update button not found.', old };
    realClick(btn);
    const msg = await waitFor(() => toasts().find((t) => SEL.successToast.test(t) || SEL.errorToast.test(t)), 6000);
    if (msg && SEL.errorToast.test(msg) && !SEL.successToast.test(msg)) return { ok: false, error: msg, old };
    return { ok: true, old, message: msg || 'saved (no message shown)' };
  }

  // ---------- backup helpers ----------
  // Links in the Back Office menu (same site only, never log-out).
  function menuLinks() {
    const seen = new Set();
    const out = [];
    Array.from(document.querySelectorAll('nav a[href], aside a[href], a[href]')).forEach((a) => {
      let u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { return; }
      if (u.origin !== location.origin) return;
      const path = u.pathname.replace(/\/+$/, '') || '/';
      if (/log-?out|sign-?out|logout|delete|remove|print|export|download|new$|create|add$|bulk/i.test(path)) return;
      if (/\/[0-9a-f]{8}-[0-9a-f]{4}-|\/\d{3,}$/i.test(path)) return;      // single records, not lists
      if (seen.has(path)) return;
      seen.add(path);
      out.push({ path, text: norm(a.textContent).slice(0, 60) });
    });
    return { ok: true, links: out };
  }

  // Any table on the page: headers + rows of text.
  function readTable() {
    const tables = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]')).filter(visible);
    const out = [];
    tables.forEach((t) => {
      const heads = Array.from(t.querySelectorAll('thead th, [role="columnheader"]')).map((h) => norm(h.textContent));
      const rows = Array.from(t.querySelectorAll('tbody tr, [role="row"]')).filter((r) => !r.querySelector('th') && visible(r))
        .map((r) => Array.from(r.querySelectorAll('td, [role="cell"], [role="gridcell"]')).map((c) => {
          const inp = c.querySelector('input:not([type=checkbox]),select,textarea');
          const sw = c.querySelector('[role="switch"],button[aria-checked],input[type=checkbox]');
          if (inp) return norm(inp.value);
          if (sw && !norm(c.textContent)) return (sw.checked || sw.getAttribute('aria-checked') === 'true' || sw.getAttribute('data-state') === 'checked') ? 'on' : 'off';
          return norm(c.textContent);
        }))
        .filter((cells) => cells.some((x) => x));
      if (rows.length) out.push({ headers: heads, rows });
    });
    return { ok: true, tables: out, title: norm((document.querySelector('h1,h2') || {}).textContent || document.title) };
  }

  // ---------- captured catalogue ----------
  function captured() {
    try { return { ok: true, items: Object.values(JSON.parse(localStorage.getItem('__csb_items') || '{}')) }; } catch (e) {
      return { ok: true, items: [] };
    }
  }

  function clearCaptured() {
    localStorage.removeItem('__csb_items');
    return { ok: true };
  }

  root.CSB_POSPORT = {
    SEL, applyOverrides, pageInfo, bulkStatus, ensureRows, fillBulkRow, bulkGetCategories, clickCreate, cancelBulk,
    readListRows, searchList, tickRow, clickPrintLabels, nextPage, openItem, readEditPrice, setEditPrice,
    captured, clearCaptured, toasts, menuLinks, readTable,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
