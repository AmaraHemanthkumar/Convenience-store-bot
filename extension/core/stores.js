/*
 * Convenience Store Bot - supermarket lookups.
 * These functions run INSIDE a woolworths.com.au or coles.com.au tab, so requests are
 * made by the real browser with the user's normal cookies (no bot-detection tricks).
 * Each returns plain JSON so it can be passed back to the extension or to Python.
 */
(function (root) {
  'use strict';

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.]/g, ''));
    return isFinite(n) && n > 0 ? n : null;
  }
  function regular(now, was) {
    const n = num(now), w = num(was);
    if (w && n && w > n) return w;
    return n || w || null;
  }
  function digits(s) { return String(s || '').replace(/\D/g, '').replace(/^0+/, ''); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function isBlocked(text) {
    return /captcha|are you a robot|incapsula|access denied|request unsuccessful|pardon our interruption/i.test(text || '');
  }

  // ---------------- Woolworths ----------------
  function wwMap(p) {
    const attrs = p.AdditionalAttributes || {};
    let dept = attrs.sapdepartmentname || attrs.piesdepartmentnamesjson || '';
    if (/^\[/.test(dept)) { try { dept = JSON.parse(dept).join(', '); } catch (e) { /* keep */ } }
    const now = num(p.Price) || num(p.InstorePrice);
    const was = num(p.WasPrice) || num(p.InstoreWasPrice);
    return {
      store: 'Woolworths',
      stockcode: p.Stockcode,
      name: p.DisplayName || [p.Name, p.PackageSize].filter(Boolean).join(' '),
      baseName: p.Name || '',
      size: p.PackageSize || '',
      barcode: p.Barcode || '',
      now: now,
      was: was,
      onSpecial: !!(p.IsOnSpecial || (was && now && was > now)),
      regular: regular(now, was),
      available: p.IsAvailable !== false,
      dept: [dept, attrs.sapcategoryname, attrs.sapsubcategoryname].filter(Boolean).join(' / '),
      url: p.Stockcode ? 'https://www.woolworths.com.au/shop/productdetails/' + p.Stockcode : '',
    };
  }

  async function wwSearchRaw(term) {
    const body = {
      Filters: [], IsSpecial: false, Location: '/shop/search/products?searchTerm=' + encodeURIComponent(term),
      PageNumber: 1, PageSize: 24, SearchTerm: term, SortType: 'TraderRelevance',
      IsRegisteredRewardCardPromotion: null, ExcludeSearchTypes: ['UntraceableVendors'],
      GpBoost: 0, GroupEdmVariants: true, EnableAdReRanking: false,
    };
    let res = await fetch('/apis/ui/Search/products', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      res = await fetch('/apis/ui/Search/products?searchTerm=' + encodeURIComponent(term) +
        '&pageNumber=1&pageSize=24&sortType=TraderRelevance', { credentials: 'include' });
    }
    const text = await res.text();
    if (!res.ok || isBlocked(text) && text.trim()[0] !== '{') {
      return { blocked: true, status: res.status, products: [] };
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { return { blocked: true, status: res.status, products: [] }; }
    const groups = data.Products || [];
    const products = [];
    groups.forEach((g) => (g.Products || [g]).forEach((p) => { if (p && p.Stockcode) products.push(wwMap(p)); }));
    return { blocked: false, products };
  }

  async function wwLookup(barcode, nameHint) {
    const bc = digits(barcode);
    const out = { store: 'Woolworths', found: false, match: '', candidates: [] };
    if (bc) {
      const r = await wwSearchRaw(bc);
      if (r.blocked) return Object.assign(out, { blocked: true, error: 'Woolworths blocked the request (status ' + r.status + '). Open woolworths.com.au, solve any check, then retry.' });
      const exact = r.products.find((p) => digits(p.barcode) === bc);
      if (exact) return Object.assign(out, exact, { found: true, match: 'barcode' });
      if (r.products.length === 1) return Object.assign(out, r.products[0], { found: true, match: 'only result (check)' });
      out.candidates = r.products.slice(0, 5);
    }
    if (nameHint) {
      const r = await wwSearchRaw(nameHint);
      if (!r.blocked && r.products.length) {
        const R = root.CSB_RULES;
        const best = R ? R.bestMatch(nameHint, r.products, (p) => p.name) : { item: r.products[0], score: 0.5 };
        if (best.item && best.score >= 0.55) return Object.assign(out, best.item, { found: true, match: 'name ' + Math.round(best.score * 100) + '% (check)' });
        out.candidates = r.products.slice(0, 5);
      }
    }
    return out;
  }

  // ---------------- Coles ----------------
  function colesMap(p) {
    const pr = p.pricing || {};
    const now = num(pr.now);
    const was = num(pr.was);
    const size = p.size || '';
    return {
      store: 'Coles',
      id: p.id,
      name: [p.brand, p.name, size].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      size: size,
      barcode: (p.gtin || p.barcode || '') + '',
      now: now,
      was: was,
      onSpecial: !!((was && now && was > now) || pr.promotionType || pr.onlineSpecial),
      regular: regular(now, was),
      available: p.availability !== false,
      dept: ((p.onlineHeirs || [])[0] || {}).category || '',
      url: p.id ? 'https://www.coles.com.au/product/' + (p.name || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + p.id : '',
    };
  }

  function colesBuildId() {
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (el) return JSON.parse(el.textContent).buildId;
    } catch (e) { /* ignore */ }
    return null;
  }

  function colesResultsFromNext(json) {
    const pp = (json && (json.pageProps || (json.props && json.props.pageProps))) || {};
    const sr = pp.searchResults || {};
    return (sr.results || []).filter((r) => r && (r._type === 'PRODUCT' || r.pricing)).map(colesMap);
  }

  async function colesSearchRaw(term) {
    const q = encodeURIComponent(term);
    const buildId = colesBuildId();
    if (buildId) {
      const res = await fetch('/_next/data/' + buildId + '/en/search/products.json?q=' + q, { credentials: 'include' });
      const text = await res.text();
      if (res.ok && text.trim()[0] === '{') {
        try { return { blocked: false, products: colesResultsFromNext(JSON.parse(text)) }; } catch (e) { /* fall through */ }
      }
    }
    const res = await fetch('/search/products?q=' + q, { credentials: 'include' });
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return { blocked: true, status: res.status, products: [] };
    try { return { blocked: false, products: colesResultsFromNext(JSON.parse(m[1])) }; } catch (e) {
      return { blocked: true, status: res.status, products: [] };
    }
  }

  async function colesLookup(barcode, nameHint) {
    const bc = digits(barcode);
    const out = { store: 'Coles', found: false, match: '', candidates: [] };
    const R = root.CSB_RULES;
    if (bc) {
      const r = await colesSearchRaw(bc);
      if (r.blocked) return Object.assign(out, { blocked: true, error: 'Coles blocked the request. Open coles.com.au, solve any check, then retry.' });
      const exact = r.products.find((p) => digits(p.barcode) === bc);
      if (exact) return Object.assign(out, exact, { found: true, match: 'barcode' });
      if (r.products.length === 1) return Object.assign(out, r.products[0], { found: true, match: 'only result (check)' });
      if (nameHint && r.products.length && R) {
        const b = R.bestMatch(nameHint, r.products, (p) => p.name);
        if (b.item && b.score >= 0.6) return Object.assign(out, b.item, { found: true, match: 'name ' + Math.round(b.score * 100) + '% (check)' });
      }
    }
    if (nameHint) {
      await sleep(400);
      const r = await colesSearchRaw(nameHint);
      if (r.blocked) return Object.assign(out, { blocked: true, error: 'Coles blocked the request. Open coles.com.au, solve any check, then retry.' });
      if (r.products.length) {
        const b = R ? R.bestMatch(nameHint, r.products, (p) => p.name) : { item: r.products[0], score: 0.5 };
        if (b.item && b.score >= 0.6) return Object.assign(out, b.item, { found: true, match: 'name ' + Math.round(b.score * 100) + '% (check)' });
        out.candidates = r.products.slice(0, 5);
      }
    }
    return out;
  }

  root.CSB_STORES = { wwLookup, colesLookup, wwSearchRaw, colesSearchRaw };
})(typeof globalThis !== 'undefined' ? globalThis : this);
