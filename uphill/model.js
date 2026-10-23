/* 《上坡 · UPHILL》模型层：纯函数，无 DOM / 无 SDK 依赖，Node 与浏览器共用。
   核心事实：从 A 到 B 与从 B 到 A，是两条不同的路。 */
(function (root) {
  'use strict';

  var R_EARTH = 6371000.0;
  var WORKDAYS = 250;          // 一年通勤天数（法定工作日约 250）
  var BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];
  var BEARING_NAMES = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'];
  var MEASURED_DISTS = [3000, 8000];
  var D_MIN = 800, D_MAX = 15000;

  function num(v, lo, hi, dft) {
    var x = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(x)) return dft;
    return Math.max(lo, Math.min(hi, x));
  }

  function rad(d) { return d * Math.PI / 180; }

  function haversine(a, b) {
    var la1 = rad(a[0]), lo1 = rad(a[1]), la2 = rad(b[0]), lo2 = rad(b[1]);
    var s1 = Math.sin((la2 - la1) / 2), s2 = Math.sin((lo2 - lo1) / 2);
    return 2 * R_EARTH * Math.asin(Math.sqrt(s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2));
  }

  /* 由起点、方位角（正北 0，顺时针）、距离求终点。局部平面近似，与采集脚本一致。 */
  function destPoint(lat, lng, bearingDeg, distM) {
    var b = rad(bearingDeg);
    return [lat + distM * Math.cos(b) / 111320.0,
            lng + distM * Math.sin(b) / (111320.0 * Math.cos(rad(lat)))];
  }

  function bearingOf(a, b) {
    var la1 = rad(a[0]), la2 = rad(b[0]), dl = rad(b[1] - a[1]);
    var y = Math.sin(dl) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  /* 不对称度：正 = 去程更贵（从中心走出去更远/更久），负 = 回程更贵。 */
  function asym(go, back) {
    var m = (go + back) / 2;
    if (!(m > 0)) return 0;
    return (go - back) / m;
  }

  /* 把一条实测路线对（含 3000 / 8000 两档）插值到任意直线距离 d。
     区间内线性插值；区间外用最近档按比例缩放，并标记 extrapolated。 */
  function interpPair(byDist, d) {
    d = num(d, D_MIN, D_MAX, 3000);
    var lo = MEASURED_DISTS[0], hi = MEASURED_DISTS[1];
    var a = byDist[lo], b = byDist[hi];
    if (!a || !b) return null;
    var f, k;
    if (d <= lo) {            // 短于实测：以 lo 档为基准按比例缩放
      k = d / lo; f = 0;
    } else if (d >= hi) {     // 长于实测：以 hi 档为基准按比例缩放
      k = d / hi; f = 1;
    } else {
      k = 1; f = (d - lo) / (hi - lo);
    }
    function mix(x, y) {
      var base = x + (y - x) * f;
      return base * k;
    }
    return {
      go_d: mix(a.go_d, b.go_d), bk_d: mix(a.bk_d, b.bk_d),
      go_t: mix(a.go_t, b.go_t), bk_t: mix(a.bk_t, b.bk_t),
      extrap: d < lo || d > hi
    };
  }

  /* 一年通勤小时数：每天一趟往返，共 WORKDAYS 天。 */
  function yearHours(roundTripMin, days) {
    days = num(days, 1, 365, WORKDAYS);
    var m = num(roundTripMin, 0, 24 * 60, 0);
    return m * days / 60;
  }

  /* 汇总一个采样中心在给定直线距离下的八方位账本。 */
  function bearingLedger(center, d) {
    var byB = {};
    center.routes.forEach(function (r) { byB[r.b] = byB[r.b] || {}; byB[r.b][r.d] = r; });
    var rows = [];
    BEARINGS.forEach(function (b) {
      var pair = interpPair(byB[b], d);
      if (!pair) return;
      var rt = pair.go_t + pair.bk_t;
      rows.push({
        b: b,
        name: BEARING_NAMES[BEARINGS.indexOf(b)],
        go_d: pair.go_d, bk_d: pair.bk_d,
        go_t: pair.go_t, bk_t: pair.bk_t,
        round_d: pair.go_d + pair.bk_d,
        round_t: rt,
        year_h: yearHours(rt),
        asym_d: asym(pair.go_d, pair.bk_d),
        asym_t: asym(pair.go_t, pair.bk_t),
        extrap: pair.extrap,
        endpoint: destPoint(center.lat, center.lng, b, num(d, D_MIN, D_MAX, 3000))
      });
    });
    rows.sort(function (x, y) { return x.round_t - y.round_t; });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    return rows;
  }

  /* 城市坡度：该城所有路线对的 |asym| 均值与极值。 */
  function citySlope(city) {
    var ad = [], at = [], worst = null;
    city.centers.forEach(function (ce) {
      ce.routes.forEach(function (r) {
        var x = asym(r.go_d, r.bk_d), y = asym(r.go_t, r.bk_t);
        ad.push(Math.abs(x)); at.push(Math.abs(y));
        if (!worst || Math.abs(y) > Math.abs(worst.asym_t)) {
          worst = { city: city.name, center: ce.name, b: r.b, d: r.d, sd: r.sd,
                    go_d: r.go_d, bk_d: r.bk_d, go_t: r.go_t, bk_t: r.bk_t,
                    asym_d: x, asym_t: y };
        }
      });
    });
    return {
      id: city.id, name: city.name,
      mean_d: mean(ad), mean_t: mean(at), max_t: Math.max.apply(null, at),
      worst: worst
    };
  }

  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  var API = {
    R_EARTH: R_EARTH, WORKDAYS: WORKDAYS, BEARINGS: BEARINGS, BEARING_NAMES: BEARING_NAMES,
    MEASURED_DISTS: MEASURED_DISTS, D_MIN: D_MIN, D_MAX: D_MAX,
    num: num, rad: rad, haversine: haversine, destPoint: destPoint, bearingOf: bearingOf,
    asym: asym, interpPair: interpPair, yearHours: yearHours,
    bearingLedger: bearingLedger, citySlope: citySlope, mean: mean, median: median
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.UPHILL = API;
  // 浏览器里 root 就是 window；Node 冒烟沙箱里 window 是桩对象，两处都挂，保证 app.js 取得到
  if (root && root.window && root.window !== root) root.window.UPHILL = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
