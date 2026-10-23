/* 地球鼓包 · 断言脚本 —— 先于 UI 编写。
 *
 * 纪律：凡是要在页面上印出来的具体数字，先在这里变成一条会 FAIL 的测试。
 * 这次要重点盯「平地近似式在大尺度上失效」这一类静默错误。
 */
var BM = require('./model.js');

var pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + '   ' + detail); }
}
function near(actual, lo, hi, name) {
  ok(actual >= lo && actual <= hi, name,
     'got=' + (typeof actual === 'number' ? actual.toPrecision(6) : actual) +
     ' expect=[' + lo + ', ' + hi + ']');
}
function relErr(a, b) { return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)); }

console.log('\n=== A. 地球基本量 ===');
near(BM.earthArea() / 1e6, 509, 511, 'A1 地球表面积 ≈ 5.10 亿 km²');
near(2 * Math.PI * BM.R, 40000, 40050, 'A2 赤道周长 ≈ 40030 km');

console.log('\n=== B. 鼓包（矢高） ===');
var s100 = BM.sagitta(100) * 1000;
near(s100, 195, 197, 'B1 d=100km 时中间隆起 ≈ 196 m');
near(BM.sagitta(1000) * 1000, 19500, 19700, 'B2 d=1000km 时隆起 ≈ 19.6 km');
near(BM.sagitta(1) * 1000, 0.019, 0.020, 'B3 d=1km 时隆起 ≈ 2 cm');
ok(relErr(BM.sagitta(100), BM.sagittaFlat(100)) < 0.001,
   'B4 小尺度下精确式与 d²/(8R) 一致', 'rel=' + relErr(BM.sagitta(100), BM.sagittaFlat(100)).toExponential(2));
var b5rel = (BM.sagittaFlat(5200) - BM.sagitta(5200)) / BM.sagitta(5200);
ok(BM.sagittaFlat(5200) > BM.sagitta(5200) && b5rel > 0.005 && b5rel < 0.03,
   'B5 平地近似 d²/(8R) 在大尺度上高估约 1.4%（方向是「高估」，不是低估）',
   'exact=' + BM.sagitta(5200).toFixed(1) + 'km flat=' + BM.sagittaFlat(5200).toFixed(1) + 'km rel=' + (b5rel * 100).toFixed(2) + '%');
ok(BM.sagitta(100) < 50, 'B6 鼓包高度远小于距离的一半', BM.sagitta(100).toFixed(3) + ' << 50 km');

console.log('\n=== C. 视距 ===');
near(BM.horizon(0.0017), 4.5, 4.8, 'C1 人眼高 1.7 m，地平线 ≈ 4.65 km');
near(BM.horizon(8.84886), 330, 345, 'C2 珠峰顶 8848.86 m，地平线 ≈ 335 km');
near(BM.horizon(0.3), 58, 66, 'C3 100 层楼 300 m，地平线 ≈ 62 km');
near(BM.horizon(10.6), 355, 380, 'C4 民航巡航 10.6 km，地平线 ≈ 367 km');
ok(Math.abs(BM.heightForHorizon(BM.horizon(1.234)) - 1.234) < 1e-9,
   'C5 视距与其反函数严格互逆', 'h=1.234km');

console.log('\n=== D. 要看见对方，得爬多高 ===');
var p = BM.solve(100);
near(p.sagittaM, 195, 197, 'D1 100km 两人之间隆起 196 m');
near(p.eachM, 195, 197, 'D2 两人各爬 196 m 即可对望');
ok(relErr(p.eachM, p.sagittaM) < 0.005,
   'D3 关键巧合：各爬的高度 ≈ 中间隆起的高度（这是全篇的核心数字）',
   'each=' + p.eachM.toFixed(2) + 'm sag=' + p.sagittaM.toFixed(2) + 'm');
near(p.oneSidedM, 780, 790, 'D4 只有一人爬时需 785 m ≈ 4 倍');
ok(relErr(p.oneSidedM, 4 * p.sagittaM) < 0.01, 'D5 单侧高度 ≈ 4 × 鼓包（小尺度成立）');
var q = BM.solve(5200);
ok(q.oneSidedM / 1000 > 2500 && q.oneSidedM / 1000 < 3200,
   'D6 横跨中国东西 5200km，一端要爬到约 2935 km 高', q.oneSidedM.toFixed(0) + ' m');
ok(Math.abs(q.oneSidedM - (Math.sqrt(BM.R * BM.R + 5200 * 5200) - BM.R) * 1000) / q.oneSidedM > 0.3,
   'D7 若误用 sqrt(R²+d²)-R（把弧长当弦长）会低估 35% 以上',
   'exact=' + (q.oneSidedM / 1000).toFixed(0) + 'km wrong=' + (Math.sqrt(BM.R * BM.R + 5200 * 5200) - BM.R).toFixed(0) + 'km');
// D8：这个「巧合」随尺度退化，页面文案必须限定适用范围
ok(relErr(p.eachM, p.sagittaM) < 0.001,
   'D8a 100 km 时「各爬高度 = 鼓包高度」误差 < 0.1%',
   'rel=' + (relErr(p.eachM, p.sagittaM) * 100).toFixed(4) + '%');
