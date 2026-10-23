/* 《同路 · THE SAME ROAD》模型层
 *
 * 纯函数，不碰 DOM，可在 Node 下直接跑断言。
 *
 * 单位纪律（与 verify.js 的单位锁一一对应）：
 *   dist / polyLen / pickup / totalM / saveM  —— 米
 *   dur / pickupT / extraT                    —— 分钟
 *   speed                                     —— 米/分钟（= dist / dur）
 *   fare                                      —— 元
 *   ov（重合率）                              —— 0..1，无量纲
 *
 * 网格口径：150 m 规则网格，平面投影以城市中心纬度为基准（proj）。
 *   重合率 = 两条线共同走过的里程 / 两条线总里程（对称口径，2·shared/(lenA+lenB)）。
 */
(function (root) {
  'use strict';

  var CELL = 150.0;
  var KY = 110540.0;

  function num(v, def) {
    var x = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(x) ? x : (def === undefined ? 0 : def);
  }
  function clamp(v, lo, hi) {
    if (typeof v !== 'number' || !isFinite(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function proj(lat, lng, lat0) {
    var kx = 111320.0 * Math.cos(lat0 * Math.PI / 180.0);
    return [lng * kx, lat * KY];
  }
  function cellLatLng(cc, lat0) {
    var kx = 111320.0 * Math.cos(lat0 * Math.PI / 180.0);
    var x = (cc[0] + 0.5) * CELL;
    var y = (cc[1] + 0.5) * CELL;
    return [y / KY, x / kx];
  }

  /** 折线 -> {cellKey: 该格内里程(米)} */
  function cellsOf(pts, lat0) {
    var out = {};
    if (!pts || pts.length < 2) return out;
    var xy = new Array(pts.length);
    for (var i = 0; i < pts.length; i++) xy[i] = proj(pts[i][0], pts[i][1], lat0);
    for (var a = 0; a < xy.length - 1; a++) {
      var x0 = xy[a][0], y0 = xy[a][1], x1 = xy[a + 1][0], y1 = xy[a + 1][1];
      var seg = Math.hypot(x1 - x0, y1 - y0);
      if (!(seg > 0)) continue;
      var n = Math.max(1, Math.ceil(seg / (CELL * 0.5)));
      for (var k = 0; k < n; k++) {
        var t = (k + 0.5) / n;
        var key = Math.floor((x0 + (x1 - x0) * t) / CELL) + ',' + Math.floor((y0 + (y1 - y0) * t) / CELL);
        out[key] = (out[key] || 0) + seg / n;
      }
    }
    return out;
  }

  function cellTotal(cells) {
    var s = 0;
    for (var k in cells) if (Object.prototype.hasOwnProperty.call(cells, k)) s += cells[k];
    return s;
  }

  /** 对称重合率：2·共同里程 / (lenA + lenB)，恒在 [0,1] */
  function overlap(a, b) {
    var sa = cellTotal(a), sb = cellTotal(b);
    if (sa <= 0 || sb <= 0) return 0;
    var sh = 0;
    for (var k in a) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
      if (Object.prototype.hasOwnProperty.call(b, k)) sh += Math.min(a[k], b[k]);
    }
    return (2 * sh) / (sa + sb);
  }

  /** 共同走过的里程（米） */
  function sharedMeters(a, b) {
    var sh = 0;
    for (var k in a) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
      if (Object.prototype.hasOwnProperty.call(b, k)) sh += Math.min(a[k], b[k]);
    }
    return sh;
  }

  /** 重合格子中心（lat,lng）列表，用于地图高亮 */
  function sharedCells(a, b, lat0) {
    var out = [];
    for (var k in a) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
      if (Object.prototype.hasOwnProperty.call(b, k)) {
        var cc = k.split(',');
        out.push(cellLatLng([parseFloat(cc[0]), parseFloat(cc[1])], lat0));
      }
    }
    return out;
  }

  /** 折线长度（米） */
  function polyLength(pts, lat0) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) {
      var p = proj(pts[i - 1][0], pts[i - 1][1], lat0);
      var q = proj(pts[i][0], pts[i][1], lat0);
      s += Math.hypot(q[0] - p[0], q[1] - p[1]);
    }
    return s;
  }

  /* ---------- 拼车账 ----------
   * 两条进城线终点相同（都是市中心锚点），故：
   *   顺序「i 先上车」：车从 o_i 出发 -> 接 o_j -> 市中心。
   *     总里程 = pickup + dist_j        （pickup = 驾车 o_i -> o_j）
   *     社会节省 = (dist_i + dist_j) - 总里程
   *     i 的额外时间 = pickupT + dur_j - dur_i
   *     j 的额外时间 = 0                （他上车后才开始赶路，与他直达完全一致）
   *   顺序「j 先上车」对称。
   *
   * 关键不对称：后上车的人时间成本恒为 0，先上车的人独自承担接人绕行。
   */
  function legBooks(ri, rj, pickup, pickupT) {
    var di = num(ri.dist), dj = num(rj.dist), ti = num(ri.dur), tj = num(rj.dur);
    var totalIFirst = pickup + dj;
    var totalJFirst = pickup + di;
    return {
      iFirst: {
        totalM: totalIFirst,
        saveM: (di + dj) - totalIFirst,
        extraI: pickupT + tj - ti,
        extraJ: 0
      },
      jFirst: {
        totalM: totalJFirst,
        saveM: (di + dj) - totalJFirst,
        extraI: 0,
        extraJ: pickupT + ti - tj
      }
    };
  }

  /** 社会最优的上车顺序：总里程更小的那个 */
  function bestOrder(bk) {
    if (bk.iFirst.totalM <= bk.jFirst.totalM) return 'i';
    return 'j';
  }

  /** 车费：起步价 + 里程价（元）。d 单位米，rate 单位 元/公里 */
  function fare(d, base, rate) {
    return num(base, 0) + (num(d, 0) / 1000.0) * num(rate, 0);
  }

  /**
   * 公平分摊：拼车总价按「两人各自独立里程占比」分摊。
   * 净收益 = (原价 - 分摊额) - 额外时间 × 时间单价。
   * 返回 { payI, payJ, saveI, saveJ, netI, netJ, soloI, soloJ, poolFare }
   */
  function settle(bk, order, di, dj, base, rate, vmin) {
    var soloI = fare(di, base, rate), soloJ = fare(dj, base, rate);
    var totalM = order === 'i' ? bk.iFirst.totalM : bk.jFirst.totalM;
    var pool = fare(totalM, base, rate);
    var s = di + dj;
    var shareI = s > 0 ? di / s : 0.5;
    var payI = pool * shareI, payJ = pool * (1 - shareI);
    var extraI = order === 'i' ? bk.iFirst.extraI : bk.jFirst.extraI;
    var extraJ = order === 'i' ? bk.iFirst.extraJ : bk.jFirst.extraJ;
    return {
      soloI: soloI, soloJ: soloJ, poolFare: pool, totalM: totalM,
      payI: payI, payJ: payJ,
      saveI: soloI - payI, saveJ: soloJ - payJ,
      extraI: extraI, extraJ: extraJ,
      netI: (soloI - payI) - extraI * num(vmin, 0),
      netJ: (soloJ - payJ) - extraJ * num(vmin, 0)
    };
  }

  /**
   * 一条线的「大众指数」。
   * candIds 给定候选集（比如只比进城线），不给则比全部其他线。
   */
  function popularity(ovRow, selfId, candIds) {
    var ids = candIds;
    if (!ids || !ids.length) {
      ids = [];
      for (var k = 0; k < ovRow.length; k++) if (k !== selfId) ids.push(k);
    }
    var best = 0, sum = 0, n = 0;
    for (var t = 0; t < ids.length; t++) {
      var j = ids[t];
      if (j === selfId) continue;
      var v = num(ovRow[j], 0);
      if (v > best) best = v;
      sum += v;
      n++;
    }
    return { best: best, mean: n ? sum / n : 0, n: n };
  }

  /* ---------- 格式化 ---------- */
  function km(m) { return (m / 1000.0); }
  function fmtKm(m, d) {
    var v = m / 1000.0;
    return v.toFixed(d === undefined ? 1 : d);
  }
  function fmtMin(x) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    var s = x > 0 ? '+' : (x < 0 ? '−' : '');
    return s + Math.abs(x).toFixed(0) + ' 分钟';
  }
  function fmtPct(x, d) {
    return (100 * x).toFixed(d === undefined ? 1 : d) + '%';
  }

  var API = {
    CELL: CELL, KY: KY,
    num: num, clamp: clamp,
    proj: proj, cellLatLng: cellLatLng, cellsOf: cellsOf, cellTotal: cellTotal,
    overlap: overlap, sharedMeters: sharedMeters, sharedCells: sharedCells,
    polyLength: polyLength,
    legBooks: legBooks, bestOrder: bestOrder, fare: fare, settle: settle,
    popularity: popularity,
    km: km, fmtKm: fmtKm, fmtMin: fmtMin, fmtPct: fmtPct
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.SR = API;
})(typeof window !== 'undefined' ? window : globalThis);
