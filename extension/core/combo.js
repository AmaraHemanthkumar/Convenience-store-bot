// Fills PosPort's Create Combo page (Catalog › Items › Combos › + Add Combo) from an offer.
// It never presses Save – you look at the filled form and press Save yourself.
// Runs inside the PosPort tab (chrome.scripting): one function, everything it needs inside it.
(function (root) {
  async function fillCombo(offer) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const setInput = (el, v) => {
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur();
    };
    const setSelect = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const press = (el) => {
      const o = { bubbles: true, cancelable: true, view: window, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); el.click();
    };
    const waitFor = async (fn, ms) => { const end = Date.now() + (ms || 5000); while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(150); } return null; };
    const leaves = (text) => Array.from(document.querySelectorAll('main *, form *, body *')).filter((e) => !e.children.length && norm(e.textContent) === norm(text) && !e.closest('nav, aside'));
    const triggerAfter = (labelText, k) => {
      const labs = leaves(labelText).filter((l) => !l.closest('[data-testid^="sidebar"]'));
      const trig = labs.map((l) => { let p = l; for (let i = 0; i < 4 && p; i++) { p = p.parentElement; const t = p && p.querySelector('[data-slot="popover-trigger"]'); if (t) return t; } return null; }).filter(Boolean);
      return trig[k] || null;
    };
    const openDialog = (placeholder) => Array.from(document.querySelectorAll('[role=dialog]')).find((d) => d.querySelector('input[placeholder="' + placeholder + '"]'));
    const closeDialogs = async () => {
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await sleep(400);
    };
    const report = { ok: true, missing: [], slots: 0 };

    if (!/\/catalog\/combo/.test(location.pathname)) return { ok: false, error: 'Not on the Create Combo page.' };
    // ---- top of the form ----
    const nameIn = await waitFor(() => document.querySelector('input[placeholder="Enter Name"]'), 8000);
    if (!nameIn) return { ok: false, error: 'The Create Combo form did not show (no Name box).' };
    setInput(nameIn, offer.name);
    const catSel = document.querySelector('select[required]') || document.querySelector('select');
    if (catSel && offer.category) {
      const opt = Array.from(catSel.options).find((o) => norm(o.text) === norm(offer.category));
      if (opt) setSelect(catSel, opt.value); else report.missing.push('category "' + offer.category + '" (pick it yourself)');
    }
    const priceIn = document.querySelector('input[placeholder="Enter Price"]');
    if (priceIn) setInput(priceIn, offer.price);
    await sleep(400);

    // ---- slots ----
    for (let k = 0; k < offer.slots.length; k++) {
      const slot = offer.slots[k];
      const have = document.querySelectorAll('span[aria-label="Slot settings"]').length;
      if (have <= k) {
        const add = leaves('Add slot').concat(leaves('+ Add slot'))[0];
        if (!add) return Object.assign(report, { ok: false, error: '"Add slot" button not found.' });
        press(add.closest('button,[role=button]') || add);
        if (!(await waitFor(() => document.querySelectorAll('span[aria-label="Slot settings"]').length > k, 4000))) return Object.assign(report, { ok: false, error: 'Slot ' + (k + 1) + ' did not appear.' });
        await sleep(300);
      }
      // 1. categories: tick every category, so every product can be picked
      const ct = triggerAfter('Categories', k);
      if (!ct) return Object.assign(report, { ok: false, error: 'Categories picker of slot ' + (k + 1) + ' not found.' });
      press(ct);
      const cd = await waitFor(() => openDialog('Search categories'), 4000);
      if (!cd) return Object.assign(report, { ok: false, error: 'Categories list did not open.' });
      Array.from(cd.querySelectorAll('label')).forEach((l) => { const i = l.querySelector('input'); if (i && !i.checked && norm(l.textContent) !== 'select all') l.click(); });
      await sleep(400); await closeDialogs();
      // 2. products: tick each item by its exact PosPort name
      const pt = await waitFor(() => triggerAfter('Products', k), 3000);
      if (!pt) return Object.assign(report, { ok: false, error: 'Products picker of slot ' + (k + 1) + ' not found.' });
      press(pt);
      const pd = await waitFor(() => openDialog('Search products'), 4000);
      if (!pd) return Object.assign(report, { ok: false, error: 'Products list did not open.' });
      await sleep(300);
      let ticked = 0;
      for (const n of slot.items) {
        let lab = Array.from(pd.querySelectorAll('label')).find((l) => norm(l.textContent) === norm(n));
        if (!lab) {                                   // long lists may draw only part: search for it
          const s = pd.querySelector('input[placeholder="Search products"]');
          setInput(s, n); await sleep(500);
          lab = Array.from(pd.querySelectorAll('label')).find((l) => norm(l.textContent) === norm(n));
          setInput(s, ''); await sleep(300);
          if (lab) lab = Array.from(pd.querySelectorAll('label')).find((l) => norm(l.textContent) === norm(n)) || lab;
        }
        if (!lab) { report.missing.push(n); continue; }
        const box = lab.querySelector('input');
        if (box && !box.checked) lab.click();
        ticked++;
        await sleep(80);
      }
      await sleep(300); await closeDialogs();
      const addBtn = await waitFor(() => Array.from(document.querySelectorAll('button')).filter((b) => /^\+?\s*add \d+ products?$/i.test(b.textContent.trim()))[0], 3000);
      if (addBtn) { press(addBtn); await sleep(700); }
      else if (ticked) report.missing.push('(slot ' + (k + 1) + ': the "Add products" button did not appear)');
      // upgrades stay at $0 (all included); 3. how many the customer picks
      const sb = document.querySelectorAll('span[aria-label="Slot settings"]')[k];
      press(sb);
      const sd = await waitFor(() => Array.from(document.querySelectorAll('[role=dialog]')).find((d) => d.querySelector('input[type=number]') && /settings/i.test(d.textContent)), 4000);
      if (!sd) return Object.assign(report, { ok: false, error: 'Slot settings did not open.' });
      const sel = Array.from(sd.querySelectorAll('select'));
      if (sel[0]) setSelect(sel[0], 'must');
      if (sel[1]) setSelect(sel[1], 'exactly');
      await sleep(200);
      if (sel[2]) setSelect(sel[2], slot.multiples ? 'numeric' : 'boolean');
      await sleep(200);
      setInput(sd.querySelector('input[type=number]'), slot.qty);
      await sleep(250);
      const done = Array.from(sd.querySelectorAll('button')).find((b) => norm(b.textContent) === 'done');
      if (done) press(done);
      await sleep(500);
      report.slots++;
    }
    const sums = (document.body.innerText.match(/(Exactly|Up to)[^\n]*products?/g) || []);
    return Object.assign(report, { summary: sums });
  }

  root.CSB_COMBO = { fillCombo };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CSB_COMBO;
})(typeof globalThis !== 'undefined' ? globalThis : this);
