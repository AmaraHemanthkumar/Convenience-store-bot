// Run: node tests/capture.test.js   (how the bot reads barcodes from PosPort's own item data)
const assert = require('assert');
global.window = {}; global.localStorage = { getItem: () => null, setItem: () => {} };
global.XMLHttpRequest = function () {}; XMLHttpRequest.prototype.open = function () {};
window.fetch = () => Promise.resolve();
require('../extension/core/posport-capture.js');
const C = window.__CSB_CAPTURE;
// an SKU is not a barcode; the real one sits in a variant
assert.deepStrictEqual(C.barcodesOf({ sku: 'SKU-0042', variants: [{ barcode: '9300605094703' }, { barcode: '9300605247970' }] }), ['9300605094703', '9300605247970']);
assert.deepStrictEqual(C.barcodesOf({ sku: '1042' }), []);                               // short SKU: no barcode
assert.deepStrictEqual(C.barcodesOf({ plu: '9300682012345' }), ['9300682012345']);        // a PLU that is a barcode
assert.ok(C.barcodesOf({ barcodes: [{ code: '93238946' }, '9300682012345'] }).includes('93238946'));
const it = C.asItem({ id: 7, name: 'Kit Kat', price: 3.5, sku: 'KK1', variants: [{ barcode: '9300605094703' }] });
assert.strictEqual(it.barcode, '9300605094703');
console.log('capture tests passed');
