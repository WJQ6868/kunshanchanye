/* ============================================================
   xlsx-writer.js — 无依赖的最小 XLSX 生成器
   ------------------------------------------------------------
   为什么不用 SheetJS 写：项目内置的 SheetJS 0.18.5 社区版在「写入」
   方向不支持冻结窗格（源码里 freezepanes 只出现在读取分支且是空实现），
   样式也只有 cellStyles 的读取能力。而需求明确要求「表头冻结 + 加边框
   方便直接打印」，所以这里手写一份最小 XLSX：ZIP 用 STORE（不压缩，
   Excel 完全接受）+ CRC32，sheet XML 里直接写 <pane> 冻结首行、
   <borders> 细边框、<cols> 列宽。

   对外只暴露一个函数：
     RCXlsx.build([{ name, columns:[{width}], rows:[[...]], freezeRows }])
       → Uint8Array（.xlsx 文件字节）
   单元格值：number → 数字单元格；其余 → inlineStr 文本单元格。
   第一行默认当作表头（加粗、浅蓝底、居中、冻结）。
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- CRC32 ---------- */

  var CRC_TABLE = null;

  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }

  function crc32(bytes) {
    var t = crcTable();
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------- 工具 ---------- */

  function enc(str) {
    return new TextEncoder().encode(str);
  }

  function xmlEsc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /** 0 → A，25 → Z，26 → AA */
  function colName(i) {
    var s = '';
    var n = i;
    while (n >= 0) {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  }

  function dosDateTime(d) {
    var time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
    var date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time: time, date: date };
  }

  /* ---------- ZIP（STORE，不压缩） ---------- */

  function zipStore(files) {
    var chunks = [];
    var central = [];
    var offset = 0;
    var dt = dosDateTime(new Date());

    files.forEach(function (f) {
      var nameBytes = enc(f.name);
      var data = f.data;
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);          // version needed
      lv.setUint16(6, 0x0800, true);      // flags: UTF-8 文件名
      lv.setUint16(8, 0, true);           // method: store
      lv.setUint16(10, dt.time, true);
      lv.setUint16(12, dt.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      chunks.push(local, data);

      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);          // version made by
      cv.setUint16(6, 20, true);          // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dt.time, true);
      cv.setUint16(14, dt.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);          // extra
      cv.setUint16(32, 0, true);          // comment
      cv.setUint16(34, 0, true);          // disk
      cv.setUint16(36, 0, true);          // internal attrs
      cv.setUint32(38, 0, true);          // external attrs
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + data.length;
    });

    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var all = chunks.concat(central, [eocd]);
    var total = all.reduce(function (a, b) { return a + b.length; }, 0);
    var out = new Uint8Array(total);
    var p = 0;
    all.forEach(function (a) { out.set(a, p); p += a.length; });
    return out;
  }

  /* ---------- 各部件 XML ---------- */

  var XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

  function contentTypes(n) {
    var overrides = '';
    for (var i = 1; i <= n; i++) {
      overrides += '<Override PartName="/xl/worksheets/sheet' + i + '.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    return XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      overrides +
      '<Override PartName="/xl/styles.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';
  }

  function rootRels() {
    return XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
      'Target="xl/workbook.xml"/>' +
      '</Relationships>';
  }

  function workbookXml(names) {
    var sheets = '';
    names.forEach(function (nm, i) {
      sheets += '<sheet name="' + xmlEsc(nm) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    });
    return XML_HEAD +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + sheets + '</sheets>' +
      '</workbook>';
  }

  function workbookRels(n) {
    var rels = '';
    for (var i = 1; i <= n; i++) {
      rels += '<Relationship Id="rId' + i + '" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        'Target="worksheets/sheet' + i + '.xml"/>';
    }
    rels += '<Relationship Id="rId' + (n + 1) + '" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ' +
      'Target="styles.xml"/>';
    return XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels + '</Relationships>';
  }

  /**
   * 样式表：
   *   s=0 默认  s=1 表头（加粗/浅蓝底/居中/细边框）
   *   s=2 正文文本（细边框）  s=3 正文数字（细边框/居中）
   */
  function stylesXml() {
    return XML_HEAD +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2">' +
      '<font><sz val="11"/><color theme="1"/><name val="微软雅黑"/><charset val="134"/></font>' +
      '<font><b/><sz val="11"/><color theme="1"/><name val="微软雅黑"/><charset val="134"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border>' +
      '<left style="thin"><color rgb="FF94A3B8"/></left>' +
      '<right style="thin"><color rgb="FF94A3B8"/></right>' +
      '<top style="thin"><color rgb="FF94A3B8"/></top>' +
      '<bottom style="thin"><color rgb="FF94A3B8"/></bottom>' +
      '<diagonal/></border>' +
      '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" ' +
      'applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" ' +
      'applyAlignment="1"><alignment vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" ' +
      'applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }

  function sheetXml(sheet) {
    var rows = sheet.rows || [];
    var cols = sheet.columns || [];
    var freeze = sheet.freezeRows == null ? 1 : sheet.freezeRows;

    var colXml = '';
    if (cols.length) {
      colXml = '<cols>';
      cols.forEach(function (c, i) {
        var w = Number(c && c.width) || 12;
        colXml += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
      });
      colXml += '</cols>';
    }

    var body = '';
    rows.forEach(function (row, r) {
      var cells = '';
      (row || []).forEach(function (v, c) {
        if (v == null || v === '') return;
        var ref = colName(c) + (r + 1);
        if (r === 0) {
          cells += '<c r="' + ref + '" s="1" t="inlineStr"><is><t>' + xmlEsc(v) + '</t></is></c>';
        } else if (typeof v === 'number' && isFinite(v)) {
          cells += '<c r="' + ref + '" s="3"><v>' + v + '</v></c>';
        } else {
          cells += '<c r="' + ref + '" s="2" t="inlineStr"><is><t>' + xmlEsc(v) + '</t></is></c>';
        }
      });
      var h = r === 0 ? ' ht="24" customHeight="1"' : ' ht="20" customHeight="1"';
      body += '<row r="' + (r + 1) + '"' + h + '>' + cells + '</row>';
    });

    var view;
    if (freeze > 0) {
      var topLeft = 'A' + (freeze + 1);
      view = '<sheetViews><sheetView workbookViewId="0">' +
        '<pane ySplit="' + freeze + '" topLeftCell="' + topLeft + '" activePane="bottomLeft" state="frozen"/>' +
        '<selection pane="bottomLeft" activeCell="' + topLeft + '" sqref="' + topLeft + '"/>' +
        '</sheetView></sheetViews>';
    } else {
      view = '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    }

    return XML_HEAD +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      view +
      '<sheetFormatPr defaultRowHeight="20"/>' +
      colXml +
      '<sheetData>' + body + '</sheetData>' +
      '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
      '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>' +
      '</worksheet>';
  }

  /** sheet 名清洗：Excel 限制 31 字、不能含 []:*?/\ */
  function sheetName(raw, fallback) {
    var s = String(raw == null ? '' : raw).replace(/[\[\]\:\*\?\/\\]/g, '_').trim();
    if (!s) s = fallback || 'Sheet';
    return s.slice(0, 31);
  }

  /**
   * @param {Array} sheets [{ name, columns:[{width}], rows:[[...]], freezeRows }]
   * @returns {Uint8Array}
   */
  function build(sheets) {
    var list = (sheets || []).filter(function (s) { return s && s.rows && s.rows.length; });
    if (!list.length) list = [{ name: 'Sheet1', rows: [['（无数据）']] }];

    var names = [];
    var used = Object.create(null);
    list.forEach(function (s, i) {
      var nm = sheetName(s.name, 'Sheet' + (i + 1));
      var base = nm;
      var k = 2;
      while (used[nm]) { nm = (base.slice(0, 28) + '(' + k + ')'); k++; }
      used[nm] = 1;
      names.push(nm);
    });

    var files = [
      { name: '[Content_Types].xml', data: enc(contentTypes(list.length)) },
      { name: '_rels/.rels', data: enc(rootRels()) },
      { name: 'xl/workbook.xml', data: enc(workbookXml(names)) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc(workbookRels(list.length)) },
      { name: 'xl/styles.xml', data: enc(stylesXml()) }
    ];

    list.forEach(function (s, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: enc(sheetXml(s)) });
    });

    return zipStore(files);
  }

  global.RCXlsx = {
    build: build,
    sheetName: sheetName
  };
})(window);
