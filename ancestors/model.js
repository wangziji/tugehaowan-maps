/* 祖先洪流 · ANCESTOR FLOOD —— 纯计算模型（浏览器与 Node 通用，不依赖 DOM） */
var AF = (function () {
  'use strict';

  var LAND_KM2 = 1.489e8;   // 地球陆地面积（含南极）约 1.489 亿 km²
  var BASE_YEAR = 2026;

  // 世界人口锚点：综合 HYDE 3.2 / McEvedy & Jones / 联合国《世界人口展望》，均为估算值
  var WORLD_POP = [
    [-10000, 1.0e6], [-5000, 1.8e7], [-1000, 5.0e7], [-500, 1.0e8],
    [1, 2.0e8], [200, 2.6e8], [400, 2.1e8], [600, 2.2e8], [800, 2.4e8],
    [1000, 2.75e8], [1100, 3.20e8], [1200, 4.00e8], [1300, 4.30e8], [1348, 4.43e8],
    [1400, 3.70e8], [1500, 4.50e8], [1600, 5.50e8], [1700, 6.70e8], [1750, 7.90e8],
    [1800, 9.80e8], [1850, 1.26e9], [1900, 1.65e9], [1950, 2.52e9], [1980, 4.44e9],
    [2000, 6.14e9], [2026, 8.20e9]
  ];

  // 中国人口锚点：综合《中国人口史》与历代户口研究，估算值（含同时期分立政权合计）
  var CN_POP = [
    [-200, 4.0e7], [1, 6.0e7], [200, 6.0e7], [600, 4.5e7], [700, 5.0e7],
    [800, 5.0e7], [1000, 6.0e7], [1100, 1.00e8], [1200, 1.10e8], [1300, 8.5e7],
    [1400, 7.0e7], [1500, 1.00e8], [1600, 1.50e8], [1700, 1.50e8], [1750, 2.00e8],
    [1800, 3.50e8], [1850, 4.30e8], [1900, 4.00e8], [1950, 5.40e8], [1980, 9.80e8],
    [2000, 1.27e9], [2026, 1.41e9]
  ];

  // 中国纪年标签（起始年 → 名称），按起始年降序
  var DYNASTY = [
    [1949, '中华人民共和国'], [1912, '中华民国'], [1644, '清'], [1368, '明'],
    [1271, '元'], [1127, '南宋 · 金'], [960, '北宋'], [907, '五代十国'],
    [618, '唐'], [581, '隋'], [420, '南北朝'], [265, '晋'], [220, '三国'],
    [-206, '汉'], [-221, '秦'], [-475, '战国'], [-770, '春秋'], [-1046, '西周'],
    [-1600, '商'], [-2070, '夏']
  ];

  function interpPop(tbl, year) {
    if (year <= tbl[0][0]) return tbl[0][1];
    var last = tbl[tbl.length - 1];
    if (year >= last[0]) return last[1];
    for (var i = 0; i < tbl.length - 1; i++) {
      var y0 = tbl[i][0], p0 = tbl[i][1], y1 = tbl[i + 1][0], p1 = tbl[i + 1][1];
      if (year >= y0 && year <= y1) {
        var t = (year - y0) / (y1 - y0);
        return Math.exp(Math.log(p0) + (Math.log(p1) - Math.log(p0)) * t);
      }
    }
    return last[1];
  }

  function dynasty(year) {
    for (var i = 0; i < DYNASTY.length; i++) {
      if (year >= DYNASTY[i][0]) return DYNASTY[i][1];
    }
    return '新石器时代';
  }

  /**
   * 计算第 n 代的祖先名额与“占地”尺度。
   * @param {number} n      世代（0 = 你自己）
   * @param {number} genLen 代距（年/代）
   * @param {string} region 'world' | 'cn'
   */
  function compute(n, genLen, region) {
    genLen = genLen || 30;
    var tbl = (region === 'cn') ? CN_POP : WORLD_POP;
    var year = BASE_YEAR - genLen * n;
    var slots = Math.pow(2, n);          // 2 的幂在 double 下 n<1024 均精确
    var pop = interpPop(tbl, year);
    var density = pop / LAND_KM2;        // 人 / km²
    var areaKm2 = slots / density;       // 让每个祖先都占一个活人，需要多大面积
    var rKm = Math.sqrt(areaKm2 / Math.PI);
    return {
      n: n, genLen: genLen, region: region, year: Math.round(year),
      slots: slots, pop: pop, density: density, areaKm2: areaKm2, rKm: rKm,
      ratio: slots / pop, overflow: slots > pop,
      era: dynasty(year)
    };
  }

  /** 第一个“名额超过当时人口”的世代 —— 族谱由树变网的拐点 */
  function wallGeneration(genLen, region) {
    for (var n = 1; n <= 300; n++) {
      if (compute(n, genLen, region).overflow) return n;
    }
    return -1;
  }

  /* ---------- 数字格式化 ---------- */
  function fmtCN(x) {
    if (x < 1e4) return Math.round(x).toLocaleString('en-US');
    if (x < 1e8) return (x / 1e4).toFixed(x < 1e6 ? 2 : 1) + ' 万';
    if (x < 1e12) return (x / 1e8).toFixed(x < 1e10 ? 2 : 1) + ' 亿';
    if (x < 1e16) return (x / 1e12).toFixed(2) + ' 万亿';
    return fmtSci(x);
  }
  function fmtSci(x) {
    if (x === 0) return '0';
    var e = Math.floor(Math.log10(x));
    var m = x / Math.pow(10, e);
    return m.toFixed(2) + ' × 10^' + e;
  }
  function fmtKm(km) {
    if (km < 1) return Math.round(km * 1000) + ' m';
    if (km < 100) return km.toFixed(1) + ' km';
    if (km < 10000) return Math.round(km).toLocaleString('en-US') + ' km';
    return (km / 1e4).toFixed(2) + ' 万 km';
  }
  function fmtArea(a) {
    if (a < 1) return (a * 1e6).toFixed(0) + ' m²';
    if (a < 1e4) return a.toFixed(1) + ' km²';
    if (a < 1e8) return (a / 1e4).toFixed(1) + ' 万 km²';
    return (a / 1e8).toFixed(2) + ' 亿 km²';
  }
  function fmtYear(y) {
    return y > 0 ? ('公元 ' + y + ' 年') : ('公元前 ' + (-y) + ' 年');
  }

  return {
    LAND_KM2: LAND_KM2, BASE_YEAR: BASE_YEAR,
    WORLD_POP: WORLD_POP, CN_POP: CN_POP,
    interpPop: interpPop, dynasty: dynasty, compute: compute,
    wallGeneration: wallGeneration,
    fmtCN: fmtCN, fmtSci: fmtSci, fmtKm: fmtKm, fmtArea: fmtArea, fmtYear: fmtYear
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AF;
