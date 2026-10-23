/* 《时间价签 · PRICE OF A MINUTE》模型层 —— 纯函数，Node 与浏览器共用
   数据 schema:
     cities: [{city, fare:[base(元), baseKm(km), perKm(元/km), perMin(元/min)],
               ods:[{from,to,a:[lat,lng],b:[lat,lng],straight(m),
                     drive:{d(m),t(min)}, transit:{d,t,price(分)}, bike:{d,t}}]}]

   单位约定（全层强制）：距离 = 米；时间 = 分钟；金额 = 元。
   任何跨单位换算都集中在本文件的 toKm / toHour 两个函数里。
*/
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MinuteModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var WAIT_TAXI = 3.0;   // 打车平均等车时间（分钟），是真实成本，显式建模
  var BIKE_FARE = 1.5;   // 共享单车单次（元）

  function num(v, lo, hi, dft) {
    var x = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(x)) return dft;
    if (typeof lo === 'number' && x < lo) return lo;
    if (typeof hi === 'number' && x > hi) return hi;
    return x;
  }

  /* 米 -> 公里（唯一换算入口） */
  function toKm(m) { return num(m, 0, 1e7, 0) / 1000; }
  /* 分钟 -> 小时（唯一换算入口） */
  function toHour(min) { return num(min, 0, 1e5, 0) / 60; }

  /* 打车费：起步价 + 里程费 + 时长费。三档结构，无隐藏项。 */
  function taxiFare(distM, durMin, fare) {
    var km = toKm(distM), t = num(durMin, 0, 1e4, 0);
    var base = num(fare && fare[0], 0, 100, 0);
    var baseKm = num(fare && fare[1], 0, 20, 0);
    var perKm = num(fare && fare[2], 0, 20, 0);
    var perMin = num(fare && fare[3], 0, 20, 0);
    return base + perKm * Math.max(0, km - baseKm) + perMin * t;
  }

  /* 一个 OD 的三档方案。cost 元 / time 分钟 / dist 米
     wait 可覆盖等车时间（用于参数不敏感性检验） */
  function options(od, fare, wait) {
    var w = (typeof wait === 'number') ? wait : WAIT_TAXI;
    var dr = od.drive || {}, tr = od.transit || {}, bk = od.bike || {};
    var tDrive = num(dr.t, 0, 1e4, NaN);
    var tTran = num(tr.t, 0, 1e4, NaN);
    var tBike = num(bk.t, 0, 1e4, NaN);
    var out = [
      { key: 'taxi', label: '打车', cost: taxiFare(dr.d, tDrive, fare),
        time: tDrive + w, dist: num(dr.d, 0, 1e7, NaN) },
      { key: 'transit', label: '公交地铁', cost: num(tr.price, 0, 1e6, NaN) / 100,
        time: tTran, dist: num(tr.d, 0, 1e7, NaN) },
      { key: 'bike', label: '骑行', cost: BIKE_FARE,
        time: tBike, dist: num(bk.d, 0, 1e7, NaN) }
    ];
    out.forEach(function (o) {
      o.valid = isFinite(o.cost) && isFinite(o.time) && o.time > 0 && o.cost >= 0;
    });
    return out.filter(function (o) { return o.valid; });
  }

  /* 帕累托前沿：按耗时升序，只保留「更快就更贵」的档。
     被支配的档（又慢又贵）直接剔除 —— 它不可能成为任何时薪下的答案。 */
  function frontier(opts) {
    var s = opts.slice().sort(function (a, b) { return a.time - b.time; });
    var out = [];
    for (var i = 0; i < s.length; i++) {
      // 若已存在一档「不慢于它且更便宜」，则它被支配
      var dominated = false;
      for (var j = 0; j < s.length; j++) {
        if (i === j) continue;
        if (s[j].time <= s[i].time && s[j].cost < s[i].cost) { dominated = true; break; }
      }
      if (!dominated) out.push(s[i]);
    }
    return out.sort(function (a, b) { return a.time - b.time; });
  }

  /* 省时不足 MIN_DT 分钟的升档不给出临界时薪：
     耗时是整分钟量化的，Δt=1~2 分钟时比值会被量化噪声放大到上千元/小时，
     那是假指标不是结论。定义域写死，越界返回 null。 */
  var MIN_DT = 5.0;

  /* 相邻档的临界时薪（元/小时）：
     从慢档 a 升到快档 b，省下 Δt 分钟、多花 Δc 元，
     R* = 60 × Δc / Δt。你的时薪 > R* 就该升档。 */
  function threshold(a, b) {
    var dt = a.time - b.time;      // > 0
    var dc = b.cost - a.cost;      // > 0
    if (!(dt > 0) || !(dc > 0)) return null;
    if (dt < MIN_DT) return null;  // 省时不足 5 分钟 —— 不值得讨论，也不该出数字
    return 60 * dc / dt;
  }

  /* 总成本 = 钱 + 时间 × 时薪（元） */
  function totalCost(opt, hourly) {
    var R = num(hourly, 0, 1e6, 0);
    return opt.cost + R * toHour(opt.time);
  }

  /* 给定时薪，最优档 */
  function best(opts, hourly) {
    var bestOpt = null, bestVal = Infinity;
    opts.forEach(function (o) {
      var v = totalCost(o, hourly);
      if (v < bestVal - 1e-9) { bestVal = v; bestOpt = o; }
    });
    return bestOpt;
  }

  /* 一个 OD 的完整剖面 */
  function profile(od, fare, wait) {
    var all = options(od, fare, wait);
    var fr = frontier(all);
    // fr 按耗时升序（最快的在前）。升档方向 = 从更慢更便宜的 fr[i+1] 到更快更贵的 fr[i]。
    var steps = [];
    for (var i = 0; i + 1 < fr.length; i++) {
      var slow = fr[i + 1], fast = fr[i];
      var R = threshold(slow, fast);
      if (R === null) continue;
      steps.push({ from: slow.key, to: fast.key,
                   fromLabel: slow.label, toLabel: fast.label,
                   dTime: slow.time - fast.time,
                   dCost: fast.cost - slow.cost,
                   threshold: R });
    }
    return { all: all, frontier: fr, steps: steps,
             dropped: all.filter(function (o) { return fr.indexOf(o) < 0; }) };
  }

  /* 固定一个「升级动作」的临界时薪：例如从公交升到打车。
     找不到该动作（某一档缺失 / 方向不成立）时返回 null，绝不返回负数或 0。 */
  function stepThreshold(pf, slowKey, fastKey) {
    for (var i = 0; i < pf.steps.length; i++) {
      if (pf.steps[i].from === slowKey && pf.steps[i].to === fastKey) return pf.steps[i].threshold;
    }
    return null;
  }

  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* 一城聚合：每条 OD 一个剖面，取中位数 */
  function citySummary(cityObj) {
    var pfs = cityObj.ods.map(function (od) { return profile(od, cityObj.fare); });
    var taxiUp = [], bikeUp = [];
    pfs.forEach(function (pf) {
      var a = stepThreshold(pf, 'transit', 'taxi');   // 公交 -> 打车
      if (a !== null) taxiUp.push(a);
      var b = stepThreshold(pf, 'bike', 'transit');   // 骑行 -> 公交
      if (b !== null) bikeUp.push(b);
    });
    return { city: cityObj.city, n: pfs.length, pfs: pfs,
             taxiUp: taxiUp, bikeUp: bikeUp,
             taxiUpMed: median(taxiUp), bikeUpMed: median(bikeUp) };
  }

  return {
    WAIT_TAXI: WAIT_TAXI, BIKE_FARE: BIKE_FARE, MIN_DT: MIN_DT,
    num: num, toKm: toKm, toHour: toHour,
    taxiFare: taxiFare, options: options, frontier: frontier,
    threshold: threshold, totalCost: totalCost, best: best,
    profile: profile, stepThreshold: stepThreshold, median: median,
    citySummary: citySummary
  };
});
