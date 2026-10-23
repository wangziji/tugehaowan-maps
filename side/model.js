/* 《对岸 · THE OTHER SIDE》模型层
 * 命题：城市里最近的一段路，单价最贵。过一条街是一笔固定费用。
 * 纯函数，无 DOM 依赖，可被 verify.js 与 app.js 共用。
 */
(function (root) {
  'use strict';

  var R = 6371000.0;

  function hav(a, b) {
    var d1 = (b[0] - a[0]) * Math.PI / 180, d2 = (b[1] - a[1]) * Math.PI / 180;
    var la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
    var h = Math.sin(d1 / 2) * Math.sin(d1 / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(d2 / 2) * Math.sin(d2 / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function med(a) {
    if (!a.length) return NaN;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function num(v, lo, hi, dflt) {
    v = parseFloat(v);
    if (!isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  }

  /* 有效样本。
   * 注意：POI 可能在商场 / 街区内部，步行终点只能 snap 到最近可步行点，
   * 于是「路径长」可以短于「起点到 POI 的直线」——这不是 bug，是三角不等式。
   * 判据一律用 dist + end >= real（end = 终点到 POI 的直线）。
   * end 过大说明这个 POI 根本走不进去，属于失真样本，剔除。 */
  var END_MAX = 45;
  function valid(r) {
    if (!r || !isFinite(r.dist) || !isFinite(r.real)) return false;
    if (!isFinite(r.dev) || !isFinite(r.end)) return false;
    if (r.end > END_MAX) return false;             // POI 在室内 / 封闭街区，走不进去
    if (r.real < 0.4 * r.d) return false;          // snap 把起点吸到了 POI 身上
    if (r.dist + r.end + 5 < r.real) return false; // 三角不等式
    if (r.dev > r.dist + r.end + 5) return false;  // 绕行顶点不可能超过路径全长的终点闭包
    return true;
  }

  /* POI 级体检：若一个 POI 在商场 / 封闭街区内部（中位数意义下走不进去），
   * 它所有方位的「直线距离」都是假的，整点剔除，而不是逐条钳制。 */
  var MIN_N = 5;   // 一个 (POI, 距离档) 至少要有这么多有效方位才可信
  function badPois(data) {
    var by = {};
    data.routes.forEach(function (r) { (by[r.p] = by[r.p] || []).push(r.end); });
    var bad = {};
    Object.keys(by).forEach(function (k) {
      if (med(by[k]) > END_MAX) bad[+k] = true;
    });
    // 再查：任一距离档上有效方位不足 MIN_N → 整点不可用（走不进去的点）
    var cnt = {};
    data.routes.forEach(function (r) {
      if (!valid(r)) return;
      cnt[r.p + '|' + r.d] = (cnt[r.p + '|' + r.d] || 0) + 1;
    });
    data.pois.forEach(function (p, i) {
      data.meta.ds.forEach(function (d) {
        if ((cnt[i + '|' + d] || 0) < MIN_N) bad[i] = true;
      });
    });
    return bad;
  }

  /* 每个 (POI, 距离档) 一组 8 方位 */
  function cells(data) {
    var out = [];
    var pois = data.pois, routes = data.routes;
    var bad = badPois(data);
    var idx = {};
    routes.forEach(function (r) {
      var k = r.p + '|' + r.d;
      (idx[k] = idx[k] || []).push(r);
    });
    pois.forEach(function (p, i) {
      if (bad[i]) return;
      data.meta.ds.forEach(function (d) {
        var list = (idx[i + '|' + d] || []).filter(valid);
        if (list.length < MIN_N) return;
        var ds = list.map(function (r) { return r.dist; });
        var devs = list.map(function (r) { return r.dev; });
        var reals = list.map(function (r) { return r.real; });
        var best = Math.min.apply(null, ds), worst = Math.max.apply(null, ds);
        var bi = ds.indexOf(best), wi = ds.indexOf(worst);
        out.push({
          city: p.city, poiIdx: i, name: p.name, addr: p.addr, kind: p.kind,
          lat: p.lat, lng: p.lng, d: d, n: list.length,
          list: list,
          best: best, worst: worst, spread: worst - best,
          med: med(ds), overpay: worst - d,
          devBest: devs[bi], devWorst: devs[wi],
          realMed: med(reals),
          durBest: list[bi].dur, durWorst: list[wi].dur
        });
      });
    });
    return out;
  }

  function cityAgg(data) {
    var cs = cells(data);
    var byCity = {};
    cs.forEach(function (c) {
      var k = c.city;
      (byCity[k] = byCity[k] || { city: k, c60: [], c240: [] });
      byCity[k]['c' + c.d].push(c);
    });
    return Object.keys(byCity).map(function (k) {
      var g = byCity[k];
      function pick(arr, f) { return med(arr.map(f)); }
      var s60 = pick(g.c60, function (c) { return c.spread; });
      var s240 = pick(g.c240, function (c) { return c.spread; });
      var w60 = pick(g.c60, function (c) { return c.worst; });
      var w240 = pick(g.c240, function (c) { return c.worst; });
      var b60 = pick(g.c60, function (c) { return c.best; });
      var b240 = pick(g.c240, function (c) { return c.best; });
      return {
        city: k, n: g.c60.length,
        spread60: s60, spread240: s240,
        worst60: w60, worst240: w240,
        best60: b60, best240: b240,
        unit60: w60 / 60, unit240: w240 / 240,
        over60: w60 - 60, over240: w240 - 240
      };
    });
  }

  function overall(data) {
    var cs = cells(data);
    var c60 = cs.filter(function (c) { return c.d === 60; });
    var c240 = cs.filter(function (c) { return c.d === 240; });
    var w60 = med(c60.map(function (c) { return c.worst; }));
    var w240 = med(c240.map(function (c) { return c.worst; }));
    var s60 = med(c60.map(function (c) { return c.spread; }));
    var s240 = med(c240.map(function (c) { return c.spread; }));
    return {
      nPoi: data.pois.length, nRoute: data.routes.length,
      nCell: cs.length,
      worst60: w60, worst240: w240,
      best60: med(c60.map(function (c) { return c.best; })),
      best240: med(c240.map(function (c) { return c.best; })),
      spread60: s60, spread240: s240,
      unit60: w60 / 60, unit240: w240 / 240,
      unitRatio: (w60 / 60) / (w240 / 240),
      fixedness: s240 / s60,
      devRatio: med(c60.map(function (c) { return c.devWorst / Math.max(c.devBest, 1); })),
      cells: cs
    };
  }

  /* 交互：给定「我在 d 米外、走了第 k 贵的方位」，估算真实步行距离 / 时长。
   * 用同城同距离档的实测 worst / best 做线性插值（不做外推到 0）。 */
  function estimate(data, city, dMeters) {
    var cs = cells(data).filter(function (c) { return !city || c.city === city; });
    var w = [], b = [], t = [], tb = [];
    data.meta.ds.forEach(function (d) {
      var g = cs.filter(function (c) { return c.d === d; });
      if (!g.length) return;
      w.push([d, med(g.map(function (c) { return c.worst; }))]);
      b.push([d, med(g.map(function (c) { return c.best; }))]);
      t.push([d, med(g.map(function (c) { return c.durWorst; }))]);
      tb.push([d, med(g.map(function (c) { return c.durBest; }))]);
    });
    function interp(pts, x) {
      if (!pts.length) return NaN;
      if (x <= pts[0][0]) return pts[0][1] * x / pts[0][0];
      for (var i = 1; i < pts.length; i++) {
        if (x <= pts[i][0]) {
          var f = (x - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
          return pts[i - 1][1] + f * (pts[i][1] - pts[i - 1][1]);
        }
      }
      var n = pts.length - 1;
      return pts[n][1] * x / pts[n][0];   // 外推用同比例，不钳制
    }
    var d = num(dMeters, 20, 1200, 60);
    var wv = interp(w, d), bv = interp(b, d);
    return {
      d: d,
      worst: wv, best: bv,
      durWorst: interp(t, d), durBest: interp(tb, d),
      spread: wv - bv,
      unit: wv / d
    };
  }

  root.SIDE = {
    hav: hav, med: med, num: num, valid: valid, badPois: badPois,
    cells: cells, cityAgg: cityAgg, overall: overall, estimate: estimate,
    END_MAX: END_MAX
  };
})(typeof window !== 'undefined' ? window : globalThis);
