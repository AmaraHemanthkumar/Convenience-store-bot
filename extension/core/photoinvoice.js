// Printed invoices from a photo: the text is read on your own computer (Tesseract, no internet),
// then turned into invoice lines. A photo is never perfect, so lines the reader was unsure of are marked
// "check this line", and nothing is created in PosPort without you seeing it first.
(function (root) {
  const MONEY = /\$?\s?(\d{1,4}(?:[.,]\d{2}))\b/g;

  // One printed line -> {desc, barcode, qty, unitCost, total} or null (headings, addresses, totals …)
  function parsePhotoLine(text) {
    let t = String(text || '').replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < 6) return null;
    if (/^(sub-?total|total|gst|balance|amount due|invoice|tax invoice|abn|phone|fax|email|page|date|account|deliver|ship|bill|payment|bsb)\b/i.test(t)) return null;
    // OCR often reads O for 0 inside long numbers
    t = t.replace(/\b[0-9OoIl]{8,14}\b/g, (w) => (/\d{6,}/.test(w.replace(/[Oo]/g, '0').replace(/[Il]/g, '1')) ? w.replace(/[Oo]/g, '0').replace(/[Il]/g, '1') : w));
    const bc = (t.match(/\b(\d{8}|\d{12,14})\b/) || [])[1] || '';
    const prices = [];
    let m;
    MONEY.lastIndex = 0;
    while ((m = MONEY.exec(t))) prices.push({ v: Number(m[1].replace(',', '.')), at: m.index });
    if (!prices.length) return null;                           // an item line always has a price
    const firstNum = Math.min(...[prices[0].at].concat(bc ? [t.indexOf(bc)] : []));
    let desc = t.slice(0, firstNum).replace(/\b\d{1,3}\s*$/, '').trim();
    // quantity: a small whole number before the prices (or at the start of the line)
    const lead = desc.match(/^(\d{1,3})\s*[xX]?\s+(.+)$/);
    let qty = null;
    if (lead) { qty = Number(lead[1]); desc = lead[2]; }
    else {
      const q = t.slice(firstNum).replace(bc, ' ').match(/(?:^|\s)(\d{1,3})(?=\s+\$?\d+[.,]\d{2})/);
      if (q) qty = Number(q[1]);
    }
    desc = desc.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9)%]+$/, '').trim();
    if (!/[A-Za-z]{3,}/.test(desc)) return null;
    const total = prices[prices.length - 1].v;
    let unitCost = prices.length >= 2 ? prices[prices.length - 2].v : null;
    if (qty && total && (!unitCost || Math.abs(unitCost * qty - total) > 0.05)) unitCost = Math.round(total / qty * 10000) / 10000;
    if (!qty && unitCost && total) { const q = total / unitCost; if (Math.abs(q - Math.round(q)) < 0.02 && q >= 1) qty = Math.round(q); }
    return { desc, barcode: bc, qty: qty || 1, unitCost: unitCost || total, total };
  }

  // Tesseract lines [{text, confidence}] -> an invoice like the PDF reader makes
  function parsePhotoLines(lines, fileName) {
    const text = lines.map((l) => l.text).join('\n');
    const pick = (re) => { const x = text.match(re); return x ? x[1].trim() : ''; };
    const items = [];
    lines.forEach((l) => {
      const it = parsePhotoLine(l.text);
      if (!it) return;
      items.push({
        desc: it.desc, name: '', barcode: it.barcode, shipped: it.qty, unitsReceived: it.qty, unitCost: it.unitCost, extIncGst: it.total,
        status: '', unsure: (l.confidence || 0) < 75, confidence: Math.round(l.confidence || 0), raw: l.text,
      });
    });
    const firstWords = lines.slice(0, 6).map((l) => l.text.trim()).find((s) => /[A-Za-z]{3,}/.test(s) && !/invoice|abn|tax/i.test(s)) || '';
    return {
      photo: true, kind: 'photo', file: fileName || '',
      supplier: pick(/^\s*([A-Z][A-Za-z&' ]+(?:Pty Ltd|Pty\.? Ltd\.?|Limited|Ltd))/m) || firstWords.slice(0, 40),
      number: pick(/(?:invoice|document|tax invoice)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9-]{4,})/i),
      date: pick(/(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/) || pick(/(\d{1,2} [A-Za-z]{3,9} \d{4})/),
      items, fees: [], total: items.reduce((a, x) => a + (x.extIncGst || 0), 0),
      printedTotal: Number((pick(/total(?: inc(?:l|luding)? gst)?\s*\$?\s*([\d,]+\.\d{2})/i) || '').replace(/,/g, '')) || null,
      lineCount: lines.length, unsureCount: items.filter((x) => x.unsure).length,
    };
  }

  // In the dashboard: read the photo's text. onProgress(0..1) while it works (about a minute on a slow laptop).
  let worker = null;
  async function readPhoto(file, onProgress) {
    const T = root.Tesseract;
    if (!T) throw new Error('The photo reader did not load.');
    const base = chrome.runtime.getURL('vendor/tesseract/');
    if (!worker) {
      worker = await T.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: base + 'lang', gzip: true,
        workerBlobURL: false, cacheMethod: 'none',
        logger: (m) => { if (onProgress && m.status === 'recognizing text') onProgress(m.progress || 0); },
      });
      await worker.setParameters({ preserve_interword_spaces: '1' });
    }
    const { data } = await worker.recognize(file);
    const lines = (data.lines || []).map((l) => ({ text: l.text.replace(/\n/g, ' '), confidence: l.confidence }));
    return parsePhotoLines(lines, file.name);
  }

  root.CSB_PHOTO = { parsePhotoLine, parsePhotoLines, readPhoto };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CSB_PHOTO;
})(typeof globalThis !== 'undefined' ? globalThis : this);
