/* 《折痕 THE CREASE》模型层：纯函数，无 DOM / 无 TMap 依赖。
   同时供浏览器（window.CreaseModel）与 Node 断言脚本使用。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CreaseModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var R = 6371000.0;
  var D2R = Math.PI / 180;

  function hav(a, b) {
    var la1 = a[0] * D2R, lo1 = a[1] * D2R, la2 = b[0] * D2R, lo2 = b[1] * D2R;
    var s1 = Math.sin((la2 - la1) / 2), s2 = Math.sin((lo2 - lo1) / 2);
    return 2 * R * Math.asin(Math.sqrt(s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2));
  }

  /* 局部平面：从 (lat,lng) 出发，北向 dn 米、东向 de 米 */
  function off(lat, lng, dn, de) {
    return [lat + dn / 111190.0, lng + de / (111190.0 * Math.cos(lat * D2R))];
  }

  /* ---------- 基础指标 ---------- */

  function num(v, lo, hi, fb) {
    var x = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(x)) return fb;
    if (typeof lo === 'number' && x < lo) return lo;
    if (typeof hi === 'number' && x > hi) return hi;
    return x;
  }

  /** 一组耗时的最大不公（秒） */
  function spread(ts) {
    var mx = -Infinity, mn = Infinity;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i] == null || !isFinite(ts[i])) return null;
      if (ts[i] > mx) mx = ts[i];
      if (ts[i] < mn) mn = ts[i];
    }
    return ts.length ? mx - mn : null;
  }

  function maxT(ts) {
    var mx = -Infinity;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i] == null) return null;
      if (ts[i] > mx) mx = ts[i];
    }
    return mx;
  }

  /** 「可接受的最长耗时」倍数：只看 spread 会选到远在天边但恰好等时的点（深圳曾选出 27 km 外） */
  var FAIR_MAXT_K = 1.25;

  /** 候选点里最公平的那个：先筛掉总耗时离谱的，再取最小 spread（并列取 min maxT） */
  function pickFair(cands, n, k) {
    k = (k == null ? FAIR_MAXT_K : k);
    var rows = [];
    for (var i = 0; i < cands.length; i++) {
      var ts = (cands[i].t || []).slice(0, n);
      if (ts.length < n) continue;
      var ok = true;
      for (var j = 0; j < n; j++) if (ts[j] == null || !isFinite(ts[j])) { ok = false; break; }
      if (!ok) continue;
      rows.push({ idx: i, cand: cands[i], spread: spread(ts), maxT: maxT(ts) });
    }
    if (!rows.length) return null;
    var minMax = Infinity;
    for (var m = 0; m < rows.length; m++) minMax = Math.min(minMax, rows[m].maxT);
    var thr = minMax * k;
    var best = -1, bs = Infinity, bm = Infinity;
    for (var q = 0; q < rows.length; q++) {
      if (rows[q].maxT > thr) continue;
      if (rows[q].spread < bs - 1e-9 ||
          (Math.abs(rows[q].spread - bs) <= 1e-9 && rows[q].maxT < bm)) {
        best = q; bs = rows[q].spread; bm = rows[q].maxT;
      }
    }
    if (best < 0) { best = 0; bs = rows[0].spread; bm = rows[0].maxT; }
    return { idx: rows[best].idx, spread: bs, maxT: bm, cand: rows[best].cand,
             thr: thr, nEligible: rows.filter(function (r) { return r.maxT <= thr; }).length };
  }

  /** 公平度评分 0..1：1 = 完全公平（spread 0） */
  function fairness(s, ref) {
    if (s == null) return null;
    if (!(ref > 0)) return s <= 0 ? 1 : 0;
    return Math.max(0, Math.min(1, 1 - s / ref));
  }

  /* ---------- 折痕（等时线） ---------- */

  /**
   * 从采样点提取折痕。samples: [{line, r, ta, tb}]
   * 每条线沿 r 找 Δt = ta - tb 的零点（线性插值），返回按方位角排序的闭合折线。
   * opts.smooth 为 true 时对半径做环形 3 点平滑。
   */
  function crease(city, opts) {
    opts = opts || {};
    var s = city.samples || [];
    var nl = city.nline || 10;
    var byLine = {};
    for (var i = 0; i < s.length; i++) {
      var p = s[i];
      if (p == null || p.ta == null || p.tb == null) continue;
      (byLine[p.line] = byLine[p.line] || []).push(p);
    }
    var raw = [];
    for (var L = 0; L < nl; L++) {
      var row = (byLine[L] || []).slice().sort(function (a, b) { return a.r - b.r; });
      if (row.length < 3) continue;
      var hit = null;
      for (var j = 0; j < row.length - 1; j++) {
        var d0 = row[j].ta - row[j].tb, d1 = row[j + 1].ta - row[j + 1].tb;
        if (d0 === 0) { hit = { r: row[j].r, res: 0, lo: Math.abs(d1) }; break; }
        if (d0 * d1 < 0) {
          var r = row[j].r + (row[j + 1].r - row[j].r) * (-d0) / (d1 - d0);
          hit = { r: r, res: 0, lo: Math.min(Math.abs(d0), Math.abs(d1)),
                  span: Math.abs(d1 - d0) };
          break;
        }
      }
      if (!hit) continue;
      var th = Math.PI * L / nl;
      var rr = hit.r;
      raw.push({ line: L, r: rr, bearing: rr >= 0 ? th : th + Math.PI,
                 abs: Math.abs(rr), res: hit.res, span: hit.span || null });
    }
    raw.sort(function (a, b) { return a.bearing - b.bearing; });

    var radii = raw.map(function (x) { return x.abs; });
    var sm = radii.slice();
    if (opts.smooth !== false && radii.length >= 3) {
      // 轻平滑：折痕的毛刺是真实的，只压掉采样噪声，不把它抹成圆
      for (var k = 0; k < radii.length; k++) {
        var a = radii[(k - 1 + radii.length) % radii.length];
        var b = radii[k];
        var c = radii[(k + 1) % radii.length];
        sm[k] = 0.15 * a + 0.7 * b + 0.15 * c;
      }
    }
    var g = [city.geo.lat, city.geo.lng];
    var pts = raw.map(function (x, k) {
      var rr = sm[k];
      var p = off(g[0], g[1], Math.sin(x.bearing) * rr, Math.cos(x.bearing) * rr);
      return { lat: p[0], lng: p[1], r: rr, rRaw: x.abs, bearing: x.bearing, line: x.line };
    });
    return { points: pts, raw: raw };
  }

  /* ---------- 折痕：规则网格 + marching squares ----------
     之前的径向射线法会把 Δt=0 的不同分支连成假闭环（北京 0° 与 198° 之间空了 180°）。
     等值线必须从规则网格提取，允许断成多段。 */

  function gridValue(g, i, j) {
    if (i < 0 || j < 0 || i >= g.n || j >= g.n) return null;
    var ta = g.ta[j * g.n + i], tb = g.tb[j * g.n + i];
    if (ta == null || tb == null) return null;
    return ta - tb;
  }

  function creaseGrid(city) {
    var g = city.grid;
    if (!g || !g.n) return { polys: [], pts: [] };
    var n = g.n, segs = [];
    function ip(p, q) { return p / (p - q); }        // p、q 异号时求零点位置
    function P(x, y) {
      return [g.la0 + (g.la1 - g.la0) * x / (n - 1),
              g.lo0 + (g.lo1 - g.lo0) * y / (n - 1)];
    }
    for (var i = 0; i < n - 1; i++) {
      for (var j = 0; j < n - 1; j++) {
        var a = gridValue(g, i, j), b = gridValue(g, i + 1, j),
            c = gridValue(g, i + 1, j + 1), d = gridValue(g, i, j + 1);
        if (a == null || b == null || c == null || d == null) continue;
        var idx = (a > 0 ? 8 : 0) | (b > 0 ? 4 : 0) | (c > 0 ? 2 : 0) | (d > 0 ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        var top = [i + ip(a, b), j], right = [i + 1, j + ip(b, c)],
            bot = [i + ip(d, c), j + 1], left = [i, j + ip(a, d)];
        var add = function (p, q) { segs.push([P(p[0], p[1]), P(q[0], q[1])]); };
        switch (idx) {
          case 1: case 14: add(left, bot); break;
          case 2: case 13: add(bot, right); break;
          case 3: case 12: add(left, right); break;
          case 4: case 11: add(top, right); break;
          case 6: case 9: add(top, bot); break;
          case 7: case 8: add(top, left); break;
          case 5: add(top, right); add(left, bot); break;
          case 10: add(top, left); add(bot, right); break;
        }
      }
    }
    // 把相邻段接成折线：端点在容差内就串起来
    var EPS = 1e-9, used = segs.map(function () { return false; }), polys = [];
    var key = function (p) { return p[0].toFixed(9) + '|' + p[1].toFixed(9); };
    var index = {};
    segs.forEach(function (s, k) {
      [key(s[0]), key(s[1])].forEach(function (kk) { (index[kk] = index[kk] || []).push(k); });
    });
    function near(p, q) { return Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9; }
    for (var s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue;
      used[s0] = true;
      var chain = [segs[s0][0], segs[s0][1]];
      var grew = true;
      while (grew) {
        grew = false;
        var tail = chain[chain.length - 1], head = chain[0];
        for (var k2 = 0; k2 < segs.length; k2++) {
          if (used[k2]) continue;
          if (near(segs[k2][0], tail)) { used[k2] = true; chain.push(segs[k2][1]); grew = true; break; }
          if (near(segs[k2][1], tail)) { used[k2] = true; chain.push(segs[k2][0]); grew = true; break; }
          if (near(segs[k2][0], head)) { used[k2] = true; chain.unshift(segs[k2][1]); grew = true; break; }
          if (near(segs[k2][1], head)) { used[k2] = true; chain.unshift(segs[k2][0]); grew = true; break; }
        }
      }
      if (chain.length >= 2) polys.push(chain);
    }
    var pts = [];
    for (var p2 = 0; p2 < polys.length; p2++) {
      for (var q2 = 0; q2 < polys[p2].length; q2++) pts.push(polys[p2][q2]);
    }
    return { polys: polys, pts: pts, n: n };
  }

  /**
   * 折痕的几何统计。折痕是连续的，不依赖候选点集合，所以它才是主结论：
   *   近端半径 = 从「正中间」挪多远就能让两人扯平
   *   远端半径 − 近端半径 = 折痕有多歪（既不圆也不直）
   */
  function creaseStats(city) {
    var cr = creaseGrid(city);
    var pts = cr.pts;
    if (!pts.length) return null;
    var geo = [city.geo.lat, city.geo.lng];
    var iMin = 0, iMax = 0;
    for (var i = 1; i < pts.length; i++) {
      if (hav(geo, pts[i]) < hav(geo, pts[iMin])) iMin = i;
      if (hav(geo, pts[i]) > hav(geo, pts[iMax])) iMax = i;
    }
    var b = function (p) {
      var dn = (p[0] - geo[0]) * 111190.0, de = (p[1] - geo[1]) * 111190.0 * Math.cos(geo[0] * D2R);
      return (Math.atan2(dn, de) + 2 * Math.PI) % (2 * Math.PI);   // 0=东，逆时针
    };
    return {
      polys: cr.polys.map(function (chain) {
        return chain.map(function (p) { return { lat: p[0], lng: p[1] }; });
      }),
      nSeg: cr.polys.length,
      n: pts.length,
      near: hav(geo, pts[iMin]), far: hav(geo, pts[iMax]),
      nearPt: { lat: pts[iMin][0], lng: pts[iMin][1] },
      farPt: { lat: pts[iMax][0], lng: pts[iMax][1] },
      nearBearing: b(pts[iMin]), farBearing: b(pts[iMax])
    };
  }
  creaseStats.span = function (cs) { return cs ? cs.far - cs.near : null; };

  const BEARING_NAME = ['东', '东北', '北', '西北', '西', '西南', '南', '东南'];

  /** 把 (p - geo) 投影到 (target - geo) 方向，>0 表示偏向 target */
  function towardBias(geo, target, p) {
    var lat0 = geo[0], lng0 = geo[1];
    var kx = 111190.0, ky = 111190.0 * Math.cos(lat0 * D2R);
    var tx = (target[0] - lat0) * kx, ty = (target[1] - lng0) * ky;
    var px = (p[0] - lat0) * kx, py = (p[1] - lng0) * ky;
    var n = Math.hypot(tx, ty);
    if (!(n > 1e-6)) return 0;
    return (px * tx + py * ty) / n;
  }

  /** 在几何中点处谁更慢：返回下标（耗时最大者） */
  function slowestAt(ts) {
    var bi = -1, bv = -Infinity;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i] == null) continue;
      if (ts[i] > bv) { bv = ts[i]; bi = i; }
    }
    return bi < 0 ? null : bi;
  }

  /** 方位角（从东起逆时针，弧度）→ 中文方位名 */
  function bearingName(b) {
    var d = ((b * 180 / Math.PI) % 360 + 360) % 360;      // 0=东，逆时针
    var i = Math.round(d / 45) % 8;
    return BEARING_NAME[i];
  }

  /* ---------- 单次求解：给 UI 用 ---------- */

  var MODES = [
    { n: 2, label: '两个人', desc: '你和他' },
    { n: 3, label: '三个人', desc: '饭局' },
    { n: 4, label: '四个人', desc: '小聚' }
  ];

  function solve(city, n) {
    n = Math.max(1, Math.min(city.origins.length, Math.floor(num(n, 1, 4, 2))));
    var cands = city.cands || [];
    var scored = [];
    for (var i = 0; i < cands.length; i++) {
      var ts = (cands[i].t || []).slice(0, n);
      var ok = ts.length === n;
      for (var k = 0; ok && k < n; k++) if (ts[k] == null || !isFinite(ts[k])) ok = false;
      if (!ok) continue;
      scored.push({ i: i, cand: cands[i], ts: ts, spread: spread(ts), maxT: maxT(ts) });
    }
    if (!scored.length) return null;

    var maxSpread = 0;
    for (var m = 0; m < scored.length; m++) maxSpread = Math.max(maxSpread, scored[m].spread);

    var fair = pickFair(cands, n);
    var gts = (city.geo.t || []).slice(0, n);
    var gOK = gts.length === n && gts.every(function (x) { return x != null && isFinite(x); });
    var gSpread = gOK ? spread(gts) : null;

    var geo = [city.geo.lat, city.geo.lng];
    var slow = gOK ? slowestAt(gts) : null;
    var bias = null, offsetKm = null;
    if (fair && slow != null) {
      var fp = [fair.cand.lat, fair.cand.lng];
      var tp = [city.origins[slow].lat, city.origins[slow].lng];
      bias = towardBias(geo, tp, fp);
      offsetKm = hav(geo, fp) / 1000.0;
    }

    for (var q = 0; q < scored.length; q++) {
      scored[q].fairness = fairness(scored[q].spread, maxSpread || 1);
      scored[q].eligible = fair ? scored[q].maxT <= fair.thr + 1e-9 : false;
    }

    var cs = creaseStats(city);

    return {
      n: n,
      scored: scored,
      fair: fair,
      fairSpread: fair ? fair.spread : null,
      geoSpread: gSpread,
      geoMaxT: gOK ? maxT(gts) : null,
      geo: gts,
      offsetKm: offsetKm,
      bias: bias,
      slowIdx: slow,
      refSpread: maxSpread,
      crease: cs
    };
  }

  /** 折痕数据（带缓存） */
  function creaseOf(city, smooth) {
    return crease(city, { smooth: smooth !== false });
  }

  return {
    R: R, hav: hav, off: off, num: num,
    spread: spread, maxT: maxT, pickFair: pickFair, fairness: fairness,
    crease: crease, creaseOf: creaseOf, creaseStats: creaseStats, bearingName: bearingName,
    FAIR_MAXT_K: FAIR_MAXT_K, towardBias: towardBias,
    slowestAt: slowestAt, solve: solve, MODES: MODES
  };
});
