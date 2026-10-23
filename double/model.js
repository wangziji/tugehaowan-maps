/* 《替身 · THE DOUBLE》模型层
 * 命题：和你常去的地方「路上花一样时间」的地方有一堆，你只去过其中一个。
 * 所有函数纯函数，输入输出明确，不碰 DOM。
 */
(function (root) {
  'use strict';

  var R_EARTH = 6371000;

  function num(v, lo, hi, dflt) {
    var x = Number(v);
    if (!isFinite(x)) return dflt;
    if (typeof lo === 'number' && x < lo) return lo;
    if (typeof hi === 'number' && x > hi) return hi;
    return x;
  }

  /* 大圆距离（米） */
  function hav(lat1, lng1, lat2, lng2) {
    var p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    var dLat = p2 - p1, dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /* 方位角（度，0=正北，顺时针） */
  function bearing(lat1, lng1, lat2, lng2) {
    var p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var y = Math.sin(dLng) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLng);
    var b = Math.atan2(y, x) * 180 / Math.PI;
    return (b + 360) % 360;
  }

  /* 从一点出发，按方位角 brg（度）走 dist（米）后的坐标 */
  function destPoint(lat, lng, brg, dist) {
    var d = num(dist, 0, 1e7, 0) / R_EARTH;
    var b = num(brg, 0, 360, 0) * Math.PI / 180;
    var p1 = num(lat, -90, 90, 0) * Math.PI / 180;
    var l1 = num(lng, -180, 180, 0) * Math.PI / 180;
    var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    var l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 * 180 / Math.PI, lng: ((l2 * 180 / Math.PI) + 540) % 360 - 180 };
  }

  /* 秒 -> 分钟。距离矩阵 duration 单位是秒，这是全篇唯一的时间换算入口。 */
  function toMin(durSec) {
    if (durSec === null || durSec === undefined || durSec === '') return null;
    var s = num(durSec, 0, 86400, NaN);
    if (!isFinite(s)) return null;
    return s / 60;
  }

  /* ---- 核心 1：构造一个出发点下的可达表
   * minLineM：剔除「就在你脚下」的 POI。它们到出发点的路径长度趋零（实测出现过 dist=0、
   * 速度算出 0 km/h 的退化行），放进样本只会污染相关性与速度区间。默认 0（不剔）。
   */
  function buildTable(origin, pois, matrixMap, minLineM) {
    var rows = [], skipped = 0;
    var ml = num(minLineM, 0, 1e6, 0);
    for (var i = 0; i < pois.length; i++) {
      var p = pois[i];
      var m = matrixMap ? matrixMap[p.name] : null;
      if (!m) { skipped++; continue; }
      var durMin = toMin(m.dur_s);
      if (durMin === null) { skipped++; continue; }
      var line = hav(origin.lat, origin.lng, p.lat, p.lng);
      var dm = num(m.dist_m, 0, 1e7, 0);
      if (dm <= 0) { skipped++; continue; }              // 路径长度为 0 的退化行
      if (line < ml) { skipped++; continue; }            // 就在脚下的 POI
      rows.push({
        idx: i,
        name: p.name,
        cat: p.cat,
        lat: p.lat,
        lng: p.lng,
        durMin: durMin,
        distM: num(m.dist_m, 0, 1e7, 0),
        lineM: line,
        brg: bearing(origin.lat, origin.lng, p.lat, p.lng),
        speedKmh: durMin > 0 ? (dm / 1000) / (durMin / 60) : null
      });
    }
    rows.sort(function (a, b) { return a.durMin - b.durMin; });
    rows.skipped = skipped;
    return rows;
  }

  /* ---- 核心 2：等时带 [t-w, t+w] ---- */
  function band(rows, tMin, wMin) {
    var t = num(tMin, 0, 600, 0), w = num(wMin, 0, 120, 0);
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      if (Math.abs(rows[i].durMin - t) <= w) out.push(rows[i]);
    }
    return out;
  }

  function reachable(rows, tMin) {
    var t = num(tMin, 0, 600, 0), out = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].durMin <= t) out.push(rows[i]);
    }
    return out;
  }

  /* ---- 核心 3：锚点 ----
   * 「你常去的地方」不是最近的那个，而是路上花的时间最接近你心理预期 T 的那个。
   * 所以锚点必须随 T 变化；targetT 缺省时退化为「该类里最快到的」。
   */
  function anchorOf(rows, cat, targetT) {
    var t = (targetT === undefined || targetT === null) ? null : num(targetT, 0, 600, 0);
    var best = null, bestGap = Infinity;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].cat !== cat) continue;
      if (t === null) return rows[i];            // rows 已按 durMin 升序，第一个即最快
      var gap = Math.abs(rows[i].durMin - t);
      if (gap < bestGap) { bestGap = gap; best = rows[i]; }
    }
    return best;
  }

  /* ---- 核心 4：替身 = 等时 且 异类 ---- */
  function doubles(rows, anchorCat, wMin, targetT) {
    var a = anchorOf(rows, anchorCat, targetT);
    if (!a) return { anchor: null, list: [], cats: [], n: 0 };
    var b = band(rows, a.durMin, wMin);
    var list = [], seen = {};
    for (var i = 0; i < b.length; i++) {
      if (b[i].cat === anchorCat) continue;      // 同类不算替身
      if (b[i].idx === a.idx) continue;
      if (seen[b[i].name]) continue;
      seen[b[i].name] = 1;
      list.push(b[i]);
    }
    var cats = [], cc = {};
    for (var j = 0; j < list.length; j++) cc[list[j].cat] = (cc[list[j].cat] || 0) + 1;
    for (var k in cc) if (cc.hasOwnProperty(k)) cats.push({ cat: k, n: cc[k] });
    cats.sort(function (x, y) { return y.n - x.n; });
    return { anchor: a, list: list, cats: cats, n: list.length };
  }

  /* ---- 核心 5：厚度 —— 同一个耗时带里，直线距离能差多少倍 ---- */
  function thickness(list) {
    if (!list || list.length < 2) return null;
    var mn = Infinity, mx = -Infinity, mnP = null, mxP = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].lineM < mn) { mn = list[i].lineM; mnP = list[i]; }
      if (list[i].lineM > mx) { mx = list[i].lineM; mxP = list[i]; }
    }
    if (!(mn > 0)) return null;                 // 分母趋零不给指标
    return { minM: mn, maxM: mx, ratio: mx / mn, near: mnP, far: mxP };
  }

  /* ---- 核心 6：可达性玫瑰 —— N 个方位各自最远能到多远（在 T 分钟内） ---- */
  function rose(rows, tMin, sectors) {
    var t = num(tMin, 0, 600, 0);
    var n = Math.max(4, Math.min(72, Math.floor(num(sectors, 4, 72, 16))));
    var arr = [], i;
    for (i = 0; i < n; i++) arr.push({ lo: i * 360 / n, hi: (i + 1) * 360 / n, maxM: null, poi: null, cnt: 0 });
    var r = reachable(rows, t);
    for (i = 0; i < r.length; i++) {
      var s = Math.floor(r[i].brg / (360 / n)) % n;
      arr[s].cnt++;
      if (arr[s].maxM === null || r[i].lineM > arr[s].maxM) {
        arr[s].maxM = r[i].lineM;
        arr[s].poi = r[i];
      }
    }
    return arr;
  }

  /* ---- 核心 7：畸变指数 —— 玫瑰图最长瓣 / 最短瓣
   * 定义域（不是钳制）：某个方位只落进 1 个 POI 时，它的「最远距离」完全由这一个点决定，
   * 一个恰好在脚边的 POI 会把最短瓣压到 0.2 km，比值被放大到几十倍 —— 那是采样噪声不是结论。
   * 所以只统计样本数 >= minCnt 的瓣，且有效瓣数 >= minSector 才给指标。
   */
  function distortion(rows, tMin, sectors, minCnt, minSector) {
    var mc = Math.max(1, Math.floor(num(minCnt, 1, 20, 2)));
    var ms = Math.max(3, Math.floor(num(minSector, 3, 72, 6)));
    var rg = rose(rows, tMin, sectors);
    var vals = [];
    for (var i = 0; i < rg.length; i++) {
      if (rg[i].maxM !== null && rg[i].cnt >= mc) vals.push(rg[i].maxM);
    }
    if (vals.length < ms) return null;          // 有效瓣太少不给指标
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (!(mn > 0)) return null;                 // 分母趋零不给指标
    return { minM: mn, maxM: mx, ratio: mx / mn, covered: vals.length, total: rg.length };
  }

  /* ---- 核心 8：薄片率 —— 你只用掉了等时可能的 1/(N+1) ---- */
  function sliceRate(nDouble) {
    var n = num(nDouble, 0, 1e6, 0);
    return 1 / (n + 1);
  }

  /* ---- 核心 9：更近的替身 —— 等时但空间上比你常去的还近 ---- */
  function nearerDoubles(dbl) {
    if (!dbl || !dbl.anchor) return [];
    var out = [];
    for (var i = 0; i < dbl.list.length; i++) {
      if (dbl.list[i].lineM < dbl.anchor.lineM) out.push(dbl.list[i]);
    }
    return out;
  }

  /* ---- 城市/出发点汇总 ---- */
  function summarize(data, wMin, sectors, targetT, minCnt, minSector, minLineM) {
    var out = [];
    for (var ci = 0; ci < data.cities.length; ci++) {
      var C = data.cities[ci];
      for (var oi = 0; oi < C.origins.length && oi < C.matrix.length; oi++) {
        var O = C.origins[oi];
        var rows = buildTable(O, C.pois, C.matrix[oi].m, minLineM);
        if (rows.length < 8) continue;
        var dbl = doubles(rows, '商场', wMin, targetT);
        var th = thickness(band(rows, dbl.anchor ? dbl.anchor.durMin : 20, wMin));
        var di = distortion(rows, dbl.anchor ? dbl.anchor.durMin : 20, sectors, minCnt, minSector);
        out.push({
          city: C.name, origin: O.name, otype: O.type,
          nPoi: rows.length,
          anchor: dbl.anchor,
          anchorMin: dbl.anchor ? dbl.anchor.durMin : null,
          nDouble: dbl.n,
          nCat: dbl.cats.length,
          cats: dbl.cats,
          thickness: th ? th.ratio : null,
          thickMinM: th ? th.minM : null,
          thickMaxM: th ? th.maxM : null,
          distortion: di ? di.ratio : null,
          slice: sliceRate(dbl.n),
          nearer: nearerDoubles(dbl).length
        });
      }
    }
    return out;
  }

  /* ---- 替换点推荐：等时带里按「类别新鲜度」排序 ---- */
  function suggest(dbl, topN) {
    if (!dbl || !dbl.list.length) return [];
    var n = Math.max(1, Math.min(50, Math.floor(num(topN, 1, 50, 8))));
    var l = dbl.list.slice();
    /* 同类的排在一起，类内按直线距离从远到近（越远越"不像你会去的"） */
    var order = {};
    for (var i = 0; i < dbl.cats.length; i++) order[dbl.cats[i].cat] = i;
    l.sort(function (a, b) {
      var d = (order[a.cat] === undefined ? 99 : order[a.cat]) - (order[b.cat] === undefined ? 99 : order[b.cat]);
      if (d !== 0) return d;
      return b.lineM - a.lineM;
    });
    return l.slice(0, n);
  }

  var API = {
    R_EARTH: R_EARTH,
    hav: hav, bearing: bearing, toMin: toMin, destPoint: destPoint,
    buildTable: buildTable, band: band, reachable: reachable,
    anchorOf: anchorOf, doubles: doubles, thickness: thickness,
    rose: rose, distortion: distortion, sliceRate: sliceRate,
    nearerDoubles: nearerDoubles, summarize: summarize, suggest: suggest
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.Model = API;
})(typeof window !== 'undefined' ? window : globalThis);
