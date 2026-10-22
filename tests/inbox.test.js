// Run: node tests/inbox.test.js   (Gmail helpers, photo invoice lines, shop invoice order numbers)
const assert = require('assert');
const G = require('../extension/core/gmail.js');
const P = require('../extension/core/photoinvoice.js');
const S = require('../extension/core/shopinvoices.js');

assert.strictEqual(G.buildQuery(['orders@dist.com.au', '@ccep.com'], new Date('2026-10-16T10:00:00')), 'from:(orders@dist.com.au OR @ccep.com) has:attachment after:2026/10/16');
assert.strictEqual(G.senderAllowed('The Distributors <Orders@Dist.com.au>', ['orders@dist.com.au']), true);
assert.strictEqual(G.senderAllowed('x <billing@ccep.com>', ['@ccep.com']), true);
assert.strictEqual(G.senderAllowed('evil <orders@dist.com.au.evil.com>', ['orders@dist.com.au']), false);   // look-alike domain
assert.strictEqual(G.senderAllowed('someone <me@gmail.com>', ['orders@dist.com.au']), false);
const payload = { parts: [{ mimeType: 'text/plain', body: { size: 3 } }, { filename: 'inv 1.pdf', mimeType: 'application/pdf', body: { attachmentId: 'A1' } },
  { parts: [{ filename: 'logo.gif', body: { attachmentId: 'L' } }, { filename: 'Barcodes.xlsx', body: { attachmentId: 'X' } }, { filename: 'shelf.JPG', body: { data: 'AA' } }] }] };
assert.deepStrictEqual(G.attachmentsOf(payload).map((a) => a.filename), ['inv 1.pdf', 'Barcodes.xlsx', 'shelf.JPG']);
assert.strictEqual(Buffer.from(G.b64urlToBytes('JVBERi0xLjQ')).toString('latin1'), '%PDF-1.4');
assert.strictEqual(G.tokenFromRedirect('https://x.chromiumapp.org/gmail#access_token=abc&expires_in=3599').token, 'abc');
assert.throws(() => G.tokenFromRedirect('https://x.chromiumapp.org/gmail#error=access_denied'), /access_denied/);
assert.strictEqual(G.fetchKey('Shop@Gmail.com', 'm1', 'a.pdf'), 'shop@gmail.com|m1|a.pdf');

// photo invoices
const l1 = P.parsePhotoLine('2 Coca-Cola Classic 1.25L 9300675003094 $3.20 $6.40');
assert.deepStrictEqual([l1.desc, l1.barcode, l1.qty, l1.unitCost, l1.total], ['Coca-Cola Classic 1.25L', '9300675003094', 2, 3.2, 6.4]);
const l2 = P.parsePhotoLine('Mars Bar 47g 93OO682O58988 24 1.10 26.40');   // O read instead of 0
assert.deepStrictEqual([l2.barcode, l2.qty], ['9300682058988', 24]);
assert.strictEqual(P.parsePhotoLine('TOTAL INC GST $120.00'), null);
assert.strictEqual(P.parsePhotoLine('123 Smith Street Brisbane'), null);
const inv = P.parsePhotoLines([{ text: 'Example Wholesale Pty Ltd', confidence: 90 }, { text: 'Tax Invoice No: 55120', confidence: 90 },
  { text: 'Smiths Chips Original 170g 12 $2.95 $35.40', confidence: 88 }, { text: 'Red Bull 250ml 1 $45.50 $45.50', confidence: 50 }, { text: 'Total $80.90', confidence: 90 }], 'a.jpg');
assert.strictEqual(inv.supplier, 'Example Wholesale Pty Ltd');
assert.strictEqual(inv.number, '55120');
assert.strictEqual(inv.items.length, 2);
assert.strictEqual(inv.items[1].unsure, true);
assert.strictEqual(inv.printedTotal, 80.9);

// shop invoice numbers
assert.strictEqual(S.orderNumberOf('https://www.woolworths.com.au/shop/myaccount/myorders/331988331'), '331988331');
assert.strictEqual(S.orderNumberOf('Coles #a284112539 invoice'), 'a284112539');
console.log('inbox tests passed');
