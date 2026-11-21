/* ============================================================
   export-sheet.js — 按班级导出「全班学生分数表」
   ------------------------------------------------------------
   与旧版 exportClassSheet / exportScoresFor 的区别（用户 m12672）：
     · 导的是**全班每个学生**，没加过分的也要出现在表里（标 0 分 / 未加分）
     · 列固定：序号 / 姓名 / 学号 / 班级 / 加分次数 / 总分
     · 直接生成 .xlsx（表头冻结 + 细边框 + 列宽 + A4 横向适配），方便打印
     · 文件名「班级名+日期」；多个班级 → 一个文件多个 sheet

   依赖：window.RCXlsx（js/xlsx-writer.js）、window.RCScore、window.RCClasses
   ============================================================ */
(function (global) {
  'use strict';

  var COLUMNS = [
    { key: 'no', title: '序号', width: 7 },
    { key: 'name', title: '姓名', width: 14 },
    { key: 'sid', title: '学号', width: 16 },
    { key: 'cls', title: '班级', width: 16 },
    { key: 'count', title: '加分次数', width: 10 },
    { key: 'total', title: '总分', width: 9 }
  ];

  /** 日期后缀 YYYY-MM-DD（文件名用） */
  function dateSuffix(ts) {
    var d = new Date(ts || Date.now());
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /**
   * 组一个班级的表数据。
   * @param {string} className
   * @param {Array} students  该班学生 [{name,id,group}]
   * @param {Array} records   该班加分记录
   */
  function buildSheet(className, students, records) {
    var label = global.RCScore.classLabel(className);
    var stats = global.RCScore.statsOf(records);

    var rows = [COLUMNS.map(function (c) { return c.title; })];

    (students || []).forEach(function (s, i) {
      var k = global.RCScore.studentKey(s);
      var st = stats[k] || { count: 0, total: 0 };
      rows.push([
        i + 1,
        s.name || '',
        s.id || '',
        label,
        st.count || 0,
        global.RCScore.fmtNum(st.total || 0) * 1
      ]);
    });

    return {
      name: global.RCXlsx.sheetName(label, '班级'),
      columns: COLUMNS.map(function (c) { return { width: c.width }; }),
      rows: rows,
      freezeRows: 1
    };
  }

  /**
   * 生成 xlsx 字节。
   * @param {Array} jobs [{ className, students, records }]
   * @returns {{ bytes: Uint8Array, filename: string, sheetCount: number }}
   */
  function buildWorkbook(jobs) {
    var sheets = (jobs || []).map(function (j) {
      return buildSheet(j.className, j.students, j.records);
    }).filter(function (s) { return s.rows.length > 1; });

    if (!sheets.length) return null;

    var bytes = global.RCXlsx.build(sheets);
    var day = dateSuffix();

    var filename;
    if (sheets.length === 1) {
      filename = global.RCScore.safeFileName(sheets[0].name) + '_学生分数表_' + day + '.xlsx';
    } else {
      filename = '全部班级_学生分数表_' + day + '.xlsx';
    }

    return { bytes: bytes, filename: filename, sheetCount: sheets.length };
  }

  /* ============================================================
     分数详情记录表（用户 m15505）
     ------------------------------------------------------------
     一行 = 一次加分/扣分操作，按时间正序。
     列固定：时间 / 操作人 / 学生 / 班级 / 分值 / 原因
     与「全班学生分数表」的分工：那个是每人一行的汇总，这个是流水明细。
     ============================================================ */

  var REC_COLUMNS = [
    { key: 'time', title: '时间', width: 20 },
    { key: 'op', title: '操作人', width: 12 },
    { key: 'name', title: '学生', width: 14 },
    { key: 'cls', title: '班级', width: 16 },
    { key: 'delta', title: '分值', width: 8 },
    { key: 'reason', title: '原因', width: 30 }
  ];

  /** 时间戳 → YYYY-MM-DD HH:mm:ss */
  function timeText(ts) {
    var d = new Date(ts || Date.now());
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /**
   * 组一个班级的「分数详情记录表」。
   * @param {string} className
   * @param {Array} records  该班加分记录 [{t,name,sid,delta,reason,op}]
   */
  function buildRecordsSheet(className, records) {
    var label = global.RCScore.classLabel(className);
    var list = (records || []).slice().sort(function (a, b) {
      return (Number(a.t) || 0) - (Number(b.t) || 0);
    });

    var rows = [REC_COLUMNS.map(function (c) { return c.title; })];

    list.forEach(function (r) {
      var d = Number(r.delta) || 0;
      rows.push([
        timeText(r.t),
        r.op || '—',
        r.name || '',
        label,
        d,
        r.reason || ''
      ]);
    });

    return {
      name: global.RCXlsx.sheetName(label, '班级'),
      columns: REC_COLUMNS.map(function (c) { return { width: c.width }; }),
      rows: rows,
      freezeRows: 1
    };
  }

  /**
   * 生成「分数详情记录表」xlsx。
   * @param {Array} jobs [{ className, records }]
   */
  function buildRecordsWorkbook(jobs) {
    var sheets = (jobs || []).map(function (j) {
      return buildRecordsSheet(j.className, j.records);
    }).filter(function (s) { return s.rows.length > 1; });

    if (!sheets.length) return null;

    var bytes = global.RCXlsx.build(sheets);
    var day = dateSuffix();

    var filename;
    if (sheets.length === 1) {
      filename = global.RCScore.safeFileName(sheets[0].name) + '_分数详情记录表_' + day + '.xlsx';
    } else {
      filename = '全部班级_分数详情记录表_' + day + '.xlsx';
    }

    return { bytes: bytes, filename: filename, sheetCount: sheets.length };
  }

  /** 触发浏览器下载（application/vnd.openxmlformats…） */
  function download(bytes, filename) {
    var blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  global.RCExportSheet = {
    COLUMNS: COLUMNS,
    REC_COLUMNS: REC_COLUMNS,
    buildSheet: buildSheet,
    buildWorkbook: buildWorkbook,
    buildRecordsSheet: buildRecordsSheet,
    buildRecordsWorkbook: buildRecordsWorkbook,
    timeText: timeText,
    download: download,
    dateSuffix: dateSuffix
  };
})(window);
