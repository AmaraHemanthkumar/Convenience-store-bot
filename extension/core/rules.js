/*
 * Convenience Store Bot - shared business rules.
 * Pure functions, no DOM. Used by the Chrome extension, the Python version
 * (injected into the browser) and the Node tests.
 */
(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = {
    markup: 1.5,           // new items: highest supermarket price + this
    flagLow: 1.5,          // existing items: flag if our price is less than this above highest
    flagHigh: 2.0,         // existing items: flag if our price is more than this above highest
    nameMaxLength: 28,     // fits the Dymo 25x54mm label at "Medium" name size
    delayMs: 700,          // pause between website actions
    batchSize: 20,         // items per Bulk Create page
    extraBlankRow: true,   // keep one extra empty row (works around the Bulk Create bug)
    autoCreate: false,     // press "Create N Items" automatically after filling
  };

  // Categories as they appear in PosPort's Bulk Create dropdown (Oct 2026).
  const DEFAULT_CATEGORIES = [
    'Biscuits', 'Grocery Pantry', 'Grocery Pet', 'Gum and Mints',
    'Health Beauty & Baby', 'HEALTHY SNACKING', 'Ice Cream Take Home',
    'SNACKFOODS', 'Party Pack Lollies', 'CONFECTIONERY', 'GROCERY HOUSEHOLD',
    'BREAKFAST', 'Drinks', 'Pet Food', 'STREETS ICE CREAMS', 'Milk and Dairy',
    'Bakery', 'EGGS', 'News Papers', 'Misc',
  ];

  // ---------- money ----------
  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function parseMoney(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function money(n) {
    return n === null || n === undefined || isNaN(n) ? '' : Number(n).toFixed(2);
  }

  // Regular (non-special) shelf price.
  function regularPrice(now, was) {
    const n = parseMoney(now);
    const w = parseMoney(was);
    if (w && n && w > n) return w;
    return n || w || null;
  }

  function highestPrice(wwPrice, colesPrice) {
    const vals = [parseMoney(wwPrice), parseMoney(colesPrice)].filter((x) => x && x > 0);
    return vals.length ? Math.max.apply(null, vals) : null;
  }

  // New items: no rounding, just add the markup.
  function newItemPrice(highest, settings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    if (!highest) return null;
    return round2(highest + Number(s.markup));
  }

  // Existing items: compare our price with the highest supermarket price.
  function checkExistingPrice(ourPrice, highest, settings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const ours = parseMoney(ourPrice);
    if (!highest || ours === null) {
      return { diff: null, status: 'NO DATA', flagged: false, suggested: highest ? round2(highest + s.markup) : null };
    }
    const diff = round2(ours - highest);
    let status = 'OK';
    if (diff < s.flagLow - 0.0001) status = 'TOO LOW';
    else if (diff > s.flagHigh + 0.0001) status = 'TOO HIGH';
    return { diff, status, flagged: status !== 'OK', suggested: round2(highest + s.markup) };
  }

  // ---------- barcodes ----------
  function cleanBarcode(v) {
    if (v === null || v === undefined) return '';
    let s = String(v).trim();
    if (/e\+/i.test(s)) {
      // Excel turned it into scientific notation
      const n = Number(s);
      if (isFinite(n)) s = BigInt(Math.round(n)).toString();
    }
    s = s.replace(/\.0+$/, '').replace(/\D/g, '');
    return s;
  }

  // GS1 check digit (EAN-8, UPC-A, EAN-13, GTIN-14). Catches most typing mistakes.
  function validBarcode(v) {
    const d = cleanBarcode(v);
    if (![8, 12, 13, 14].includes(d.length)) return false;
    const n = d.split('').map(Number);
    const chk = n.pop();
    let sum = 0;
    n.reverse().forEach((x, i) => { sum += x * (i % 2 === 0 ? 3 : 1); });
    return (10 - (sum % 10)) % 10 === chk;
  }

  function sameBarcode(a, b) {
    const x = cleanBarcode(a).replace(/^0+/, '');
    const y = cleanBarcode(b).replace(/^0+/, '');
    return !!x && x === y;
  }

  // ---------- short names ----------
  const SIZE_RE = /(\d+\s?x\s?\d+(?:\.\d+)?\s?(?:g|kg|ml|l)\b|\d+(?:\.\d+)?\s?(?:g|kg|ml|l|pk|pack|pce|pcs|pieces|tabs|sheets|ea)\b)/i;
  const FILLER = ['Bag', 'Packet', 'Bottle', 'Can', 'Tub', 'Box', 'Jar', 'Share', 'Sharing',
    'Lollies', 'Block', 'Variety', 'Value', 'Snack', 'Sweets', 'Soft', 'Each', 'Carton',
    'Pouch', 'Tray', 'Sachet', 'Punnet', 'Flavoured', 'Flavour', 'Range', 'Australian', 'Chewing'];
  // Parent brands that can go when a product brand follows (Wrigleys Extra -> Extra)
  const OWNER_BRANDS = ['Wrigleys', 'Arnotts', 'Kelloggs', 'Nestle', 'Mondelez', 'Peters', 'Sanitarium', 'Unilever'];
  const ABBREV = [
    [/\bChocolate\b/gi, 'Choc'], [/\bOriginal\b/gi, 'Orig'], [/\bStrawberry\b/gi, 'Strawb'],
    [/\bAssorted\b/gi, 'Asst'], [/\bVanilla\b/gi, 'Van'], [/\bSparkling\b/gi, 'Spark'],
    [/\bFull Cream\b/gi, 'F/Cream'], [/\bWholemeal\b/gi, 'W/Meal'], [/\bMultipack\b/gi, 'M/Pk'],
    [/\bLight\b/gi, 'Lite'], [/\bSugar Free\b/gi, 'S/Free'], [/\bChicken\b/gi, 'Chkn'],
  ];

  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (m, p, c) => p + c.toUpperCase())
      .replace(/\b(\d+(?:\.\d+)?)(G|Kg|Ml|L|Pk)\b/g, (m, n, u) => n + u.toLowerCase().replace(/^l$/, 'L'));
  }

  function normaliseSize(sz) {
    return String(sz || '').replace(/\s+/g, '').replace(/(\d)(l)$/i, '$1L').replace(/(\d)(ml|g|kg|pk)$/i, (m, d, u) => d + u.toLowerCase());
  }

  function shortName(fullName, size, maxLen) {
    const max = maxLen || DEFAULT_SETTINGS.nameMaxLength;
    let s = String(fullName || '').replace(/\|.*$/, '').replace(/[’'`]/g, '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const letters = s.replace(/[^A-Za-z]/g, '');
    if (letters && letters === letters.toUpperCase()) s = titleCase(s);

    // find the size: prefer the explicit one, else the last size-looking token
    let sz = size ? normaliseSize(size) : '';
    let core = s;
    const m = s.match(new RegExp(SIZE_RE.source + '\\s*$', 'i'));
    if (m) {
      if (!sz) sz = normaliseSize(m[1]);
      core = s.slice(0, m.index).trim();
    } else if (sz) {
      // remove the size if it appears anywhere else in the name
      core = s.replace(new RegExp('\\b' + sz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/(\d)([a-z])/i, '$1\\s?$2') + '\\b', 'i'), '').trim();
    }
    core = core.replace(/\s*[-,]\s*$/, '').replace(/\s+/g, ' ').trim();
    // drop repeated words ("a2 Milk Full Cream Milk" -> "a2 Milk Full Cream")
    const seenW = new Set();
    core = core.split(' ').filter((w) => { const k = w.toLowerCase(); if (seenW.has(k) && /[a-z]{3,}/.test(k)) return false; seenW.add(k); return true; }).join(' ');
    if (/^each$/i.test(sz)) sz = '';

    const join = (c) => (sz ? (c + ' ' + sz).trim() : c);
    if (join(core).length <= max) return join(core);

    // 1. drop filler words (never the first word = brand)
    let words = core.split(' ');
    words = [words[0]].concat(words.slice(1).filter((w) => FILLER.indexOf(w.replace(/[^A-Za-z]/g, '').replace(/^./, (c) => c.toUpperCase())) === -1 && !/^(bag|packet|bottle|can|lollies|block|each)$/i.test(w)));
    core = words.join(' ');
    if (join(core).length <= max) return join(core);

    // 2. abbreviations
    ABBREV.forEach(([re, rep]) => { core = core.replace(re, rep); });
    if (join(core).length <= max) return join(core);

    // 3. drop a parent brand when a product brand follows
    words = core.split(' ');
    if (words.length > 2 && OWNER_BRANDS.indexOf(words[0]) !== -1) core = words.slice(1).join(' ');
    if (join(core).length <= max) return join(core);

    // 4. drop words from the end of the description, keep brand + size
    words = core.split(' ');
    while (words.length > 2 && join(words.join(' ')).length > max) words.splice(words.length - 1, 1);
    core = words.join(' ');
    if (join(core).length <= max) return join(core);

    // 5. hard cut of the description, size always kept
    const room = Math.max(4, max - (sz ? sz.length + 1 : 0));
    return join(core.slice(0, room).trim());
  }

  // ---------- categories ----------
  // Order matters: first match wins.
  const CATEGORY_RULES = [
    ['News Papers', /\b(newspaper|courier mail|the australian|herald sun|sunday mail)\b/i],
    ['STREETS ICE CREAMS', /\b(streets|magnum|paddle pop|golden gaytime|cornetto|splice|calippo|bubble o bill|drumstick)\b(?!.*\b(\d+\s?pk|\d+\s?pack|multipack|\d(\.\d)?\s?l)\b)/i],
    ['Ice Cream Take Home', /\b(ice ?cream|gelato|sorbet|frozen yoghurt|ice confection|drumstick|magnum|paddle pop|cornetto|golden gaytime|splice|peters|connoisseur|blue ribbon|weis|maxibon|bubble o bill)\b/i],
    ['Gum and Mints', /\b(gum|mints?|tic tac|eclipse|extra|mentos|smints|altoids|5 gum|hubba bubba|juicy fruit|wrigley)\b/i],
    ['EGGS', /\beggs?\b/i],
    ['Milk and Dairy', /\b(milk|cream|yoghurt|yogurt|cheese|butter|custard|dairy|a2|kefir)\b(?!.*\b(chocolate block|biscuit)\b)/i],
    ['Bakery', /\b(bread|loaf|rolls?|buns?|muffins?|croissants?|wraps|crumpets?|bagels?|pita|tortillas?)\b/i],
    ['BREAKFAST', /\b(cereal|oats|weet-?bix|muesli(?! bar)|corn ?flakes|porridge|nutri-?grain|rice bubbles|coco pops|special k|up ?& ?go)\b/i],
    ['Drinks', /\b(drink|water|juice|cola|coke|pepsi|sprite|fanta|solo|kombucha|iced tea|ice tea|cordial|lemonade|soda|red ?bull|monster|mother|v energy|gatorade|powerade|mount franklin|schweppes|kirks|nudie|lipton|coffee|iced coffee|milo|big m|dare|oak|farmers union|h2o|electrolyte)\b/i],
    ['SNACKFOODS', /\b(chips|crisps|corn chips|popcorn|pretzels?|doritos|smiths|thins|twisties|cheezels|grain waves|kettle|pringles|cc's|burger rings|red rock|samboy|tostitos|jerky)\b/i],
    ['HEALTHY SNACKING', /\b(nuts|almonds|cashews|trail mix|muesli bar|protein bar|rice cakes?|seeds|carman|uncle tobys bar|nut bar|be natural|sultanas|dried fruit)\b/i],
    ['Biscuits', /\b(biscuits?|cookies?|tim ?tam|arnotts|shapes|crackers?|scotch finger|monte carlo|oreo|wafers?|shortbread|mint slice)\b/i],
    ['CONFECTIONERY', /\b(chocolate|choc|lollies|lolly|candy|jelly|jellies|licorice|liquorice|cadbury|nestle|allens|starburst|skittles|m&m|mars|snickers|kit ?kat|twix|bounty|maltesers|toblerone|ferrero|kinder|lindt|freddo|caramello|cherry ripe|crunchie|violet crumble|natural confectionery|chupa|marshmallows?|minties|killer python|sour|gummy|gummies|pods)\b/i],
    ['Pet Food', /\b(dog food|cat food|pedigree|whiskas|dine|my dog|optimum|supercoat|felix|fancy feast|schmackos|pet food|kitten|puppy)\b/i],
    ['Grocery Pet', /\b(pet|dog|cat|litter|bird ?seed|fish food)\b/i],
    ['Health Beauty & Baby', /\b(shampoo|conditioner|soap|body wash|toothpaste|toothbrush|deodorant|razor|nappies|nappy|baby (?:wipes|food|powder|oil|shampoo|wash)|wet wipes|panadol|nurofen|band-?aid|sunscreen|tampons?|pads|lip|lotion|moisturiser|vaseline|dettol hand|hand sanitiser|cotton|condoms?|antiseptic|vitamins?|rexona|lynx|colgate)\b/i],
    ['GROCERY HOUSEHOLD', /\b(toilet|tissues?|paper towel|detergent|dishwash|laundry|cleaner|bleach|foil|cling ?wrap|bin bags?|garbage|sponges?|batter(y|ies)|light globe|matches|lighter|candles?|napkins|plates|cups|trays|straws|glad|fly spray|mortein|air freshener|pegs|scourer|disinfectant|dettol|spray n wipe|finish|domestos|harpic|kleenex|sorbent|quilton|handee|chux)\b/i],
    ['Grocery Pantry', /./],
  ];

  const CONFECTIONERY_RE = CATEGORY_RULES.find((r) => r[0] === 'CONFECTIONERY')[1];

  // Woolworths department -> our category, used when name rules give only the default.
  const DEPT_MAP = [
    [/confection|chocolate|lollies/i, 'CONFECTIONERY'],
    [/chips|snack/i, 'SNACKFOODS'],
    [/drink|beverage/i, 'Drinks'],
    [/dairy|milk/i, 'Milk and Dairy'],
    [/egg/i, 'EGGS'],
    [/bakery|bread/i, 'Bakery'],
    [/biscuit/i, 'Biscuits'],
    [/breakfast|cereal/i, 'BREAKFAST'],
    [/ice cream|freezer|frozen dessert/i, 'Ice Cream Take Home'],
    [/pet/i, 'Grocery Pet'],
    [/health|beauty|baby|personal care/i, 'Health Beauty & Baby'],
    [/household|cleaning|laundry/i, 'GROCERY HOUSEHOLD'],
  ];

  function guessCategory(name, dept, categories) {
    const cats = categories && categories.length ? categories : DEFAULT_CATEGORIES;
    const has = (c) => cats.some((x) => x.toLowerCase() === c.toLowerCase());
    const pick = (c) => cats.find((x) => x.toLowerCase() === c.toLowerCase()) || c;
    const text = String(name || '');
    // Party packs of lollies / chocolates
    if (/\b(party|share ?pack|sharepack|fun ?size|bulk)\b/i.test(text) && CONFECTIONERY_RE.test(text) &&
        !/\b(chips|crisps|corn chips|popcorn)\b/i.test(text) && has('Party Pack Lollies')) return pick('Party Pack Lollies');
    for (const [cat, re] of CATEGORY_RULES) {
      if (cat === 'Grocery Pantry') break;
      if (re.test(text) && has(cat)) return pick(cat);
    }
    const d = String(dept || '');
    for (const [re, cat] of DEPT_MAP) {
      if (re.test(d) && has(cat)) return pick(cat);
    }
    return has('Grocery Pantry') ? pick('Grocery Pantry') : cats[0];
  }

  // ---------- fuzzy name matching (Coles results, PosPort catalogue) ----------
  function tokens(s) {
    return String(s || '').toLowerCase().replace(/[’'`]/g, '').replace(/&/g, ' and ')
      .replace(/(\d)\s+(g|kg|ml|l|pk)\b/g, '$1$2').split(/[^a-z0-9.]+/).filter(Boolean);
  }

  function similarity(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.length || !B.length) return 0;
    const setB = new Set(B);
    const inter = A.filter((t) => setB.has(t)).length;
    let score = (2 * inter) / (A.length + B.length);
    const sa = (String(a).match(SIZE_RE) || [])[1];
    const sb = (String(b).match(SIZE_RE) || [])[1];
    if (sa && sb) score += normaliseSize(sa).toLowerCase() === normaliseSize(sb).toLowerCase() ? 0.15 : -0.3;
    return Math.max(0, Math.min(1, score));
  }

  function bestMatch(name, candidates, getName) {
    let best = null, bestScore = 0;
    (candidates || []).forEach((c) => {
      const sc = similarity(name, getName ? getName(c) : c);
      if (sc > bestScore) { best = c; bestScore = sc; }
    });
    return { item: best, score: round2(bestScore) };
  }

  // ---------- finding a product in the PosPort item list ----------
  const STOP = new Set(['the', 'and', 'with', 'of', 'a', 'in', 'pack', 'pk', 'bag', 'bottle', 'can', 'each', 'ea',
    'box', 'tub', 'jar', 'share', 'value', 'block', 'bar', 'lollies', 'chocolate', 'choc', 'flavour', 'flavoured']);

  function sizeOf(s) {
    const m = String(s || '').match(new RegExp(SIZE_RE.source, 'ig'));
    return m ? normaliseSize(m[m.length - 1]).toLowerCase() : '';
  }

  function wordSet(s) {
    const t = tokens(s).filter((w) => !/^\d+(\.\d+)?(g|kg|ml|l|pk)?$/.test(w));
    const set = new Set(t);
    for (let i = 0; i < t.length - 1; i++) set.add(t[i] + t[i + 1]); // "kit kat" == "kitkat"
    return { list: t, set };
  }

  // How well a PosPort item name fits the real product name (0..1). Sizes must agree when both have one.
  function posScore(product, posName) {
    const sp = sizeOf(product), sn = sizeOf(posName);
    if (sp && sn && sp !== sn) return 0;
    const P = wordSet(product), N = wordSet(posName);
    if (!N.list.length) return 0;
    const covered = N.list.filter((w) => P.set.has(w) || [...P.set].some((p) => p.length > 3 && (p.startsWith(w) || w.startsWith(p)))).length;
    const cover = covered / N.list.length;                 // PosPort words found in the product name
    const back = N.list.length ? P.list.filter((w) => N.set.has(w)).length / Math.max(1, P.list.length) : 0;
    let score = 0.75 * cover + 0.25 * back;
    if (sp && sn && sp === sn) score += 0.1;
    return Math.max(0, Math.min(1, round2(score)));
  }

  // Pick the PosPort item for a product. Returns {item, score, runnerUp, sure}
  function posMatch(product, candidates, getName) {
    const name = getName || ((c) => (typeof c === 'string' ? c : c.name));
    const ranked = (candidates || []).map((c) => ({ c, s: posScore(product, name(c)) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    const top = ranked[0], second = ranked[1];
    if (!top) return { item: null, score: 0, runnerUp: null, sure: false };
    const gap = top.s - (second ? second.s : 0);
    return { item: top.c, score: top.s, runnerUp: second ? second.c : null, sure: top.s >= 0.6 && gap >= 0.12 };
  }

  // Words to type into PosPort's search box (it only searches names): most distinctive first.
  function searchWords(product) {
    const t = tokens(String(product || '').replace(/[’'`]/g, '')).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d/.test(w));
    const brand = t[0];
    const rest = t.slice(1).sort((a, b) => b.length - a.length);
    const out = [];
    [rest[0], brand, rest[1]].forEach((w) => { if (w && !out.includes(w)) out.push(w); });
    return out;
  }

  // ---------- spreadsheet input ----------
  // rows: array of arrays (first row may be a header). Returns [{barcode, name, category, price, currentPrice}]
  function parseInputRows(rows) {
    if (!rows || !rows.length) return [];
    const header = rows[0].map((h) => String(h || '').toLowerCase().trim());
    const hasHeader = header.some((h) => /barcode|ean|upc|name|item|price|category/.test(h));
    const col = (re) => header.findIndex((h) => re.test(h));
    let bc = hasHeader ? col(/barcode|ean|upc|gtin|code/) : 0;
    if (bc < 0) bc = 0;
    // a name column, but never a code/number column such as "Supplier item code"
    // supplier/invoice wording: used only to help searching, never as the label name
    const hn = hasHeader ? header.findIndex((h, i) => i !== bc && /supplier|invoice|desc/.test(h) && !/code|no\.?$|number|qty|rrp|price|status/.test(h)) : -1;
    const nm = hasHeader ? header.findIndex((h, i) => i !== bc && i !== hn && /name|description|product|^item$/.test(h) && !/code|no\.?$|number|qty/.test(h)) : -1;
    const ct = hasHeader ? col(/categ/) : -1;
    const cur = hasHeader ? col(/current|our|pos|shop/) : -1;
    const pr = hasHeader ? header.findIndex((h, i) => /price/.test(h) && i !== cur) : -1;
    const out = [];
    const seen = new Set();
    rows.slice(hasHeader ? 1 : 0).forEach((r) => {
      const barcode = cleanBarcode(r[bc]);
      const name = nm >= 0 ? String(r[nm] || '').trim() : '';
      if (!barcode && !name) return;
      const key = barcode || name.toLowerCase();
      if (!barcode && !name && hn >= 0 && !String(r[hn] || '').trim()) return;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        barcode,
        name,
        hint: hn >= 0 ? String(r[hn] || '').trim() : '',
        category: ct >= 0 ? String(r[ct] || '').trim() : '',
        price: pr >= 0 ? parseMoney(r[pr]) : null,
        currentPrice: cur >= 0 ? parseMoney(r[cur]) : null,
      });
    });
    return out;
  }

  const api = {
    DEFAULT_SETTINGS, DEFAULT_CATEGORIES, round2, parseMoney, money, regularPrice,
    highestPrice, newItemPrice, checkExistingPrice, cleanBarcode, sameBarcode, validBarcode,
    shortName, guessCategory, similarity, bestMatch, posScore, posMatch, searchWords, sizeOf, parseInputRows, normaliseSize,
  };
  root.CSB_RULES = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
