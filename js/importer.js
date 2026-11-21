/* ============================================================
   importer.js — xlsx / xls / csv 解析、表头识别、清洗去重
   ============================================================ */

(function (global) {
  'use strict';

  /* 姓名列候选关键字（按优先级） */
  var NAME_KEYS = ['姓名', '学生姓名', '名字', '学生', 'name', 'student', '学员'];
  /* 学号列候选关键字 */
  var ID_KEYS = ['学号', '学生学号', '编号', '工号', '序号', 'id', 'no', 'no.', 'number', '学籍号'];
  /* 分组 / 班级列 */
  var GROUP_KEYS = ['班级', '分组', '组别', '小组', 'class', 'group', 'team', '专业'];

  var MAX_NAME_LEN = 24;

  function normCell(v) {
    if (v == null) return '';
    return String(v).replace(/\s+/g, ' ').trim();
  }

  function headerScore(cell) {
    var s = normCell(cell).toLowerCase().replace(/\s/g, '');
    if (!s) return { name: -1, id: -1, group: -1 };
    var out = { name: -1, id: -1, group: -1 };
    NAME_KEYS.forEach(function (k, i) {
      if (s === k || s.indexOf(k) >= 0) out.name = Math.max(out.name, 100 - i * 3 - (s.length > k.length + 3 ? 5 : 0));
    });
    ID_KEYS.forEach(function (k, i) {
      if (s === k || s.indexOf(k) >= 0) out.id = Math.max(out.id, 100 - i * 3);
    });
    GROUP_KEYS.forEach(function (k, i) {
      if (s === k || s.indexOf(k) >= 0) out.group = Math.max(out.group, 100 - i * 3);
    });
    // 避免「学号」被误判成姓名（"学生"关键字包含在"学生学号"里）
    if (out.id > out.name) out.name = -1;
    return out;
  }

  /**
   * 把二维数组转成学生对象数组
   * @param {Array<Array>} rows
   * @returns {{students:Array, meta:Object}}
   */
  function rowsToStudents(rows) {
    rows = (rows || []).filter(function (r) {
      return r && r.some(function (c) { return normCell(c) !== ''; });
    });

    if (!rows.length) {
      return { students: [], meta: { headerFound: false, reason: 'empty' } };
    }

    // 在前 5 行里找表头
    var headerRow = -1;
    var cols = { name: -1, id: -1, group: -1 };
    var bestScore = 0;

    var scanLimit = Math.min(5, rows.length);
    for (var r = 0; r < scanLimit; r++) {
      var row = rows[r];
      var cand = { name: -1, id: -1, group: -1 };
      var score = 0;
      for (var c = 0; c < row.length; c++) {
        var hs = headerScore(row[c]);
        if (hs.name > cand.name) { cand.name = c; }
        if (hs.id > cand.id) { cand.id = c; }
        if (hs.group > cand.group) { cand.group = c; }
        score += Math.max(0, hs.name, hs.id, hs.group);
      }
      if (score > bestScore && cand.name >= 0) {
        bestScore = score;
        headerRow = r;
        cols = cand;
      }
    }

    var headerFound = headerRow >= 0;
    var dataRows;

    if (headerFound) {
      dataRows = rows.slice(headerRow + 1);
      // 姓名列没识别到，退化为第一列
      if (cols.name < 0) cols.name = 0;
      // 学号列和姓名列冲突时清空
      if (cols.id === cols.name) cols.id = -1;
      if (cols.group === cols.name) cols.group = -1;
    } else {
      // 无表头：判断第一行是不是数据
      dataRows = rows.slice();
      // 如果第一列首行看起来像表头（非中文姓名且短），跳过它
      var first = normCell(dataRows[0] && dataRows[0][0]);
      if (first && /^(姓名|名字|学生|name|序号|编号|学号)$/i.test(first)) {
        dataRows = dataRows.slice(1);
      }
      cols = { name: 0, id: 1, group: -1 };
    }

    var students = [];
    var seen = Object.create(null);
    var skipped = 0;

    dataRows.forEach(function (row) {
      if (!row) { skipped++; return; }
      var name = normCell(row[cols.name]);
      if (!name) { skipped++; return; }
      // 过滤明显的标题行
      if (/^(姓名|名字|学生姓名|name)$/i.test(name)) { skipped++; return; }
      if (name.length > MAX_NAME_LEN) { skipped++; return; }
      // 纯数字或纯符号的行多半是序号
      if (/^[\d.\-_\s]+$/.test(name) && !cols.id) { skipped++; return; }

      var id = cols.id >= 0 ? normCell(row[cols.id]) : '';
      var group = cols.group >= 0 ? normCell(row[cols.group]) : '';

      var key = name + '\u0000' + id;
      if (seen[key]) { skipped++; return; }
      seen[key] = 1;

      students.push({ name: name, id: id, group: group });
    });

    return {
      students: students,
      meta: {
        headerFound: headerFound,
        headerRow: headerRow,
        cols: cols,
        skipped: skipped,
        totalRows: dataRows.length
      }
    };
  }

  /** 解析 CSV 文本（支持引号、逗号/制表符分隔） */
  function parseCSV(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    // 嗅探分隔符
    var head = text.split(/\r?\n/).slice(0, 3).join('\n');
    var delim = ',';
    var counts = { ',': 0, '\t': 0, ';': 0 };
    for (var i = 0; i < head.length; i++) {
      if (counts.hasOwnProperty(head[i])) counts[head[i]]++;
    }
    delim = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0] || ',';

    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;

    for (var p = 0; p < text.length; p++) {
      var ch = text[p];
      if (inQuotes) {
        if (ch === '"') {
          if (text[p + 1] === '"') { field += '"'; p++; }
          else inQuotes = false;
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else if (ch === '\r') {
        // 忽略，\r\n 由 \n 处理
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  /**
   * 读取文件 → 学生数组
   * @param {File} file
   * @returns {Promise<{students:Array, meta:Object}>}
   */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var name = (file.name || '').toLowerCase();
      var isCSV = /\.(csv|txt)$/.test(name);

      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('文件读取失败')); };

      if (isCSV) {
        reader.onload = function () {
          try {
            var rows = parseCSV(reader.result);
            resolve(rowsToStudents(rows));
          } catch (e) { reject(e); }
        };
        reader.readAsText(file, 'UTF-8');
        return;
      }

      reader.onload = function () {
        try {
          if (typeof XLSX === 'undefined') {
            reject(new Error('xlsx 解析库未加载，请用 CSV 或检查 vendor 目录'));
            return;
          }
          var data = new Uint8Array(reader.result);
          var wb = XLSX.read(data, { type: 'array' });
          var sheetName = wb.SheetNames[0];
          if (!sheetName) { reject(new Error('表格里没有工作表')); return; }
          var sheet = wb.Sheets[sheetName];
          var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
          var result = rowsToStudents(rows);
          result.meta.sheetName = sheetName;
          result.meta.sheetCount = wb.SheetNames.length;
          resolve(result);
        } catch (e) { reject(e); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /** 手动录入文本 → 学生数组 */
  function parseManual(text) {
    var lines = String(text || '').split(/\r?\n/);
    var rows = lines
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l !== ''; })
      .map(function (l) {
        // 优先按 逗号 / 制表符 / 分号 分隔
        var parts = l.split(/[,，\t;；]+/).map(function (s) { return s.trim(); });
        if (parts.length > 1) return parts;
        // 只有一个字段时，再尝试「姓名 + 空格 + 学号」的写法
        var m = l.match(/^(\S+)\s+([A-Za-z0-9\-_]{2,})$/);
        if (m) return [m[1], m[2]];
        // 多个空格分隔
        parts = l.split(/\s{2,}/).map(function (s) { return s.trim(); });
        return parts;
      });
    return rowsToStudents(rows);
  }

  global.RCImporter = {
    readFile: readFile,
    parseCSV: parseCSV,
    parseManual: parseManual,
    rowsToStudents: rowsToStudents
  };
})(window);
