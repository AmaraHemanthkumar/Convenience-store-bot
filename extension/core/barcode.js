/*
 * Convenience Store Bot - barcode drawing for shelf tickets (no internet needed).
 * EAN-13, EAN-8 and UPC-A (as EAN-13) with a valid check digit; anything else as Code 128.
 * barcodeSVG(code, {height}) returns an <svg> string that scales to the box it is put in.
 */
(function (root) {
  'use strict';

  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  const Rc = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
  const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

  function checkDigit(body) {
    let sum = 0;
    body.split('').reverse().forEach((d, i) => { sum += Number(d) * (i % 2 === 0 ? 3 : 1); });
    return String((10 - (sum % 10)) % 10);
  }

  function ean13(code) {
    const p = PARITY[Number(code[0])];
    let bits = '101';
    for (let i = 1; i <= 6; i++) bits += (p[i - 1] === 'L' ? L : G)[Number(code[i])];
    bits += '01010';
    for (let i = 7; i <= 12; i++) bits += Rc[Number(code[i])];
    return bits + '101';
  }

  function ean8(code) {
    let bits = '101';
    for (let i = 0; i < 4; i++) bits += L[Number(code[i])];
    bits += '01010';
    for (let i = 4; i < 8; i++) bits += Rc[Number(code[i])];
    return bits + '101';
  }

  // Code 128 (set B) patterns, values 0..106
  const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];

  function code128(text) {
    const vals = [104];
    for (const ch of text) { const v = ch.charCodeAt(0) - 32; vals.push(v >= 0 && v < 95 ? v : 0); }
    let sum = vals[0];
    for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
    vals.push(sum % 103, 106);
    let bits = '';
    vals.forEach((v) => {
      C128[v].split('').forEach((w, i) => { bits += (i % 2 === 0 ? '1' : '0').repeat(Number(w)); });
    });
    return bits;
  }

  function encode(raw) {
    const d = String(raw || '').replace(/\s/g, '');
    if (/^\d{13}$/.test(d) && checkDigit(d.slice(0, 12)) === d[12]) return { type: 'EAN-13', bits: ean13(d), text: d };
    if (/^\d{12}$/.test(d) && checkDigit(d.slice(0, 11)) === d[11]) return { type: 'UPC-A', bits: ean13('0' + d), text: d };
    if (/^\d{14}$/.test(d) && d[0] === '0' && checkDigit(d.slice(1, 13)) === d[13]) return { type: 'EAN-13', bits: ean13(d.slice(1)), text: d.slice(1) };
    if (/^\d{8}$/.test(d) && checkDigit(d.slice(0, 7)) === d[7]) return { type: 'EAN-8', bits: ean8(d), text: d };
    if (!d) return null;
    return { type: 'Code 128', bits: code128(d), text: d };
  }

  function barcodeSVG(raw) {
    const e = encode(raw);
    if (!e) return '';
    const q = 6; // quiet zone in modules
    const w = e.bits.length + q * 2;
    let x = q, rects = '';
    const bits = e.bits;
    for (let i = 0; i < bits.length;) {
      if (bits[i] === '1') {
        let j = i;
        while (j < bits.length && bits[j] === '1') j++;
        rects += '<rect x="' + x + '" y="0" width="' + (j - i) + '" height="40"/>';
        x += j - i; i = j;
      } else { x++; i++; }
    }
    return '<svg class="bc" viewBox="0 0 ' + w + ' 40" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">' + rects + '</svg>';
  }

  root.CSB_BARCODE = { encode, barcodeSVG, checkDigit };
})(typeof globalThis !== 'undefined' ? globalThis : this);
