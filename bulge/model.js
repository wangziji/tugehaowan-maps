/* 地球鼓包 · THE BULGE —— 球面几何模型
 *
 * 全部基于「地球是半径 R 的球」这一条假设，其余全是它的推论。
 * 关键约定：所有「距离」都是**地表大圆弧长**，不是弦长、不是直线距离。
 * 这一步如果搞错，大尺度上的结果会差出 50% 以上（详见 verify.js 断言 13）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var R = 6371.0;            // 地球平均半径 km（IUGG 平均半径 6371.0088 km，此处取整）
  var K_REFRACTION = 0.13;   // 标准大气折射系数（光学视线常用值）

  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }

  /* 等效半径：考虑大气折射时视线会跟着地面弯一点，等价于地球变大了 */
  function effR(refraction) {
    return refraction ? R / (1 - K_REFRACTION) : R;
  }

  /* 大圆距离（地表弧长），km */
  function haversine(lat1, lng1, lat2, lng2) {
    var p1 = rad(lat1), p2 = rad(lat2);
    var dp = p2 - p1, dl = rad(lng2 - lng1);
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /* 弧 d 对应的弦长，km */
  function chord(d, r) { return 2 * (r || R) * Math.sin(d / (2 * (r || R))); }

  /* 矢高 / 鼓包：两点之间地面比直线高出多少，km
   * 弦的半长 R·sin(d/2R)，球心到弦的距离 R·cos(d/2R)，两者之差即鼓包高度 */
  function sagitta(d, r) {
    r = r || R;
    return r * (1 - Math.cos(d / (2 * r)));
  }

  /* 平地近似：d²/(8R)，仅供对照，大尺度上会明显失真 */
  function sagittaFlat(d, r) {
    r = r || R;
    return d * d / (8 * r);
  }

  /* 站在高度 h（km）上，地平线的地表弧长距离，km
   * 由 cos(d/R) = R/(R+h) 反解，是精确式，不是 sqrt(2Rh) 的近似 */
  function horizon(h, r) {
    r = r || R;
    if (h <= 0) return 0;
    return r * Math.acos(r / (r + h));
  }

  /* 视距的反函数：要看到地表距离 d 处，站多高，km
   * 上界：h→∞ 时视距最多到 πR/2 ≈ 10007 km，超过这个距离无论多高都看不见，返回 Infinity。
   * （不这么做的话 cos 会变负，算出「负高度」，页面会印出一个荒谬的负数。） */
  function heightForHorizon(d, r) {
    r = r || R;
    if (d / r >= Math.PI / 2) return Infinity;
    return r / Math.cos(d / r) - r;
  }

  /* 两点高度相同、要对望，各需多高，km；同理有上界 πR */
  function heightSymmetric(d, r) {
    r = r || R;
    if (d / (2 * r) >= Math.PI / 2) return Infinity;
    return r / Math.cos(d / (2 * r)) - r;
  }

  /* 可见球冠面积，km² —— 由 h 直接积分得到，不经由视距，可作交叉校验 */
  function capArea(h, r) {
    r = r || R;
    return 2 * Math.PI * r * r * h / (r + h);
  }

  /* 可见球冠面积（经由视距，独立算法，用于交叉验证） */
  function capAreaByDistance(d, r) {
    r = r || R;
    return 2 * Math.PI * r * r * (1 - Math.cos(d / r));
  }

  function earthArea(r) { r = r || R; return 4 * Math.PI * r * r; }

  /* 绕赤道一圈、相邻两人恰好能互相看见，需要多少人 */
  function ringPeople(eyeHeightKm, r) {
    r = r || R;
    var span = 2 * horizon(eyeHeightKm, r);
    return Math.ceil((2 * Math.PI * r) / span);
  }

  /* 主计算：给定地表距离 d（km），返回这一对点之间的全部几何事实 */
  function solve(d, refraction) {
    var r = effR(refraction);
    var sag = sagitta(d, r);
    return {
      R: r,
      d: d,
      sagittaKm: sag,
      sagittaM: sag * 1000,
      chordKm: chord(d, r),
      // 一人爬高、另一人留在地面
      oneSidedM: heightForHorizon(d, r) * 1000,
      // 两人各爬同样高度
      eachM: heightSymmetric(d, r) * 1000,
      // 平地近似对照（用来说明「近似式在大尺度上不成立」）
      flatApproxM: sagittaFlat(d, r) * 1000
    };
  }

  /* 高度 → 视野：视距、可见面积、占地球表面积比例 */
  function viewFromHeight(hKm, refraction) {
    var r = effR(refraction);
    var d = horizon(hKm, r);
    var a = capArea(hKm, r);
    return {
      hKm: hKm,
      horizonKm: d,
      areaKm2: a,
      fraction: a / earthArea(r),
      people: ringPeople(hKm, r)
    };
  }

  return {
    R: R, K_REFRACTION: K_REFRACTION,
    rad: rad, deg: deg, effR: effR,
    haversine: haversine, chord: chord,
    sagitta: sagitta, sagittaFlat: sagittaFlat,
    horizon: horizon, heightForHorizon: heightForHorizon,
    heightSymmetric: heightSymmetric,
    capArea: capArea, capAreaByDistance: capAreaByDistance,
    earthArea: earthArea, ringPeople: ringPeople,
    solve: solve, view: viewFromHeight
  };
});
