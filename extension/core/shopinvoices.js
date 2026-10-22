// Woolworths / Coles tax invoices from your own account (the one logged in in this browser).
// The bot opens your order history in a background tab, finds each order's invoice link and
// downloads the PDF with your login – it never sees or stores your password.
// These functions run INSIDE the shop's page (chrome.scripting), so each one is self-contained.
(function (root) {
  const SHOPS = {
    Woolworths: { home: 'https://www.woolworths.com.au', orders: 'https://www.woolworths.com.au/shop/myaccount/myorders' },
    Coles: { home: 'https://www.coles.com.au', orders: 'https://www.coles.com.au/account/orders' },
  };

  // In the page: what does this page offer? invoice links, order pages, signed in or not, a robot check?
  function scanPage() {
    const txt = (document.body && document.body.innerText) || '';
    const challenge = !!document.getElementById('main-iframe') || (!txt.trim() && !!document.querySelector('iframe'));
    const signedOut = /\b(sign in|log in)\b/i.test(txt.slice(0, 3000)) && !/\b(sign out|log out|my account|hi,)\b/i.test(txt.slice(0, 5000));
    const abs = (h) => { try { return new URL(h, location.href).href; } catch (e) { return ''; } };
    const links = Array.from(document.querySelectorAll('a[href], [data-href], button'));
    const invoices = [], orders = [];
    links.forEach((a) => {
      const href = abs(a.getAttribute('href') || a.getAttribute('data-href') || '');
      const label = ((a.innerText || a.getAttribute('aria-label') || a.title || '') + '').replace(/\s+/g, ' ').trim();
      if (!href) return;
      if (/invoice/i.test(href) || /tax\s*invoice|download\s*invoice|view\s*invoice|invoice/i.test(label)) invoices.push({ href, label: label.slice(0, 80) });
      else if (/(my)?orders?\/(details\/)?[a-z0-9-]*\d{5,}/i.test(href) || /order[-_ ]?(id|number|no)?=\d{5,}/i.test(href)) orders.push({ href, label: label.slice(0, 80) });
    });
    const uniq = (l) => l.filter((x, i) => l.findIndex((y) => y.href === x.href) === i);
    const email = (txt.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [''])[0];
    return { url: location.href, challenge, signedOut, invoices: uniq(invoices), orders: uniq(orders), email, textLen: txt.length };
  }

  // In the page: download one invoice with the shop login. Returns base64 of the PDF, or why not.
  async function grabPdf(href) {
    try {
      const res = await fetch(href, { credentials: 'include' });
      const buf = new Uint8Array(await res.arrayBuffer());
      const head = String.fromCharCode.apply(null, Array.from(buf.slice(0, 5)));
      if (head !== '%PDF-') return { ok: false, status: res.status, type: res.headers.get('content-type') || '', size: buf.length };
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 0x8000)));
      const cd = res.headers.get('content-disposition') || '';
      const name = (cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1] || '';
      return { ok: true, b64: btoa(bin), name: decodeURIComponent(name) };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  // order / invoice number in a link, used to skip invoices already downloaded
  function orderNumberOf(s) {
    const m = String(s || '').match(/(?:orders?|invoice)[^0-9a-z]{0,20}([a-z]?\d{6,})/i) || String(s || '').match(/([a-z]?\d{8,})/i);
    return m ? m[1] : '';
  }

  root.CSB_SHOPINV = { SHOPS, scanPage, grabPdf, orderNumberOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CSB_SHOPINV;
})(typeof globalThis !== 'undefined' ? globalThis : this);
