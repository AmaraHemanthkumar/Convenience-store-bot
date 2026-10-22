// Run: node tests/invoice.test.js   (reads lines laid out like The Distributors' invoices)
const assert = require('assert');
const I = require('../extension/core/invoice.js');
const lines = [
  'The Distributors Brisbane Pty Ltd',
  'Document No:                  2548441',
  'CARRARA QLD 4211      Transaction Date:            15 Oct 2026',
  'NES KIT KAT CHUNKY KING 70G          1.000             9300605094703             01816           3.65     OUTER    24       10.00    $7.200       47.780                      47.780        47.78           4.78         52.56',
  'KINDER JOY 20G T1                    0.000       1.000      80310891             24851   OUT OF STOCK     OUTER    24       10.00                 56.300                      56.300         0.00           0.00          0.00',
  'TROLLI SRP 150G BRITECRAWLERS     1.000                                    24530          2.99 OUTER               10        10.00                21.900                      21.900         21.90        2.19          24.09',
  'PANADOL 16S **TABLETS**           3.000                     9300673894021        87470          6.36     UNIT      24        10.00                 4.450                       4.450        13.35           1.34         14.69',
  'RED BULL 250ML WHITE PEACH          1.000                    90486104      40220          4.49 OUTER       12        10.00   $4.750       22.890          1.720        24.610         24.61        2.46           27.07',
  'SMT DORITOS 170G MEXICANA (12)      0.333                9310015241932      37263          0.00 OUTER       12        10.00                34.560                      34.560         11.52        1.15           12.67',
  'MARGARET BONUS - NU PURE 600ML    2.000                                        REP05          0.00 OUTER       12                              0.000                                                             NO CHARGE',
  'Service Handling Fee                                9.00       0.90        9.90',
  'Total Inc GST                 140.98',
];
const inv = I.parseInvoice(lines);
assert.strictEqual(inv.number, '2548441');
assert.strictEqual(inv.date, '15 Oct 2026');
assert.strictEqual(inv.items.length, 7);
const kk = inv.items[0];
assert.strictEqual(kk.barcode, '9300605094703');
assert.strictEqual(kk.unitsReceived, 24);
assert.strictEqual(kk.unitCost, 2.19);           // 52.56 / 24 inc GST
assert.strictEqual(kk.rrp, 3.65);
const joy = inv.items[1];
assert.strictEqual(joy.status, 'OUT OF STOCK');
assert.strictEqual(joy.unitsShort, 24);
assert.strictEqual(inv.items[2].barcode, '');     // no barcode printed
assert.strictEqual(inv.items[3].soldAs, 'UNIT');
assert.strictEqual(inv.items[3].unitCost, 4.8967); // 14.69 / 3 units
assert.strictEqual(inv.items[4].levy, 1.72);       // container deposit
assert.strictEqual(inv.items[5].unitsReceived, 4); // 0.333 of a 12 outer
assert.strictEqual(inv.items[6].noCharge, true);
assert.strictEqual(inv.fees[0].amount, 9.9);
assert.ok(Math.abs(inv.total - 140.98) < 0.05, inv.total);
assert.strictEqual(I.tidyName('SMT CRINKLE 90G ORIGINAL (18)'), 'Smiths Crinkle Original 90g');
assert.strictEqual(I.tidyName('NES KIT KAT CHUNKY KING 70G'), 'Nestle Kit Kat Chunky King 70g');
console.log('invoice tests passed');
// Woolworths PDFs split "ff"/"fi"/"fl" into their own word
assert.strictEqual(I.fixLigatures("Ra ff erty's garden happy tummies star pu ff s pear & mango 12g"), "Rafferty's garden happy tummies star puffs pear & mango 12g");
assert.strictEqual(I.fixLigatures("Hershey's syrup chocolate fl avoured topping 425g"), "Hershey's syrup chocolate flavoured topping 425g");
assert.strictEqual(I.fixLigatures('Easy-o ff oven & bbq everyday cleaner spray 750ml'), 'Easy-off oven & bbq everyday cleaner spray 750ml');
console.log('ligature tests passed');
