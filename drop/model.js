/* 《落点 · THE DROP》模型层 —— 纯函数，Node 与浏览器共用
   数据 schema（data.js: window.DROP_DATA）:
     cities: [{ name, center:[lat,lng], radii:[r1km,r2km],
                points:[{id,lat,lng,ring,bearing,bname,district,street,poi,addr,
                         poi_cnt:{公司:n,美食:n}, w:number}],
                d:[[米,...]], t:[[秒,...]] }]

   单位约定（全层强制，任何换算只走 toKm / toMin 两个入口）：
     距离 = 米（矩阵里）→ toKm 得公里
     时间 = 秒（矩阵里）→ toMin 得分钟
     金额 = 元
   违背单位约定是本作品历史上最贵的一类 bug，所以这里把换算收敛到两个函数。
*/
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DropModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 计价参数：网约车/出租车公开计价规则的简化估算，页面必须标注「估算」。
     [起步价(元), 起步里程(km), 里程费(元/km), 时长费(元/min)] */
  var FARE = {
    '北京': [13, 3.0, 2.30, 0.50],
    '上海': [14, 3.0, 2.50, 0.50],
    '广州': [12, 2.5, 2.60, 0.50],
    '深圳': [12, 2.0, 2.60, 0.50],
    '成都': [9, 2.0, 1.90, 0.40],
    '西安': [9, 2.0, 1.90, 0.40]
  };

  var FUEL = 0.35;     // 空驶每公里油电成本（元/km）
  var MIN_LOAD = 0.5;  // 载客时长下限（分钟），防止除零
  var D0 = 3.0;        // 空间衰减尺度（km）：派单/出行的距离衰减 exp(-d/D0)
  var INTRA_D = 900;   // 同区单的空驶距离（米）
  var INTRA_T = 180;   // 同区单的空驶时长（秒）
  /* 为什么必须有 INTRA：每个区在数据里是一个点，d(j,j)=0 会让「下一单就在原地」
     的空驶恒为 0，于是任何自给自足的热点区都会算出 0.1 分钟这种荒谬值。
     真实的区是有面积的，同区单平均也要开 900 米 / 3 分钟。 */

  /* 为什么必须有 D0：城市只被离散成 16 个区，若「下一单起点」按全城需求均匀抽，
     任何一次空驶都是跨城级的（15~25 km），得到的是离散化假象而不是现实。
     真实司机接到的是附近的单，所以下一单起点的分布必须在需求权重之上再乘一个距离核。 */

  function num(v, lo, hi, dft) {
    var x = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(x)) return dft;
    if (typeof lo === 'number' && x < lo) return lo;
    if (typeof hi === 'number' && x > hi) return hi;
    return x;
  }
  function toKm(m) { return num(m, 0, 1e8, 0) / 1000; }
  function toMin(s) { return num(s, 0, 1e7, 0) / 60; }

  function fareTable(city) { return FARE[city] || FARE['北京']; }

  /* 车费（元）：起步价 + 超出起步里程的里程费 + 时长费。定义域：km≥0, min≥0 */
  function fare(city, km, min) {
    var f = fareTable(city);
    var k = num(km, 0, 1e5, 0), m = num(min, 0, 1e5, 0);
    return f[0] + Math.max(0, k - f[1]) * f[2] + m * f[3];
  }

  /* 需求分布 P：把每个点的 POI 计数按口径归一化。
     mode: 'sum'(公司+美食) | 'company' | 'food' | 'flat'(均匀) */
  function demand(pts, mode) {
    var n = pts.length, raw = [], i;
    for (i = 0; i < n; i++) {
      var c = pts[i].poi_cnt || {};
      if (mode === 'company') raw.push(num(c['公司'], 0, 1e9, 0));
      else if (mode === 'food') raw.push(num(c['美食'], 0, 1e9, 0));
      else if (mode === 'flat') raw.push(1);
      else raw.push(num(c['公司'], 0, 1e9, 0) + num(c['美食'], 0, 1e9, 0));
    }
    var s = 0;
    for (i = 0; i < n; i++) s += raw[i];
    if (!(s > 0)) { for (i = 0; i < n; i++) raw[i] = 1; s = n; }
    return raw.map(function (x) { return x / s; });
  }

  /* 以 j 为条件的位置分布：需求权重 × 距离衰减核，再归一化。
     G_j(i) ∝ w_i · exp(-d(j,i)/D0)。d0 → ∞ 时退化为全局需求分布 P。 */
  function kernel(pts, D, j, P, d0) {
    var n = pts.length, g = new Array(n), s = 0, i;
    for (i = 0; i < n; i++) {
      var dv = (i === j) ? INTRA_D : ((D[j] && typeof D[j][i] === 'number') ? D[j][i] : -1);
      g[i] = dv < 0 ? 0 : P[i] * Math.exp(-toKm(dv) / d0);
      s += g[i];
    }
    if (!(s > 0)) { for (i = 0; i < n; i++) g[i] = 1 / n; return g; }
    for (i = 0; i < n; i++) g[i] /= s;
    return g;
  }

  /* 可达性：从落点 j 出发，期望要空驶多远 / 多久。
     opts.mode: 'gravity'(默认，用距离衰减核) | 'uniform'(直接用全局需求分布)
     opts.d0:   衰减尺度（km）
     返回 [{ad:km, at:min, G:[...]}]，索引与点一致。 */
  function access(pts, D, T, P, opts) {
    opts = opts || {};
    var mode = opts.mode || 'gravity';
    var d0 = num(opts.d0, 0.05, 1e6, D0);
    var n = pts.length, out = [], i, j;
    for (j = 0; j < n; j++) {
      var G = mode === 'uniform' ? P : kernel(pts, D, j, P, d0);
      var ad = 0, at = 0;
      for (i = 0; i < n; i++) {
        var dv = (i === j) ? INTRA_D : ((D[j] && typeof D[j][i] === 'number') ? D[j][i] : -1);
        var tv = (i === j) ? INTRA_T : ((T[j] && typeof T[j][i] === 'number') ? T[j][i] : -1);
        if (dv < 0 || tv < 0) continue;          // 缺失值不参与
        ad += G[i] * toKm(dv);
        at += G[i] * toMin(tv);
      }
      out.push({ ad: ad, at: at, G: G });
    }
    return out;
  }

  /* 单笔订单指标。p=起点下标, q=落点下标。
     rate  真实时薪（元/h）—— 把「送到那儿之后要空驶多久」算进分母
     rate0 名义时薪（元/h）—— 只算载客时间，导航和计价器给的那个世界
     tax   空驶税 = 空驶时间 / 载客时间
     delta 落点价值（分钟）= 出发地可达性 − 落点可达性，正 = 处境变好 */
  function order(city, D, T, A, p, q) {
    var dv = num(D[p] ? D[p][q] : NaN, 0, 1e8, NaN);
    var tv = num(T[p] ? T[p][q] : NaN, 0, 1e7, NaN);
    if (!isFinite(dv) || !isFinite(tv) || dv < 0 || tv < 0) return null;
    var km = toKm(dv), tLoad = Math.max(MIN_LOAD, toMin(tv));
    var F = fare(city, km, tLoad);
    var atP = A[p] ? A[p].at : 0, atQ = A[q] ? A[q].at : 0;
    var tEmpty = Math.max(0, atQ);
    var tTotal = tLoad + tEmpty;
    var adQ = A[q] ? A[q].ad : 0;
    return {
      p: p, q: q, km: km, tLoad: tLoad, tEmpty: tEmpty, tTotal: tTotal,
      fare: F,
      rate: F / tTotal * 60,
      rate0: F / tLoad * 60,
      rateNet: (F - FUEL * adQ) / tTotal * 60,
      tax: tEmpty / tLoad,
      delta: atP - atQ,
      adQ: adQ, atQ: atQ, atP: atP
    };
  }

  /* 一城全部有向订单（p≠q） */
  function orders(city, data, opts) {
    opts = opts || {};
    var D = data.d, T = data.t, pts = data.points;
    var P = demand(pts, opts.demandMode || 'sum');
    var A = access(pts, D, T, P, opts);
    var out = [], i, j;
    for (i = 0; i < pts.length; i++) {
      for (j = 0; j < pts.length; j++) {
        if (i === j) continue;
        var o = order(city, D, T, A, i, j);
        if (o) out.push(o);
      }
    }
    return { P: P, A: A, list: out };
  }

  function median(a) {
    if (!a.length) return NaN;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }
  function quantile(a, q) {
    if (!a.length) return NaN;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var i = Math.min(b.length - 1, Math.max(0, Math.round(q * (b.length - 1))));
    return b[i];
  }
  function corr(xs, ys) {
    var n = Math.min(xs.length, ys.length);
    if (n < 3) return NaN;
    var mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var sx = 0, sy = 0, sxy = 0;
    for (i = 0; i < n; i++) { var a = xs[i] - mx, b = ys[i] - my; sx += a * a; sy += b * b; sxy += a * b; }
    if (sx <= 0 || sy <= 0) return NaN;
    return sxy / Math.sqrt(sx * sy);
  }
  function rank(a) {
    var idx = a.map(function (v, i) { return [v, i]; }).sort(function (x, y) { return x[0] - y[0]; });
    var r = new Array(a.length);
    for (var i = 0; i < idx.length; i++) r[idx[i][1]] = i;
    return r;
  }
  function spearman(xs, ys) { return corr(rank(xs), rank(ys)); }

  /* 同车费档内的真实时薪极差比 —— 核心命题的量化。
     把订单按车费切成等宽箱（FARE_BIN 元），每箱至少 MIN_N 单，
     取箱内 rate 的 max/min，再取所有箱的中位。 */
  var FARE_BIN = 10, MIN_N = 5;
  function fareBinSpread(list) {
    var bins = {}, i;
    for (i = 0; i < list.length; i++) {
      var k = Math.floor(list[i].fare / FARE_BIN);
      (bins[k] = bins[k] || []).push(list[i]);
    }
    var ratios = [], detail = [];
    Object.keys(bins).forEach(function (k) {
      var b = bins[k];
      if (b.length < MIN_N) return;
      var rs = b.map(function (o) { return o.rate; });
      var lo = Math.min.apply(null, rs), hi = Math.max.apply(null, rs);
      if (lo <= 0) return;
      var r = hi / lo;
      ratios.push(r);
      detail.push({ bin: +k, n: b.length, lo: lo, hi: hi, ratio: r });
    });
    detail.sort(function (a, b) { return a.bin - b.bin; });
    return { median: median(ratios), n: ratios.length, detail: detail };
  }

  /* 城市汇总 */
  function citySummary(city, data, opts) {
    var r = orders(city, data, opts);
    var list = r.list, pts = data.points, A = r.A, P = r.P;
    var ats = A.map(function (x) { return x.at; });
    var zone = A.map(function (x, i) { return { i: i, at: x.at, ad: x.ad, w: pts[i].w }; });
    var best = zone.slice().sort(function (a, b) { return a.at - b.at; })[0];
    var worst = zone.slice().sort(function (a, b) { return b.at - a.at; })[0];
    var ws = zone.map(function (o) { return o.w; });

    /* 空驶时间占比：起点按需求分布，目的地按同一套距离衰减核抽样（稳态）。
       注意这里必须用核：若把 16 个区两两等权，每单都变成跨城单，占比会变成离散化假象。 */
    var d0 = num(opts && opts.d0, 0.05, 1e6, D0);
    var eEmpty = 0, eLoad = 0, i, j;
    for (i = 0; i < pts.length; i++) {
      var H = kernel(pts, data.d, i, P, d0);
      for (j = 0; j < pts.length; j++) {
        if (i === j) continue;
        var o = order(city, data.d, data.t, A, i, j);
        if (!o) continue;
        eLoad += P[i] * H[j] * o.tLoad;
        eEmpty += P[i] * H[j] * o.tEmpty;
      }
    }

    return {
      city: city, pts: pts, P: P, A: A, list: list,
      atMedian: median(ats),
      best: best, worst: worst,
      atRatio: best && worst && best.at > 0 ? worst.at / best.at : NaN,
      corrAtW: corr(ats, ws),
      spread: fareBinSpread(list),
      rateMedian: median(list.map(function (o) { return o.rate; })),
      rate0Median: median(list.map(function (o) { return o.rate0; })),
      taxMedian: median(list.map(function (o) { return o.tax; })),
      emptyShare: eEmpty / (eEmpty + eLoad),
      eEmpty: eEmpty, eLoad: eLoad
    };
  }

  /* 同一个起点出发，找一对「车费几乎一样、真实时薪差最大」的落点。
     这是本作品最硬的一句：不是说贵的单赚得多，而是同样的钱、不同的落点。
     tol = 车费相对差容差（0.06 = 6%）。找不到返回 null。 */
  function contrastPair(list, tol) {
    var t = num(tol, 0.01, 1, 0.06);
    var best = null, i, j;
    for (i = 0; i < list.length; i++) {
      for (j = i + 1; j < list.length; j++) {
        var a = list[i], b = list[j];
        var f1 = Math.min(a.fare, b.fare), f2 = Math.max(a.fare, b.fare);
        if (!(f1 > 0) || f2 / f1 > 1 + t) continue;
        var hi = a.rate >= b.rate ? a : b, lo = a.rate >= b.rate ? b : a;
        var r = hi.rate / Math.max(lo.rate, 1e-9);
        if (!best || r > best.ratio) {
          best = { hi: hi, lo: lo, ratio: r, fareGap: f2 - f1, fareMid: (f1 + f2) / 2 };
        }
      }
    }
    return best;
  }

  /* 空驶计入权重 k 下的时薪：k=1 就是真实时薪，k=0 退化为名义时薪。
     UI 用它做滑块，断言用它锁住两端。 */
  function rateAt(o, k) {
    var kk = num(k, 0, 3, 1);
    var den = o.tLoad + kk * o.tEmpty;
    if (!(den > 0)) return NaN;
    return o.fare / den * 60;
  }

  /* 从某个起点出发的落点排行 */
  function fromPoint(city, data, p, opts) {
    var r = orders(city, data, opts);
    var out = [];
    for (var i = 0; i < r.list.length; i++) if (r.list[i].p === p) out.push(r.list[i]);
    out.sort(function (a, b) { return b.rate - a.rate; });
    return { A: r.A, P: r.P, list: out };
  }

  return {
    FARE: FARE, FUEL: FUEL, MIN_LOAD: MIN_LOAD, FARE_BIN: FARE_BIN, MIN_N: MIN_N, D0: D0,
    INTRA_D: INTRA_D, INTRA_T: INTRA_T,
    num: num, toKm: toKm, toMin: toMin, fare: fare, fareTable: fareTable,
    demand: demand, kernel: kernel, access: access, order: order, orders: orders, rateAt: rateAt,
    contrastPair: contrastPair,
    median: median, quantile: quantile, corr: corr, spearman: spearman,
    fareBinSpread: fareBinSpread, citySummary: citySummary, fromPoint: fromPoint
  };
});
