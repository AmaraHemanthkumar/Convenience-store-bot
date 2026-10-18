/*
 * Convenience Store Bot - supplier invoice reader.
 * Turns a text-based invoice PDF (e.g. The Distributors Brisbane / ACR Tradetalk) into item lines:
 * description, qty shipped/short, barcode, item code, RRP or status, sold as, units per outer,
 * GST %, price per outer (ex/inc levy), extended cost inc GST and the real cost per unit inc GST.
 * pdfToLines() needs pdf.js (window.pdfjsLib); parseInvoice() is plain text and works anywhere.
 */
(function (root) {
  'use strict';

  const NUM = /^-?\d+(?:\.\d+)?$/;
  const STATUS = /^(OUT OF STOCK|SUPPLIER LATE|DELETED|DISCONTINUED|NOT AVAILABLE|UNAVAILABLE|N\/A)$/i;
  // desc · shipped · [short] · [barcode] · code · RRP|status · sold as · units · [gst%] · rest
  const LINE = new RegExp(
    '^(.+?)\\s+(\\d+\\.\\d{3})\\s+(?:(\\d+\\.\\d{3})\\s+)?(?:(\\d{8,14})\\s+)?([A-Z0-9]{3,8})\\s+' +
    '(\\d+\\.\\d{2}|OUT OF STOCK|SUPPLIER LATE|Deleted|DELETED|DISCONTINUED|[A-Z][A-Za-z ]{2,20}?)\\s+' +
    '(OUTER|UNIT|EACH|CTN|CARTON|CASE|PACK|SHRINK|DOZ)\\s+(\\d+)(?:\\s+(\\d+\\.\\d{2}))?(.*)$', 'i');

  function parseLine(line) {
    const m = String(line).replace(/\s+/g, ' ').trim().match(LINE);
    if (!m) return null;
    const [, desc, shipped, short, barcode, code, rrpOrStatus, soldAs, units, gst, rest] = m;
    if (/^(item description|qty|barcode)/i.test(desc)) return null;
    const restTokens = (rest || '').trim().split(' ').filter(Boolean);
    const promo = restTokens.filter((t) => /^\$/.test(t) || /%$/.test(t)).join(' ');
    const nums = restTokens.filter((t) => NUM.test(t)).map(Number);
    const noCharge = /NO CHARGE/i.test(rest || '');
    let priceEx = null, levy = 0, priceInc = null, extIncLevy = null, gstAmt = null, extIncGst = null;
    if (nums.length >= 5) {
      priceEx = nums[0];
      levy = nums.length >= 6 ? nums[1] : 0;
      priceInc = nums[nums.length - 4];
      extIncLevy = nums[nums.length - 3];
      gstAmt = nums[nums.length - 2];
      extIncGst = nums[nums.length - 1];
    } else if (nums.length) {
      priceEx = nums[0]; priceInc = nums[0]; extIncGst = noCharge ? 0 : null;
    }
    const qShip = Number(shipped), qShort = short ? Number(short) : 0;
    const per = /^UNIT|EACH$/i.test(soldAs) ? 1 : Number(units) || 1;   // price is per outer, or per unit
    const gstRate = gst ? Number(gst) / 100 : 0;
    const status = STATUS.test(rrpOrStatus) || !/^\d/.test(rrpOrStatus) ? rrpOrStatus.toUpperCase() : '';
    const rrp = status ? null : Number(rrpOrStatus) || null;
    // part outers are printed as 0.333 / 0.667 etc. -> snap to whole units (0.333 x 12 = 4)
    const toUnits = (q) => { const u = q * per; const r = Math.round(u); return Math.abs(u - r) < 0.05 ? r : Math.round(u * 1000) / 1000; };
    const gotUnits = toUnits(qShip);
    let unitCost = null;                                             // what one unit really cost, inc GST and levy
    if (priceInc !== null) unitCost = priceInc * (1 + gstRate) / per;
    if (extIncGst && gotUnits > 0) unitCost = extIncGst / gotUnits;
    return {
      desc: desc.trim(), shipped: qShip, short: qShort, barcode: barcode || '', code,
      rrp, status, soldAs: soldAs.toUpperCase(), units: Number(units) || 1, gst: gst ? Number(gst) : null,
      promo, priceEx, levy, priceInc, extIncGst, noCharge,
      unitsReceived: gotUnits,
      unitsShort: toUnits(qShort),
      unitCost: unitCost === null ? null : Math.round(unitCost * 10000) / 10000,
    };
  }

  function parseInvoice(lines) {
    const text = lines.join('\n');
    const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : ''; };
    const items = [];
    const seen = new Set();
    lines.forEach((l) => {
      const it = parseLine(l);
      if (!it) return;
      const key = (it.barcode || it.code) + '|' + it.desc + '|' + it.shipped;
      if (seen.has(key)) return;              // same line printed twice (page headers repeat)
      seen.add(key);
      items.push(it);
    });
    // fees such as "Service Handling Fee  9.00  0.90  9.90" (last number = inc GST)
    const fees = [];
    lines.forEach((l) => {
      const m = String(l).replace(/\s+/g, ' ').trim().match(/^(.*?(?:fee|freight|delivery charge|surcharge|handling)[^0-9]*)\s+(\d+\.\d{2})(?:\s+(\d+\.\d{2}))?\s+(\d+\.\d{2})$/i);
      if (m && !/total|amount|balance/i.test(m[1])) fees.push({ desc: m[1].trim(), amount: Number(m[4]) });
    });
    const itemsTotal = items.reduce((a, x) => a + (x.extIncGst || 0), 0);
    return {
      fees, itemsTotal,
      supplier: pick(/^\s*([A-Z][A-Za-z&' ]+(?:Pty Ltd|Pty\.? Ltd\.?|Limited|Ltd))/m) || pick(/(The Distributors[A-Za-z ]*)/),
      number: pick(/Document No:?\s*(\S+)/i) || pick(/Invoice (?:No|Number):?\s*(\S+)/i),
      date: pick(/Transaction Date:?\s*([0-9]{1,2} [A-Za-z]{3} [0-9]{4})/i) || pick(/Date:?\s*([0-9/.-]{8,10})/),
      items,
      total: itemsTotal + fees.reduce((a, f) => a + f.amount, 0),
      printedTotal: Number((pick(/Total Inc GST\s+\$?([\d,]+\.\d{2})/i) || '').replace(/,/g, '')) || null,
    };
  }

  // PDF -> lines of text, rebuilt from the positions of the words on each page.
  async function pdfToLines(arrayBuffer) {
    const pdfjs = root.pdfjsLib;
    if (!pdfjs) throw new Error('PDF reader not loaded');
    const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      // use the page as it is shown (many invoices are landscape pages stored rotated)
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const rows = [];
      tc.items.forEach((it) => {
        if (!it.str || !it.str.trim()) return;
        const t = pdfjs.Util.transform(vp.transform, it.transform);
        const x = t[4], y = t[5];                       // y grows downwards here
        let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
        if (!row) { row = { y, parts: [] }; rows.push(row); }
        row.parts.push({ x, s: it.str });
      });
      rows.sort((a, b) => a.y - b.y).forEach((r) => lines.push(r.parts.sort((a, b) => a.x - b.x).map((q) => q.s.trim()).join('  ')));
    }
    return lines;
  }

  // Supplier short-hand -> readable product name ("NES KIT KAT CHUNKY KING 70G" -> "Nestle Kit Kat Chunky King 70g")
  const PREFIX = { 'NES': 'Nestle', 'CAD': 'Cadbury', 'WRIG': 'Wrigley', 'FERR': 'Ferrero', 'KELL': 'Kelloggs', 'SMT': 'Smiths',
    'SBA': '', 'M/F': '', 'U/C': '', 'L/L': 'Lolly Land', 'G/C': '', 'S/A': '', 'R/F': '', 'UCC': '', 'A/B': '', 'SCH': 'Schweppes',
    'B/BERG': 'Bundaberg', 'NUTR/W': 'Nutrient Water', 'CHUPA': 'Chupa', 'FISH/FRIEND': "Fisherman's Friend", 'ALLENS': 'Allens' };
  const WORDS = { 'CHKN': 'Chicken', 'CHOC': 'Choc', 'S/CREAM': 'Sour Cream', 'S/CRM': 'Sour Cream', 'SW/CHILLI': 'Sweet Chilli',
    'S/F': 'Sugar Free', 'S/FREE': 'Sugar Free', 'C/NUT': 'Coconut', 'CH/BACON': 'Cheese & Bacon', 'R/C': 'Ridge Cut', 'NDL': 'Noodle', 'NDLS': 'Noodles' };
  function tidyName(desc) {
    let w = String(desc || '').replace(/\*+/g, ' ').replace(/\(\d+\)?$/, '').replace(/\(\d+\s*$/, '').replace(/\s+/g, ' ').trim().split(' ');
    if (w.length > 1 && Object.prototype.hasOwnProperty.call(PREFIX, w[0].toUpperCase())) {
      const rep = PREFIX[w[0].toUpperCase()];
      w = rep ? [rep].concat(w.slice(1)) : w.slice(1);
    }
    w = w.map((x) => WORDS[x.toUpperCase()] || x);
    // move a leading size ("160G SOUR STRAPS") to the end
    const si = w.findIndex((x) => /^\d+(\.\d+)?(G|KG|ML|L)$/i.test(x));
    if (si >= 0 && si < w.length - 1 && w.length > 2) { const sz = w.splice(si, 1)[0]; w.push(sz); }
    return w.join(' ').toLowerCase().replace(/(^|[\s\-/(&])([a-z])/g, (m, p, c) => p + c.toUpperCase())
      .replace(/\b(\d+(?:\.\d+)?)(G|Kg|Ml|L|Pk|S)\b/gi, (m, n, u) => n + (u.toLowerCase() === 'l' ? 'L' : u.toLowerCase()));
  }

  root.CSB_INVOICE = { parseLine, parseInvoice, pdfToLines, tidyName };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CSB_INVOICE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
