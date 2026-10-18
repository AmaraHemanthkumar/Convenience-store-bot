// Run: node tests/rules.test.js
const assert = require('assert');
const R = require('../extension/core/rules.js');

// pricing
assert.strictEqual(R.newItemPrice(4.2), 5.7);            // no rounding, just +1.50
assert.strictEqual(R.newItemPrice(3.99), 5.49);
assert.strictEqual(R.highestPrice(4.2, 4.5), 4.5);       // highest of the two shops
assert.strictEqual(R.highestPrice(null, 4.5), 4.5);
assert.strictEqual(R.regularPrice(3.0, 4.2), 4.2);       // normal price, not the special
assert.strictEqual(R.regularPrice(4.2, 0), 4.2);
assert.strictEqual(R.checkExistingPrice(5.5, 4.2).status, 'TOO LOW');   // only 1.30 above
assert.strictEqual(R.checkExistingPrice(5.7, 4.2).status, 'OK');        // 1.50 above
assert.strictEqual(R.checkExistingPrice(6.2, 4.2).status, 'OK');        // 2.00 above
assert.strictEqual(R.checkExistingPrice(6.21, 4.2).status, 'TOO HIGH');
assert.strictEqual(R.checkExistingPrice(6.5, null).status, 'NO DATA');

// barcodes
assert.strictEqual(R.cleanBarcode(9300682012345), '9300682012345');
assert.strictEqual(R.cleanBarcode('9300682012345.0'), '9300682012345');
assert.ok(R.sameBarcode('09300682012345', '9300682012345'));

assert.ok(R.validBarcode('9300605094703'));
assert.ok(R.validBarcode('93645102'));
assert.ok(!R.validBarcode('9300605094704'));

// names fit the label and keep the size
for (const [full, size] of [
  ["Allen's Minties Lollies Bag 150g", '150g'],
  ["Wrigley's Extra Peppermint Sugar Free Chewing Gum Bottle 64g", '64g'],
  ["Smith's Crinkle Cut Potato Chips Original Share Pack 170g", '170g'],
  ['Cadbury Dairy Milk Chocolate Block 180g', ''],
]) {
  const n = R.shortName(full, size, 28);
  assert.ok(n.length <= 28, n);
  assert.ok(/\d+(g|ml|L|kg)$/.test(n), 'size kept: ' + n);
}
assert.strictEqual(R.shortName('A2 Full Cream 2L', '', 28), 'A2 Full Cream 2L');
// brand (first word) never changes; shelf shorthand only when needed
assert.ok(R.shortName('Continental Special Fried Rice Classic 120g', '', 28).startsWith('Continental '));
assert.ok(/SPL|CLS/.test(R.shortName('Continental Special Fried Rice Classic 120g', '', 28)));
assert.strictEqual(R.shortName('Continental Classic Rice 120g', '', 40), 'Continental Classic Rice 120g');
R.setAbbreviations('Fried=FRD');
assert.ok(R.shortName('Continental Special Fried Rice Classic 120g', '', 30).includes('FRD'));
R.setAbbreviations('');
assert.strictEqual(R.unitPrice(3.79, '60g'), '$6.32 per 100g');
assert.strictEqual(R.unitPrice(7.5, '2L'), '$3.75 per L');

// categories
assert.strictEqual(R.guessCategory("Wrigley's Extra Peppermint Gum 64g"), 'Gum and Mints');
assert.strictEqual(R.guessCategory('Coca-Cola Classic 1.25L'), 'Drinks');
assert.strictEqual(R.guessCategory('Bulla Thickened Cream 300ml'), 'Milk and Dairy');
assert.strictEqual(R.guessCategory('Peters Drumstick Vanilla 4pk'), 'Ice Cream Take Home');
assert.strictEqual(R.guessCategory('Streets Magnum Classic'), 'STREETS ICE CREAMS');
assert.strictEqual(R.guessCategory('Some Unknown Thing', 'Pantry'), 'Grocery Pantry');

// spreadsheet input
const rows = R.parseInputRows([['Barcode', 'Name'], [9300682012345, ''], ['9300682012345', ''], ['', 'Thing 1L']]);
assert.strictEqual(rows.length, 2);   // duplicate barcode removed
console.log('rules tests passed');
