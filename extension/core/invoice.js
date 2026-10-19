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
    const fees = feesOf(lines);
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

  // PDF -> words with their position on each page (as the page is shown; many invoices are rotated landscape pages)
  async function pdfToPages(arrayBuffer) {
    const pdfjs = root.pdfjsLib;
    if (!pdfjs) throw new Error('PDF reader not loaded');
    const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const pieces = [];
      tc.items.forEach((it) => {
        if (!it.str || !it.str.trim()) return;
        const t = pdfjs.Util.transform(vp.transform, it.transform);
        pieces.push({ x: t[4], y: t[5], s: it.str.trim(), w: it.width || 0 });   // y grows downwards
      });
      pages.push(pieces);
    }
    return pages;
  }
  // words -> lines (same height on the page), each line keeps its words with x positions
  function piecesToRows(pieces, tol) {
    const rows = [];
    pieces.slice().sort((a, b) => a.y - b.y).forEach((pc) => {
      let row = rows.find((r) => Math.abs(r.y - pc.y) < (tol || 2.5));
      if (!row) { row = { y: pc.y, parts: [] }; rows.push(row); }
      row.parts.push(pc);
    });
    rows.sort((a, b) => a.y - b.y).forEach((r) => {
      r.parts.sort((a, b) => a.x - b.x);
      r.text = r.parts.map((q) => q.s).join('  ');
    });
    return rows;
  }
  async function pdfToLines(arrayBuffer) {
    const pages = await pdfToPages(arrayBuffer);
    return [].concat(...pages.map((pc) => piecesToRows(pc).map((r) => r.text)));
  }

  // ---------- shop-style invoices: Woolworths / Coles online orders and similar ----------
  // A table with columns like  [Line] Description | Ordered | Supplied/Picked | Price | Amount/Total.
  // No barcodes, and the numbers often sit a little lower than their description, so rows are matched up
  // by order on the page, not by exact height.
  const money = (t) => { const v = String(t).replace(/[$,\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null; };
  const CATEGORY = (t) => t.split(/\s+/).length <= 5 && !/\d/.test(t) && !/^[*%#]/.test(t);
  const SKIP = /^(product|description|item|line|ordered|supplied|picked|qty|quantity|price|unit price|amount|total charged|supplied items?|substitut\w*|page \d+)/i;
  const FOOT = /(sub-?total|total|gst|delivery|bag|fee|discount|savings|voucher|balance|paid|payment|refund)/i;

  function findHeader(row) {
    const col = {};
    row.parts.forEach((pc) => {
      const t = pc.s.toLowerCase();
      if (/^line$/.test(t)) col.line = pc.x;
      else if (/^(description|product|item description|item)$/.test(t)) col.desc = pc.x;
      else if (/^(ordered|qty ordered|order qty)$/.test(t)) col.ordered = pc.x;
      else if (/^(supplied|picked|delivered|qty supplied)$/.test(t)) col.supplied = pc.x;
      else if (/^(price|unit price|each)$/.test(t)) col.price = pc.x;
      else if (/^(amount|total charged|total|line total)$/.test(t)) col.amount = pc.x;
    });
    return col.ordered !== undefined && col.supplied !== undefined && (col.price !== undefined || col.amount !== undefined) ? col : null;
  }

  function parseTableInvoice(pages, lines) {
    const items = [];
    let col = null;
    let pending = null;          // description waiting for its numbers
    let orphan = null;           // numbers waiting for their description (printed slightly higher)
    const close = (desc, nums, extra) => {
      const d = desc.replace(/^[*%#]\s*/, '').replace(/\s+/g, ' ').trim();
      if (!d) return;
      const ordered = nums.ordered, supplied = nums.supplied !== null ? nums.supplied : nums.ordered;
      const price = nums.price, amount = nums.amount !== null ? nums.amount : (price !== null && supplied !== null ? Math.round(price * supplied * 100) / 100 : null);
      const unitCost = supplied > 0 && amount !== null ? amount / supplied : price;
      items.push({
        desc: d, marker: (desc.match(/^[*%#]/) || [''])[0], line: extra.line || '',
        shipped: supplied || 0, short: Math.max(0, (ordered || 0) - (supplied || 0)), barcode: '', code: extra.line || '',
        rrp: null, status: supplied === 0 ? 'NOT SUPPLIED' : '', soldAs: 'EACH', units: 1, gst: null, promo: '',
        priceEx: null, levy: 0, priceInc: price, extIncGst: amount, noCharge: supplied > 0 && amount === 0,
        ordered: ordered || 0, unitsReceived: supplied || 0, unitsShort: Math.max(0, (ordered || 0) - (supplied || 0)),
        unitCost: unitCost === null || unitCost === undefined ? null : Math.round(unitCost * 10000) / 10000,
      });
    };
    pages.forEach((pieces) => {
      piecesToRows(pieces).forEach((row) => {
        const h = findHeader(row);
        if (h) { col = h; pending = null; orphan = null; return; }
        if (!col) return;
        const left = col.ordered - 8;
        const textParts = row.parts.filter((pc) => pc.x < left);
        const numParts = row.parts.filter((pc) => pc.x >= left);
        // numbers: put each one in the nearest column
        let nums = null;
        const vals = numParts.map((pc) => ({ x: pc.x, v: money(pc.s), w: pc.w })).filter((q) => q.v !== null);
        if (vals.length >= 3 && vals.length === numParts.length) {
          nums = { ordered: null, supplied: null, price: null, amount: null };
          vals.forEach((q) => {
            const cx = q.x + q.w / 2;
            const best = ['ordered', 'supplied', 'price', 'amount'].filter((k) => col[k] !== undefined)
              .sort((a, b) => Math.abs(col[a] - q.x) + Math.abs(col[a] - cx) - Math.abs(col[b] - q.x) - Math.abs(col[b] - cx))[0];
            if (nums[best] === null) nums[best] = q.v;
          });
        }
        // text: line number, description, category headings, totals
        let text = textParts.map((pc) => pc.s).join(' ').replace(/\s+/g, ' ').trim();
        let lineNo = '';
        if (col.line !== undefined && textParts.length && /^\d{1,4}$/.test(textParts[0].s) && textParts[0].x < (col.desc || col.ordered) - 4) {
          lineNo = textParts[0].s; text = textParts.slice(1).map((pc) => pc.s).join(' ').trim();
        }
        if (text && (FOOT.test(text) && !lineNo && !/^[*%#]/.test(text) && (!nums || CATEGORY(text)))) { pending = null; orphan = null; return; }
        if (text && SKIP.test(text) && !lineNo) text = '';
        if (text) {
          const isCat = !lineNo && CATEGORY(text) && (col.line !== undefined || !nums);
          if (isCat) text = '';
        }
        if (text) {
          if (orphan && !nums) { close(text, orphan.nums, { line: lineNo || orphan.line }); orphan = null; return; }
          // the second line of a long description, printed under the item's numbers
          const last = items[items.length - 1];
          if (col.line !== undefined && !lineNo && !nums && !pending && last && last.line && row.y - last.y < 16) { last.desc += ' ' + text; return; }
          const startsNew = lineNo || col.line === undefined || /^[*%#]/.test(text) || !pending;
          if (startsNew) pending = { desc: text, line: lineNo };
          else pending.desc += ' ' + text;          // a long description wrapped onto a second line
        }
        if (nums) {
          if (pending) { close(pending.desc, nums, { line: pending.line }); items[items.length - 1].y = row.y; pending = null; }
          else orphan = { nums, line: lineNo };
        }
      });
    });
    const text = lines.join('\n');
    const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : ''; };
    const supplier = /woolworths/i.test(text) ? 'Woolworths' : /coles/i.test(text) ? 'Coles' : /aldi/i.test(text) ? 'ALDI' :
      pick(/^\s*([A-Z][A-Za-z&' ]+(?:Pty Ltd|Limited|Ltd))/m) || 'Invoice';
    const fees = feesOf(lines);
    const itemsTotal = items.reduce((a, x) => a + (x.extIncGst || 0), 0);
    return {
      kind: 'table', supplier, items, fees, itemsTotal,
      number: pick(/(?:Invoice|Order)(?:\/Order)?\s*(?:No\.?|Number|#):?\s*([A-Z0-9-]{4,})/i) || pick(/Document No:?\s*(\S+)/i),
      date: pick(/\bDate:?\s*(\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4})/i) || pick(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:,?\s+\d{4})?)/),
      total: itemsTotal + fees.reduce((a, f) => a + f.amount, 0),
      printedTotal: money(pick(/(?:order total|invoice total|total charged|total \(?inc(?:l\.?|luding)? gst\)?|total paid|grand total|^\s*total)\s*:?\s*(\$?[\d,]+\.\d{2})/im)) || null,
    };
  }

  function feesOf(lines) {
    const fees = [];
    lines.forEach((l) => {
      const m = String(l).replace(/\s+/g, ' ').trim().match(/^(.*?(?:fee|freight|delivery charge|surcharge|handling)[^0-9$]*)\s+\$?(-?\d+\.\d{2})(?:\s+\$?(-?\d+\.\d{2}))?\s+\$?(-?\d+\.\d{2})$/i) ||
        String(l).replace(/\s+/g, ' ').trim().match(/^(.*?(?:delivery fee|bag fee|service fee|packaging fee)[^0-9$]*)\s+()()\$?(-?\d+\.\d{2})$/i);
      if (m && !/total|amount|balance/i.test(m[1])) fees.push({ desc: m[1].trim(), amount: Number(m[4]) });
    });
    return fees;
  }

  // ---------- Coca-Cola Europacific Partners (myCCA) invoices / delivery slips ----------
  // "955734 * 600Ml PET X24 Fanta Orange   1  $3.29  $59.67  $59.67" = material · GST mark · description ·
  // cases · container deposit per case · net per case · extended. A long description wraps onto the next line.
  // "*" = GST applies (plain water has no GST). Extended price includes the container deposit, not GST.
  const CCEP_LINE = /^(\d{5,7})\s+(\*\s*)?(.+?)\s+(-?\d+)\s*-?\$?(-?\d+\.\d{2})\s+\$?(-?\d+\.\d{2})\s+(-?\$?-?[\d,]+\.\d{2})$/;
  function ccepPack(desc) {
    const d = desc.toUpperCase();
    let m = d.match(/\b(\d+)\s*X\s*(\d+)\b/);                   // 6X4
    if (m) return Number(m[1]) * Number(m[2]);
    m = d.match(/\b(?:X|IB)\s*(\d{1,3})\b/);                     // X24, X 12, Ib24
    return m ? Number(m[1]) : 1;
  }
  function ccepName(desc) {
    let d = ' ' + desc + ' ';
    let size = '';
    const sm = d.match(/\s(\d+(?:\.\d+)?)\s*(ML|L)?(?=\s)/i);
    if (sm) { size = sm[1] + (sm[2] ? (sm[2].toUpperCase() === 'L' ? 'L' : 'ml') : (Number(sm[1]) >= 100 ? 'ml' : 'L')); d = d.replace(sm[0], ' '); }
    const can = /\sCAN\s/i.test(d);
    d = d.replace(/\s(PET|CAN|FLO|GLASS|BTL)\s/ig, ' ').replace(/\s\d+\s*X\s*\d+\s/ig, ' ').replace(/\s(?:X|IB)\s*\d{1,3}\s/ig, ' ').replace(/\s+/g, ' ').trim();
    return (d + (size ? ' ' + size : '') + (can ? ' Can' : '')).trim();
  }
  function parseCcepInvoice(lines) {
    const items = [], fees = [];
    let last = null;
    lines.forEach((raw) => {
      const l = String(raw).replace(/\s+/g, ' ').trim();
      const m = l.match(CCEP_LINE);
      if (m) {
        const [, code, star, desc, qty, cds, net, ext] = m;
        const q = Number(qty), extended = Number(ext.replace(/[,$]/g, '').replace(/^--/, '-')), gstRate = star ? 0.1 : 0;
        if (Math.abs(q) > 500 || /promo|pricing error|credit|adjust|rebate/i.test(desc)) {   // credits like "-3100 x $0.01"
          fees.push({ desc: desc.trim(), amount: Math.round(extended * (1 + gstRate) * 100) / 100 }); last = null; return;
        }
        const it = { desc: desc.trim(), code, gst: star ? 10 : 0, shipped: q, cds: Number(cds), priceEx: Number(net), extEx: extended };
        items.push(it); last = it; return;
      }
      // the second line of a wrapped description
      if (last && l && !/\$|^total|^product total|^payment|^note|^bpay|^\d{5,7}\b/i.test(l) && l.split(' ').length <= 6) { last.desc += ' ' + l; return; }
      last = null;
    });
    const out = items.map((it) => {
      const per = ccepPack(it.desc);
      const units = it.shipped * per;
      const extInc = Math.round(it.extEx * (1 + it.gst / 100) * 100) / 100;
      return {
        desc: it.desc, name: ccepName(it.desc), shipped: it.shipped, short: 0, barcode: '', code: it.code, rrp: null, status: it.shipped === 0 ? 'NOT SUPPLIED' : '',
        soldAs: 'CASE', units: per, gst: it.gst, promo: '', priceEx: it.priceEx, levy: it.cds, priceInc: it.shipped ? Math.round(extInc / it.shipped * 100) / 100 : null,
        extIncGst: extInc, noCharge: it.shipped > 0 && extInc === 0, unitsReceived: units, unitsShort: 0,
        unitCost: units > 0 ? Math.round(extInc / units * 10000) / 10000 : null,
      };
    });
    const text = lines.join('\n');
    const pick = (re) => { const mm = text.match(re); return mm ? mm[1].trim() : ''; };
    const itemsTotal = out.reduce((a, x) => a + (x.extIncGst || 0), 0);
    return {
      kind: 'ccep', supplier: 'Coca-Cola Europacific Partners', items: out, fees, itemsTotal,
      number: pick(/Tax\s+Invoice\s+(\d{6,})/i) || pick(/Reference\s+Number\s+(\d{6,})/i) || pick(/Invoice (?:No|Number):?\s*(\d{6,})/i),
      date: pick(/\bDate\s+(\d{1,2}\/\d{1,2}\/\d{4})/i),
      total: itemsTotal + fees.reduce((a, f) => a + f.amount, 0),
      printedTotal: Number((pick(/Total\s+Price\s+\$?([\d,]+\.\d{2})/i) || '').replace(/,/g, '')) || null,
    };
  }

  // Any supported invoice PDF: wholesale (Distributors-style lines with barcodes) or a shop-style table.
  async function readPdf(arrayBuffer) {
    const pages = await pdfToPages(arrayBuffer);
    const lines = [].concat(...pages.map((pc) => piecesToRows(pc).map((r) => r.text)));
    const whole = parseInvoice(lines);
    const table = parseTableInvoice(pages, lines);
    const ccep = /coca-?cola\s+europacific|mycca|CDS\s+P\/C/i.test(lines.join(' ')) ? parseCcepInvoice(lines) : { items: [] };
    let inv = table.items.length > whole.items.length ? table : Object.assign(whole, { kind: 'wholesale' });
    if (ccep.items.length >= inv.items.length) inv = ccep;
    inv.lineCount = lines.length;
    return inv;
  }

  // Supplier short-hand -> readable product name ("NES KIT KAT CHUNKY KING 70G" -> "Nestle Kit Kat Chunky King 70g")
  const PREFIX = { 'NES': 'Nestle', 'CAD': 'Cadbury', 'WRIG': 'Wrigley', 'FERR': 'Ferrero', 'KELL': 'Kelloggs', 'SMT': 'Smiths',
    'SBA': '', 'M/F': '', 'U/C': '', 'L/L': 'Lolly Land', 'G/C': '', 'S/A': '', 'R/F': '', 'UCC': '', 'A/B': '', 'SCH': 'Schweppes',
    'B/BERG': 'Bundaberg', 'NUTR/W': 'Nutrient Water', 'CHUPA': 'Chupa', 'FISH/FRIEND': "Fisherman's Friend", 'ALLENS': 'Allens' };
  const WORDS = { 'CHKN': 'Chicken', 'CHOC': 'Choc', 'S/CREAM': 'Sour Cream', 'S/CRM': 'Sour Cream', 'SW/CHILLI': 'Sweet Chilli',
    'S/F': 'Sugar Free', 'S/FREE': 'Sugar Free', 'C/NUT': 'Coconut', 'CH/BACON': 'Cheese & Bacon', 'R/C': 'Ridge Cut', 'NDL': 'Noodle', 'NDLS': 'Noodles' };
  function tidyName(desc) {
    let w = String(desc || '').replace(/^[*%#]\s*/, '').replace(/\*+/g, ' ').replace(/\(\d+\)?$/, '').replace(/\(\d+\s*$/, '').replace(/\s+/g, ' ').trim().split(' ');
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

  root.CSB_INVOICE = { parseLine, parseInvoice, parseTableInvoice, parseCcepInvoice, ccepName, ccepPack, piecesToRows, pdfToPages, pdfToLines, readPdf, tidyName };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CSB_INVOICE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
