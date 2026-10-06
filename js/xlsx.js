/*
 * Générateur minimal de fichiers Excel (.xlsx), sans bibliothèque externe.
 * Un .xlsx est une archive ZIP de fichiers XML ; ici l'archive n'est pas compressée
 * (méthode "stored"), ce qui suffit largement pour quelques milliers de lignes.
 *
 * Xlsx.build([{ name, rows: [[cellule…]…], widths?: [..], freeze?: bool }]) → Uint8Array
 * Cellule : null | string | number | Date | { v, s } avec s ∈ bold, money, money4, date, time, datetime, pct
 */
(function (root, factory) {
  const X = factory();
  if (typeof module === 'object' && module.exports) module.exports = X;
  else root.Xlsx = X;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const enc = new TextEncoder();

  // ---------- ZIP ----------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** files: [{ name, data: Uint8Array }] → archive ZIP (sans compression) */
  function zip(files) {
    const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 0x0800, true); // noms en UTF-8
      h.setUint16(8, 0, true);      // stored
      h.setUint16(10, DOS_TIME, true);
      h.setUint16(12, DOS_DATE, true);
      h.setUint32(14, crc, true);
      h.setUint32(18, f.data.length, true);
      h.setUint32(22, f.data.length, true);
      h.setUint16(26, name.length, true);
      h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, f.data);

      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, DOS_TIME, true);
      c.setUint16(14, DOS_DATE, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, f.data.length, true);
      c.setUint32(24, f.data.length, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + f.data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let pos = 0;
    for (const p of all) { out.set(p, pos); pos += p.length; }
    return out;
  }

  // ---------- SpreadsheetML ----------

  const STYLE = { bold: 1, money: 2, date: 3, time: 4, pct: 5, datetime: 6, money4: 7 };

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="5"><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/><numFmt numFmtId="166" formatCode="hh:mm"/><numFmt numFmtId="167" formatCode="dd/mm/yyyy hh:mm"/><numFmt numFmtId="168" formatCode="#,##0.0000\\ &quot;€&quot;"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function xmlEscape(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function colName(i) {
    let s = '';
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  /** Date (heure locale) → numéro de série Excel */
  function excelSerial(d) {
    const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    return Math.round(((utc - Date.UTC(1899, 11, 30)) / 86400000) * 1e8) / 1e8;
  }

  function cellXml(ref, cell) {
    if (cell == null || cell === '') return '';
    let v = cell, s = 0;
    if (typeof cell === 'object' && !(cell instanceof Date)) {
      v = cell.v;
      s = STYLE[cell.s] || 0;
    }
    const sa = s ? ` s="${s}"` : '';
    if (v == null || v === '') return '';
    if (v instanceof Date) {
      if (isNaN(v)) return '';
      return `<c r="${ref}" s="${s || STYLE.date}"><v>${excelSerial(v)}</v></c>`;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return '';
      return `<c r="${ref}"${sa}><v>${v}</v></c>`;
    }
    if (typeof v === 'boolean') v = v ? 'Oui' : 'Non';
    return `<c r="${ref}" t="inlineStr"${sa}><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
  }

  function sheetXml(sheet) {
    const rows = sheet.rows.map((row, r) => {
      const cells = (row || []).map((c, i) => cellXml(colName(i) + (r + 1), c)).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    const views = sheet.freeze
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    const cols = sheet.widths && sheet.widths.length
      ? '<cols>' + sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
      : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${views}${cols}<sheetData>${rows}</sheetData></worksheet>`;
  }

  function sheetNames(sheets) {
    const used = new Set();
    return sheets.map((s, i) => {
      let n = String(s.name || `Feuille${i + 1}`).replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31) || `Feuille${i + 1}`;
      while (used.has(n.toLowerCase())) n = (n.slice(0, 28) + ' ' + (i + 1)).slice(0, 31);
      used.add(n.toLowerCase());
      return n;
    });
  }

  function build(sheets) {
    const names = sheetNames(sheets);
    const files = [];
    const add = (name, text) => files.push({ name, data: enc.encode(text) });

    add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
  sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
    add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
  names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
    add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
  sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    add('xl/styles.xml', STYLES_XML);
    sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
    return zip(files);
  }

  return { build, zip, crc32, colName, excelSerial };
});