ok(relErr(q.eachM, q.sagittaM) > 0.05,
   'D8b 5200 km 时该巧合退化到 8%，页面不能无尺度地照抄这句话',
   'each=' + (q.eachM / 1000).toFixed(0) + 'km sag=' + (q.sagittaM / 1000).toFixed(0) + 'km rel=' +
   (relErr(q.eachM, q.sagittaM) * 100).toFixed(2) + '%');

console.log('\n=== D2. 边界：距离超过视距上界时必须是 Infinity，不能是负数 ===');
near(BM.horizon(1e9), 9000, 10010, 'D9 h→∞ 时视距收敛到 πR/2 ≈ 10008 km');
ok(BM.heightForHorizon(12000) === Infinity, 'D10 12000 km 处单侧高度为 Infinity（非负数）',
   'raw=' + BM.heightForHorizon(12000));
ok(BM.heightForHorizon(Math.PI * BM.R) === Infinity, 'D11 对跖点单侧高度 Infinity');
ok(BM.solve(Math.PI * BM.R).oneSidedM > 0, 'D12 对跖点不会算出负高度（回归：这里曾返回 -1.27e7 m）',
   'raw=' + BM.solve(Math.PI * BM.R).oneSidedM);
ok(BM.solve(100).oneSidedM > 0 && BM.solve(5200).oneSidedM > 0, 'D13 常规距离下仍为正');

console.log('\n=== E. 可见面积 ===');
var v1 = BM.view(0.0017);
near(v1.areaKm2, 65, 71, 'E1 站在平地能看到的地表 ≈ 68 km²');
ok(v1.areaKm2 < 455, 'E2 这个面积小于北京朝阳区（455 km²）', v1.areaKm2.toFixed(1) + ' < 455');
near(v1.fraction * 100, 0.0000125, 0.0000145, 'E3 占地球表面 ≈ 0.0000133%');
var v2 = BM.view(8.84886);
near(v2.areaKm2, 340000, 370000, 'E4 珠峰顶可见 ≈ 35 万 km²');
near(v2.areaKm2 / 9.6e6 * 100, 3.2, 4.0, 'E5 相当于中国国土的 3.7%');
ok(Math.abs(BM.capArea(1.0) - BM.capAreaByDistance(BM.horizon(1.0))) / BM.capArea(1.0) < 1e-9,
   'E6 面积的两种算法（由 h 积分 / 由视距）一致');
ok(BM.view(100).fraction > BM.view(1).fraction, 'E7 面积随高度单调递增');

console.log('\n=== F. 人链 ===');
near(BM.ringPeople(0.0017), 4200, 4400, 'F1 绕赤道站一圈能对望需约 4300 人');
ok(BM.ringPeople(0.0017) * 2 * BM.horizon(0.0017) >= 2 * Math.PI * BM.R,
   'F2 人链总跨度不小于赤道周长（ceil 后确实够长）');

console.log('\n=== G. 大气折射 ===');
var Rref = BM.effR(true);
near(BM.horizon(0.0017, Rref), 4.9, 5.1, 'G1 计入折射后视距变大 ≈ 5.0 km');
ok(BM.horizon(0.0017, Rref) > BM.horizon(0.0017), 'G2 折射使视距变远',
   BM.horizon(0.0017, Rref).toFixed(3) + ' > ' + BM.horizon(0.0017).toFixed(3));
ok(Math.abs(BM.effR(true) - BM.R / 0.87) < 1e-9, 'G3 等效半径 = R/(1-k)，k=0.13');

console.log('\n=== H. 城市距离（页面预设对照） ===');
near(BM.haversine(39.9042, 116.4074, 31.2304, 121.4737), 1050, 1090, 'H1 北京-上海 ≈ 1067 km');
near(BM.haversine(39.9042, 116.4074, 39.0842, 117.2009), 95, 130, 'H2 北京-天津 ≈ 110 km');
near(BM.haversine(23.1291, 113.2644, 39.9042, 116.4074), 1880, 1920, 'H3 广州-北京 ≈ 1890 km');
near(BM.haversine(39.9042, 116.4074, -39.9042, 116.4074 - 180), 20000, 20030,
     'H4 对跖点距离 ≈ 20015 km（半个大圆，页面不会溢出）');
ok(BM.haversine(39.9042, 116.4074, 39.9042, 116.4074) === 0, 'H5 同点距离为 0');

console.log('\n=== I. 单调性与健壮性 ===');
var mono = true;
for (var d = 1; d < 6000; d += 37) {
  if (BM.sagitta(d + 37) <= BM.sagitta(d)) { mono = false; break; }
}
ok(mono, 'I1 鼓包随距离严格单调递增');
var monoH = true;
for (var h = 0.001; h < 100; h *= 1.5) {
  if (BM.horizon(h * 1.5) <= BM.horizon(h)) { monoH = false; break; }
}
ok(monoH, 'I2 视距随高度严格单调递增');
ok(isFinite(BM.solve(0).sagittaM) && BM.solve(0).sagittaM === 0, 'I3 d=0 不产生 NaN');
ok(isFinite(BM.view(0).areaKm2) && BM.view(0).areaKm2 === 0, 'I4 h=0 可见面积为 0');
ok(isFinite(BM.solve(20000).sagittaM), 'I5 极端距离 20000km 仍收敛（不越 NaN）');

console.log('\n========================================');
console.log('  PASS ' + pass + '   FAIL ' + fail);
console.log('========================================\n');
process.exit(fail ? 1 : 0);
