/* 《错过 · THE MISS》模型层
 *
 * 纯函数，不碰 DOM，可在 Node 下直接跑断言。
 *
 * 单位纪律（与 verify.js 的单位锁一一对应）：
 *   dist / cost / shadow / typical   —— 米
 *   dur / costMin / annualMin        —— 分钟
 *   speed                            —— 米/分钟（= dist / dur）
 *   任何「分钟 = 米 / speed」，代码里绝不出现 /60 或 *60 去补单位；
 *   只有「分钟 -> 小时」这一步才除以 60，且只在 annualHours 一处。
 */
(function (root) {
  'use strict';

  function num(v, def) {
    var x = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(x) ? x : def;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var h = a.length >> 1;
    return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
  }

  /* 一个弯在给定 k 档下的代价（米）。
   * 负代价真实存在：说明从错误点重新规划反而更短，即原路线在这个弯之后绕了路。 */
  function turnCost(t, k) {
    if (!t || !t.costs) return null;
    var want = num(k, 1);
    var ks = Object.keys(t.costs);
    if (!ks.length) return null;
    // 按数值取最接近的一档（键是字符串 '0.33' / '1.0' / '2.5'，不能按字符串精确匹配），
    // 且 key 有可能缺失对应档位，必须先判存在再取值。
    var best = null, bestGap = Infinity;
    ks.forEach(function (key) {
      var v = num(key, NaN);
      if (!isFinite(v)) return;
      var gap = Math.abs(v - want);
      if (gap < bestGap) { bestGap = gap; best = key; }
    });
    if (best === null || !t.costs[best]) return null;
    return num(t.costs[best].m, null);
  }

  /* 一种出行方式的全部派生指标 */
  function modeStats(mode, opts) {
    opts = opts || {};
    var k = num(opts.k, 1.0);
    var eps = num(opts.eps, 0.02);
    var trips = num(opts.tripsPerYear, 500);
    var speed = num(mode.speed, 0) || (num(mode.dist, 0) / Math.max(0.5, num(mode.dur, 1)));

    var turns = (mode.turns || []).map(function (t) {
      var c = turnCost(t, k);
      return {
        s: t.s, deg: t.deg, road: t.road, p: t.p,
        cost: c, costMin: c === null ? null : c / Math.max(1e-6, speed)
      };
    }).filter(function (t) { return t.cost !== null; });

    var costs = turns.map(function (t) { return t.cost; });
    var pos = costs.filter(function (c) { return c > 0; });
    var neg = costs.filter(function (c) { return c < 0; });
    var zero = costs.filter(function (c) { return c === 0; });
    var shadow = pos.reduce(function (a, b) { return a + b; }, 0);
    var leak = neg.reduce(function (a, b) { return a + b; }, 0);
    var fatal = costs.length ? Math.max.apply(null, costs) : 0;
    var fi = costs.length ? costs.indexOf(fatal) : -1;

    // typRisk：只看「真的会亏」的那些弯的中位数。
    // 典型代价可能为 0 或负（骑行/步行走错几乎不要钱），倍数在那里没有意义，
    // 所以倍数列一律用 typRisk，它恒为正。
    var typRisk = median(pos);

    var expM = eps * shadow;
    var expMin = expM / Math.max(1e-6, speed);
    return {
      key: mode.key, name: mode.name, Lbase: mode.Lbase,
      dist: num(mode.dist, 0), dur: num(mode.dur, 0), speed: speed,
      nTurns: turns.length, turns: turns,
      typical: median(costs), typRisk: typRisk, fatal: fatal,
      fatalTurn: fi >= 0 ? turns[fi] : null,
      worstTurn: null,
      shadow: shadow, leak: leak,
      shadowRatio: num(mode.dist, 0) > 0 ? shadow / num(mode.dist, 0) : 0,
      riskN: pos.length, luckyN: neg.length, zeroN: zero.length,
      expM: expM, expMin: expMin,
      realMin: num(mode.dur, 0) + expMin,
      annualMin: trips * expMin,
      annualHours: trips * expMin / 60,
      bufferMin: fatal / Math.max(1e-6, speed)   // 为了 95% 不迟到，至少留出的余量
    };
  }

  /* 一个城市：三种方式 + 跨方式的对比结论 */
  function cityStats(city, opts) {
    opts = opts || {};
    var modes = (city.modes || []).map(function (m) { return modeStats(m, opts); });
    var by = {};
    modes.forEach(function (m) { by[m.key] = m; });
    var drive = by.drive || null, bike = by.bike || null, walk = by.walk || null;

    var fatalTurn = null, fatalMode = null;
    modes.forEach(function (m) {
      if (m.fatalTurn && (!fatalTurn || m.fatalTurn.cost > fatalTurn.cost)) {
        fatalTurn = m.fatalTurn; fatalMode = m;
      }
    });

    /* 容错倍数：一律用「正代价中位数」做分母，保证两侧恒正、倍数有物理意义。
     * 分母下界取 1 米，避免出现除零或荒谬的大数。 */
    function ratio(a, b) {
      if (!a || !b) return null;
      var den = Math.max(1, b.typRisk);
      return a.typRisk / den;
    }
    return {
      code: city.code, city: city.city,
      from: city.from, to: city.to, fromName: city.fromName, toName: city.toName,
      modes: modes, by: by, drive: drive, bike: bike, walk: walk,
      fatalTurn: fatalTurn, fatalMode: fatalMode,
      ratioDriveWalk: ratio(drive, walk),
      ratioDriveBike: ratio(drive, bike),
      // 一次最惨的错过，吃掉多少「开车相对骑车省下的时间」。
      // 只在开车确实更快时才有意义：西安这类「骑车反而更快」的城市必须返回 null，
      // 而不是让分母趋零算出一个十亿百分比。
      bite: (drive && bike && bike.dur > drive.dur)
        ? (drive.fatal / Math.max(1e-6, drive.speed)) / (bike.dur - drive.dur) : null,
      bikeFaster: !!(drive && bike && bike.dur <= drive.dur)
    };
  }

  /* 按「驾车的典型错过代价」降序排行 */
  function rank(cities, opts) {
    return (cities || []).map(function (c) { return cityStats(c, opts); })
      .filter(function (c) { return c.drive; })
      .sort(function (a, b) { return b.drive.typRisk - a.drive.typRisk; });
  }

  var API = { num: num, median: median, turnCost: turnCost,
              modeStats: modeStats, cityStats: cityStats, rank: rank };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.MISS = API;
})(typeof window !== 'undefined' ? window : globalThis);
