/* 《三岔口 · THE TRIDENT》模型层：门到门时间的三种拆法。
 *
 * 口径一句话：城际出行不是「一段长途」，而是「两趟同城出行 + 一段长途」。
 * 自驾：全程在车轮上（另加疲劳休息）。
 * 高铁：接驳到站 + 候车 + 车上 + 出站接驳。
 * 飞机：接驳到机场 + 提前到场 + 空中 + 落地接驳。
 *
 * 可实测的部分（全部来自腾讯地图 WebService，已打包进 data.js）：
 *   两端接驳时间、自驾门到门里程/时长、两城直线距离。
 * 需要建模的部分（公开典型值，页面上可滑杆调整并已标注为估算）：
 *   高铁在途（铁路里程 ÷ 平均旅行速度）、飞行在途（航路 ÷ 巡航速度 + 起降滑行）。
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    railSpeed: 280,      // km/h，G 车平均旅行速度（含停站后的全程均速）
    railDetour: 1.10,    // 铁路里程 ≈ 自驾里程 × 1.10
    railWait: 30,        // 候车 min
    airSpeed: 750,       // km/h 巡航
    airDetour: 1.02,     // 航路 ≈ 直线 × 1.02
    airGround: 25,       // 起降 + 滑行 + 廊桥 min
    airEarly: 90,        // 提前到机场 min（值机 + 安检 + 步行到登机口）
    carRestEvery: 240,   // 每开这么久
    carRest: 30          // 就歇这么久
  };

  function num(v, lo, hi, fb) {
    var x = Number(v);
    if (!isFinite(x)) return fb;
    if (typeof lo === 'number' && x < lo) x = lo;
    if (typeof hi === 'number' && x > hi) x = hi;
    return x;
  }

  /** 参数归一化：任何脏输入都收进合法域，绝不返回 NaN。 */
  function normParams(p) {
    p = p || {};
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    o.railSpeed = num(p.railSpeed, 60, 500, DEFAULTS.railSpeed);
    o.railDetour = num(p.railDetour, 0.8, 1.6, DEFAULTS.railDetour);
    o.railWait = num(p.railWait, 0, 180, DEFAULTS.railWait);
    o.airSpeed = num(p.airSpeed, 200, 1100, DEFAULTS.airSpeed);
    o.airDetour = num(p.airDetour, 0.9, 1.4, DEFAULTS.airDetour);
    o.airGround = num(p.airGround, 0, 120, DEFAULTS.airGround);
    o.airEarly = num(p.airEarly, 0, 240, DEFAULTS.airEarly);
    o.carRestEvery = num(p.carRestEvery, 60, 600, DEFAULTS.carRestEvery);
    o.carRest = num(p.carRest, 0, 120, DEFAULTS.carRest);
    return o;
  }

  /** 自驾：门到门里程/时长实测，疲劳休息按每 carRestEvery 分钟加一次。 */
  function carTrip(dmin, p) {
    var drive = Math.max(0, num(dmin, 0, 100000, 0));
    var rest = Math.floor(drive / p.carRestEvery) * p.carRest;
    return {
      total: drive + rest,
      ride: drive,
      ground: rest,
      parts: [
        { k: 'drive', label: '车轮上', v: drive },
        { k: 'rest', label: '途中休息', v: rest }
      ].filter(function (x) { return x.v > 0; })
    };
  }

  /** 高铁：铁路里程由自驾里程折算，速度可滑杆调。 */
  function railTrip(dkm, accA, accB, p) {
    var km = Math.max(1, num(dkm, 1, 100000, 1) * p.railDetour);
    var ride = km / p.railSpeed * 60;
    var t = { total: accA + p.railWait + ride + accB, ride: ride,
              ground: accA + p.railWait + accB, railKm: km };
    t.parts = [
      { k: 'accA', label: '出发地 → 高铁站', v: accA },
      { k: 'wait', label: '候车检票', v: p.railWait },
      { k: 'ride', label: '车上', v: ride },
      { k: 'accB', label: '高铁站 → 目的地', v: accB }
    ].filter(function (x) { return x.v > 0; });
    return t;
  }

  /** 飞机：空中段由直线距离折算，地面段（提前到场 + 两端接驳 + 起降滑行）单独计。 */
  function airTrip(sd, accA, accB, p) {
    var km = Math.max(1, num(sd, 1, 100000, 1) * p.airDetour);
    var fly = km / p.airSpeed * 60;
    var ground = p.airEarly + accA + accB + p.airGround;
    var t = { total: ground + fly, ride: fly, ground: ground, flyKm: km };
    t.parts = [
      { k: 'accA', label: '出发地 → 机场', v: accA },
      { k: 'early', label: '提前到场值机安检', v: p.airEarly },
      { k: 'fly', label: '空中', v: fly },
      { k: 'ground', label: '起降滑行', v: p.airGround },
      { k: 'accB', label: '机场 → 目的地', v: accB }
    ].filter(function (x) { return x.v > 0; });
    return t;
  }

  /** 一个城市对的三种门到门方案。acc 可覆盖为「你自己的接驳时间」。 */
  function evaluate(pair, cityA, cityB, params, acc) {
    var p = normParams(params);
    acc = acc || {};
    var aR = num(acc.aRail, 0, 600, cityA.station.acc_min);
    var aA = num(acc.aAir, 0, 600, cityA.airport.acc_min);
    var bR = num(acc.bRail, 0, 600, cityB.station.acc_min);
    var bA = num(acc.bAir, 0, 600, cityB.airport.acc_min);

    var car = carTrip(pair.dmin, p);
    var rail = railTrip(pair.dkm, aR, bR, p);
    var air = airTrip(pair.sd, aA, bA, p);
    var modes = { car: car, rail: rail, air: air };
    var win = 'car';
    for (var m in modes) if (modes[m].total < modes[win].total) win = m;
    // 并列（差 < 0.5 min）时按「更省心」排序：高铁 > 自驾 > 飞机
    var tol = 0.5;
    if (Math.abs(rail.total - car.total) <= tol) win = 'rail';
    if (Math.abs(air.total - modes[win].total) <= tol && air.total < modes[win].total) win = 'air';

    return {
      sd: pair.sd, dkm: pair.dkm, dmin: pair.dmin,
      car: car, rail: rail, air: air,
      win: win,
      margin: (function () {
        var ts = ['car', 'rail', 'air'].map(function (m) { return modes[m].total; }).sort(function (a, b) { return a - b; });
        return ts[1] - ts[0];
      })(),
      airGroundRatio: air.ground / air.total,
      railGroundRatio: rail.ground / rail.total,
      accDelta: (aA + bA) - (aR + bR),
      accSum: { rail: aR + bR, air: aA + bA }
    };
  }

  /** 相图：给定直线距离 d 与「机场比高铁站远多少」Δ，预测胜者。
   *  接驳基准取 railAccBase（两端高铁接驳之和），机场接驳 = 基准 + Δ。 */
  function predict(d, delta, railAccBase, p) {
    p = normParams(p);
    var d = num(d, 1, 20000, 1);
    var base = num(railAccBase, 0, 600, 60);
    var accR = base;
    var accA = Math.max(0, base + num(delta, -200, 400, 0));
    // 自驾里程/时长按全样本典型关系折算：dkm ≈ 1.184 d，均速 93 km/h
    var dkm = d * 1.184;
    var dmin = dkm / 93 * 60;
    var car = carTrip(dmin, p);
    var rail = railTrip(dkm, accR / 2, accR / 2, p);
    var air = airTrip(d, accA / 2, accA / 2, p);
    var best = 'car', bt = car.total;
    if (rail.total < bt - 0.5) { best = 'rail'; bt = rail.total; }
    if (air.total < bt - 0.5) { best = 'air'; bt = air.total; }
    return best;
  }

  /** 高铁 vs 飞机的解析切换距离（min）。解 0.279 d + A_r + 30 = 0.0816 d + A_a + 115。 */
  function railAirBreak(delta, railAccBase, p) {
    p = normParams(p);
    var base = num(railAccBase, 0, 600, 60);
    var kR = (1.184 * p.railDetour) / p.railSpeed * 60;   // min/km
    var kA = p.airDetour / p.airSpeed * 60;               // min/km
    var cR = base + p.railWait;
    var cA = Math.max(0, base + num(delta, -200, 400, 0)) + p.airEarly + p.airGround;
    var den = kR - kA;
    if (den <= 1e-9) return Infinity;
    return (cA - cR) / den;
  }

  /** 自驾 vs 高铁的解析切换距离（min）。解 0.764 d = A_r + 30 + k_r d。 */
  function carRailBreak(railAccBase, p) {
    p = normParams(p);
    var base = num(railAccBase, 0, 600, 60);
    var kR = (1.184 * p.railDetour) / p.railSpeed * 60;
    var kC = 1.184 / 93 * 60;
    var den = kC - kR;
    if (den <= 1e-9) return Infinity;
    return (base + p.railWait) / den;
  }

  var API = {
    DEFAULTS: DEFAULTS,
    normParams: normParams,
    carTrip: carTrip,
    railTrip: railTrip,
    airTrip: airTrip,
    evaluate: evaluate,
    predict: predict,
    railAirBreak: railAirBreak,
    carRailBreak: carRailBreak
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.TridentModel = API;
})(typeof window !== 'undefined' ? window : globalThis);
