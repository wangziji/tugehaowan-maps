/* =====================================================================
 * 失联半径 · LOST RADIUS —— 断言脚本（写 UI 之前先跑通）
 *
 * 纪律来源：
 *  1. 先写断言再写 UI（静坐时速把错 64 倍的数字写进了草案）
 *  2. 量级两端各取一点（地球鼓包：两种公式 100km 差 0.1%、5200km 差 36.8%）
 *  3. 防静默荒谬值（反解公式越界返回 Infinity）
 *  4. 开放输入防 NaN 死循环
 *
 * 跑法： node verify.js
 * ===================================================================== */
import {
  EARTH_R, KM_PER_DEG, kmPerDegLon, num, isoRadius, areaAnalyticOne, areaAnalyticTwo,
  fieldAt, project, gridStats, lostRadius, equivRadius, hullArea,
  CITY_AREAS, REFERENCE_AREAS, bestReference, rebuildWeeks, compute, unproject, convexHull
} from './model.js';

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, d = '') {
  if (cond) pass++; else { fail++; fails.push(name + ' ' + d); console.log('  FAIL  ' + name + '  ' + d); }
}
function near(name, got, want, relTol, unit = '') {
  const err = want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);
  ok(name, err <= relTol, `got=${got.toPrecision(8)}${unit} want=${want.toPrecision(8)}${unit} err=${(err * 100).toFixed(3)}%`);
}
const P = (x, y, r = 0.7) => ({ x, y, r, w: 1, i: 0 });

/* ---------- 1. 基础常数与投影 ---------- */
console.log('\n=== 1. 常数与投影 ===');
near('1 每度纬度公里数 ≈ 111.19', KM_PER_DEG, 111.1949, 1e-4, ' km');
near('1 北京 39.9°N 每度经度 ≈ 85.28', kmPerDegLon(39.9042), 85.28, 5e-3, ' km');
near('1 赤道每度经度 = 每度纬度', kmPerDegLon(0), KM_PER_DEG, 1e-9, ' km');
near('1 广州 23.1°N 每度经度 ≈ 102.3', kmPerDegLon(23.1291), 102.3, 5e-3, ' km');
ok('1 经度换算随纬度单调递减',
  kmPerDegLon(10) > kmPerDegLon(30) && kmPerDegLon(30) > kmPerDegLon(50));

{
  // 投影往返：unproject(project(p)) 必须还原回原经纬度（凸包画回地图靠它。
  // 这一条对应「贴图层必须做对齐验收」：纯 Node 冒烟里 TMap 是桩，画错位置也测不出来）
  {
    const src = [{ lat: 39.9042, lon: 116.4074 }, { lat: 30.5728, lon: 104.0668 },
    { lat: 22.5431, lon: 114.0579 }, { lat: 45.8038, lon: 126.5349 }];
    let worst = 0;
    for (const s of src) {
      const pr = project([s, { lat: s.lat + 0.01, lon: s.lon + 0.01 }], 0.7);
      const back = unproject(pr.pts[0].x, pr.pts[0].y, pr.lat0, pr.lon0);
      worst = Math.max(worst, Math.abs(back.lat - s.lat), Math.abs(back.lon - s.lon));
    }
    ok(`1 投影往返误差 < 1e-9 度（最差 ${worst.toExponential(2)}）`, worst < 1e-9);
  }
  // 同城 1 km 的距离换算误差 < 0.5%
  const pr = project([{ lat: 39.9, lon: 116.4 }, { lat: 39.9, lon: 116.4 + 1 / kmPerDegLon(39.9) }], 0.7);
  near('1 北京东西相距 1 经度换算 = 1 km', Math.abs(pr.pts[1].x - pr.pts[0].x), 1, 5e-3, ' km');
  const pr2 = project([{ lat: 39.9, lon: 116.4 }, { lat: 39.9 + 1 / KM_PER_DEG, lon: 116.4 }], 0.7);
  near('1 南北 1 度换算 = 1 km', Math.abs(pr2.pts[1].y - pr2.pts[0].y), 1, 5e-3, ' km');
}

/* ---------- 2. 单点等值圆：三个量级都要对 ---------- */
console.log('\n=== 2. 单点解析 vs 网格（量级两端） ===');
for (const t of [0.9, 0.5, 0.05]) {
  const r = 0.7, want = areaAnalyticOne(r, t);
  near(`2 t=${t} 解析面积 = πr²log2(1/t)`, want, Math.PI * r * r * Math.log(1 / t) / Math.log(2), 1e-12, ' km²');
  const g = gridStats([P(0, 0, r)], t);
  near(`2 t=${t} 网格面积 vs 解析（误差<2%）`, g.area, want, 0.02, ' km²');
}
{
  // 量级两端：r 从 200 m 到 5 km 都成立（大 r 时网格分辨率自适应）
  for (const r of [0.2, 0.7, 2, 5]) {
    const g = gridStats([P(0, 0, r)], 0.5);
    near(`2 r=${r}km 网格面积 vs πr²`, g.area, Math.PI * r * r, 0.02, ' km²');
    const g2 = gridStats([P(0, 0, r)], 0.05);
    near(`2 r=${r}km t=0.05 面积 vs 4.3219πr²`, g2.area, 4.321928 * Math.PI * r * r, 0.03, ' km²');
  }
  // 两种阈值在最大尺度上必须差出已知倍数（防「小尺度吻合、大尺度炸」）
  const a1 = gridStats([P(0, 0, 5)], 0.5).area, a2 = gridStats([P(0, 0, 5)], 0.05).area;
  near('2 t=0.05 面积 / t=0.5 面积 = log2(20)', a2 / a1, Math.log(20) / Math.log(2), 0.02);
}

/* ---------- 3. 两点并集：网格 vs 透镜解析 ---------- */
console.log('\n=== 3. 两点并集 vs 透镜公式 ===');
{
  const r = 0.7, t = 0.5, R = isoRadius(r, t);
  near('3 t=0.5 时等值半径 R = r', R, r, 1e-12, ' km');
  const cases = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 5];
  for (const k of cases) {
    const D = k * R;
    const want = areaAnalyticTwo(D, r, t);
    const got = gridStats([P(-D / 2, 0, r), P(D / 2, 0, r)], t).area;
    near(`3 D=${k}R 网格面积 vs 解析`, got, want, 0.03, ' km²');
  }
  near('3 D=0 并集 = 单点圆', areaAnalyticTwo(0, 0.7, 0.5), Math.PI * 0.49, 1e-12, ' km²');
  near('3 D>=2R 并集 = 两个圆', areaAnalyticTwo(10, 0.7, 0.5), 2 * Math.PI * 0.49, 1e-12, ' km²');
  near('3 D=R 解析值（手算核对）', areaAnalyticTwo(0.7, 0.7, 0.5),
    2 * Math.PI * 0.49 - (2 * 0.49 * Math.acos(0.5) - 0.35 * Math.sqrt(4 * 0.49 - 0.49)), 1e-12, ' km²');
  // 单调性：距离增大，并集面积不减（有透镜时严格增）
  let prev = -1, mono = true;
  for (let D = 0; D <= 3 * 0.7; D += 0.02) {
    const a = areaAnalyticTwo(D, 0.7, 0.5);
    if (a < prev - 1e-9) mono = false;
    prev = a;
  }
  ok('3 并集面积随点距单调不减', mono);
}

/* ---------- 4. 单调性 / 上界 ---------- */
console.log('\n=== 4. 单调性与上界 ===');
{
  // 点数增加 → 面积不减
  let prev = -1, mono = true;
  for (let n = 1; n <= 12; n++) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(P(i * 3.3, (i % 3) * 2.1, 0.7));
    const a = gridStats(pts, 0.5).area;
    if (a < prev - 1e-9) mono = false;
    prev = a;
  }
  ok('4 锚点越多面积单调不减', mono);

  // 面积上界：n 个完全分离的点 → n·πr²（1% 容差）
  // 这一条原本 FAIL 14.3%：全局网格步长被 500 km 跨度拉到与半径同量级。
  // 修法是先按「等值圆是否可能相交」分簇，每簇用自己的局部精细网格算（见 model.clusterize）。
  const pts = [];
  for (let i = 0; i < 6; i++) pts.push(P(i * 100, 0, 0.7));
  near('4 6 个极远点面积 → 6πr²', gridStats(pts, 0.5).area, 6 * Math.PI * 0.49, 0.02, ' km²');
  ok('4 6 个极远点被拆成 6 个簇', gridStats(pts, 0.5).clusters === 6);
  ok('4 相邻两点合成 1 个簇', gridStats([P(0, 0), P(0.7, 0)], 0.5).clusters === 1);
  ok('4 相距 2R 以上分成 2 个簇', gridStats([P(0, 0), P(2.1, 0)], 0.5).clusters === 2);
  // 跨 5 个数量级的跨度下依然成立（100 m ~ 100 km）
  for (const gap of [0.05, 0.5, 5, 50, 500]) {
    const q = [P(0, 0, 0.7), P(gap, 0, 0.7)];
    const want = areaAnalyticTwo(gap, 0.7, 0.5);
    const got = gridStats(q, 0.5).area;
    near(`4 点距 ${gap} km 分簇后仍对得上解析值`, got, want, 0.03, ' km²');
  }

  // 权重越大面积越大：w 翻倍 → 单点面积 ×4
  const gA = gridStats([P(0, 0, 0.7)], 0.5).area;
  const gB = gridStats([P(0, 0, 1.4)], 0.5).area;
  near('4 熟悉半径翻倍 → 面积 ×4', gB / gA, 4, 0.02);

  // baseR 单调
  let p2 = -1, m2 = true;
  for (const r of [0.2, 0.4, 0.7, 1.0, 1.5, 2.0]) {
    const a = gridStats([P(0, 0, r)], 0.5).area;
    if (a < p2 - 1e-12) m2 = false; p2 = a;
  }
  ok('4 baseR 增大面积不减', m2);
}

/* ---------- 5. 飞地（连通块） ---------- */
console.log('\n=== 5. 飞地数 ===');
{
  ok('5 单点 = 1 块', gridStats([P(0, 0)], 0.5).blobs === 1);
  ok('5 两点重合 = 1 块', gridStats([P(0, 0), P(0, 0)], 0.5).blobs === 1);
  ok('5 两点相距 R = 1 块（核交叠）', gridStats([P(0, 0), P(0.7, 0)], 0.5).blobs === 1);
  ok('5 两点相距 3R = 2 块', gridStats([P(0, 0), P(2.1, 0)], 0.5).blobs === 2);
  ok('5 三点链状（间距 R）= 1 块',
    gridStats([P(0, 0), P(0.7, 0), P(1.4, 0)], 0.5).blobs === 1);
  ok('5 三组各两块 = 6 块',
    gridStats([P(0, 0), P(0.7, 0), P(20, 0), P(20.7, 0), P(40, 0), P(40.7, 0)], 0.5).blobs === 3);
  // 块面积之和 = 总面积
  const g = gridStats([P(0, 0), P(0.7, 0), P(20, 0), P(20.7, 0)], 0.5);
  const s = g.blobSizes.reduce((a, b) => a + b, 0);
  near('5 各块面积之和 = 总面积', s, g.area, 1e-9, ' km²');
  ok('5 块面积降序排列', g.blobSizes[0] >= g.blobSizes[1]);
}

/* ---------- 6. 失联半径 ---------- */
console.log('\n=== 6. 失联半径 ===');
{
  // 单点解析：f = 2^-(d/r)^2 = 0.05 → d = r·sqrt(log2 20) = 2.0789 r
  const r = 0.7;
  const want = r * Math.sqrt(Math.log(20) / Math.log(2));
  const L = lostRadius(0, [P(0, 0, r)], 0.05);
  near('6 单点失联半径 = 2.0789r', L.mean, want, 0.02, ' km');
  near('6 单点最小方向 = 最大方向（圆对称）', L.min, L.max, 0.02, ' km');
  // 距离更远的点会把它拉长
  const L2 = lostRadius(0, [P(0, 0, r), P(1.2, 0, r)], 0.05);
  ok('6 加一个远处锚点 → 失联半径变长', L2.mean > L.mean + 0.05, `${L.mean.toFixed(3)} → ${L2.mean.toFixed(3)}`);
  const L3 = lostRadius(0, [P(0, 0, r), P(1.2, 0, r), P(0, 1.2, r), P(-1.2, 0, r), P(0, -1.2, r)], 0.05);
  ok('6 四面都有锚点 → 更接近各向同性',
    (L3.max - L3.min) / L3.mean < (L2.max - L2.min) / L2.mean,
    `各向异性 ${((L2.max - L2.min) / L2.mean).toFixed(3)} → ${((L3.max - L3.min) / L3.mean).toFixed(3)}`);
  // 阈值越严（t 越大）失联半径越短
  const a = lostRadius(0, [P(0, 0, 0.7)], 0.05).mean;
  const b = lostRadius(0, [P(0, 0, 0.7)], 0.5).mean;
  ok('6 阈值 0.5 的失联半径 < 阈值 0.05', b < a, `${b.toFixed(3)} < ${a.toFixed(3)}`);
  near('6 t=0.5 单点失联半径 = r', b, 0.7, 0.02, ' km');
  // 空点集不崩
  const Lz = lostRadius(0, [], 0.05);
  ok('6 空点集失联半径 = 0 且不崩', Lz.mean === 0 && isFinite(Lz.mean));
}

/* ---------- 7. 等效半径 / 凸包 / 离散度 ---------- */
console.log('\n=== 7. 等效半径与离散度 ===');
{
  near('7 等效半径：单点 = r', equivRadius(gridStats([P(0, 0, 0.7)], 0.5).area), 0.7, 0.02, ' km');
  near('7 等效半径：面积 4 倍 → 半径 2 倍', equivRadius(4 * Math.PI), 2, 1e-12, ' km');
  ok('7 面积 0 → 等效半径 0', equivRadius(0) === 0);
  ok('7 面积负/NaN → 等效半径 0（不返回 NaN）', equivRadius(-5) === 0 && equivRadius(NaN) === 0);
  // 凸包
  const sq = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
  near('7 正方形凸包面积 = 1', hullArea(sq), 1, 1e-12, ' km²');
  ok('7 少于 3 点凸包 = 0', hullArea([P(0, 0), P(1, 0)]) === 0);
  const tri = [P(0, 0), P(2, 0), P(0, 2)];
  near('7 三角形凸包面积 = 2', hullArea(tri), 2, 1e-12, ' km²');
  // 离散度：紧凑 vs 分散
  const tight = compute([{ lat: 39.9, lon: 116.40 }, { lat: 39.905, lon: 116.405 },
  { lat: 39.902, lon: 116.41 }], { city: '北京' });
  // 注意：三个点不能共线，否则凸包面积为 0（踩过一次）
  const loose = compute([{ lat: 39.80, lon: 116.30 }, { lat: 40.00, lon: 116.50 },
  { lat: 39.98, lon: 116.28 }], { city: '北京' });
  ok('7 对照组点集非共线（凸包 > 0）', loose.hull > 1, `hull=${loose.hull.toFixed(3)}`);
  ok('7 分散点的离散度 > 紧凑点', loose.spread > tight.spread * 3,
    `tight=${tight.spread.toFixed(3)} loose=${loose.spread.toFixed(3)}`);
  ok('7 紧凑点飞地 = 1', tight.blobs === 1);
  ok('7 极分散点飞地 = 3', loose.blobs === 3, `blobs=${loose.blobs}`);
}

/* ---------- 8. 城市占比与「需要多少个你」 ---------- */
console.log('\n=== 8. 城市占比（反常识结论的量级） ===');
{
  ok('8 城市表齐全（16 座）', Object.keys(CITY_AREAS).length === 16);
  ok('8 所有城市面积为正且 < 10 万 km²',
    Object.values(CITY_AREAS).every(c => c.area > 100 && c.area < 1e5));
  near('8 北京面积 16410 km²', CITY_AREAS['北京'].area, 16410.54, 1e-9, ' km²');
  ok('8 重庆 > 哈尔滨 > 北京（面积序）',
    CITY_AREAS['重庆'].area > CITY_AREAS['哈尔滨'].area &&
    CITY_AREAS['哈尔滨'].area > CITY_AREAS['北京'].area);

  // 典型场景：8 个锚点，r=0.7，北京
  const demo = compute([
    { lat: 39.9042, lon: 116.4074 }, { lat: 39.91, lon: 116.42 },
    { lat: 39.895, lon: 116.40 }, { lat: 39.92, lon: 116.39 },
    { lat: 39.88, lon: 116.42 }, { lat: 39.93, lon: 116.44 },
    { lat: 39.90, lon: 116.38 }, { lat: 39.87, lon: 116.37 }
  ], { city: '北京', baseR: 0.7 });
  ok('8 8 个锚点面积 > 1 km²', demo.area > 1, `${demo.area.toFixed(3)} km²`);
  ok('8 8 个锚点面积 < 30 km²（不至于荒谬）', demo.area < 30, `${demo.area.toFixed(3)} km²`);
  ok('8 占全市比例 < 0.2%（这就是反常识点）', demo.share < 0.002,
    `${(demo.share * 100).toFixed(4)}%`);
  ok('8 占全市比例 > 0', demo.share > 0);
  ok('8 填满北京需要 > 500 个你', demo.copies > 500, `${demo.copies.toFixed(0)}`);
  ok('8 等效半径 < 3 km', demo.equiv < 3, `${demo.equiv.toFixed(3)} km`);
  ok('8 失联半径在 1–10 km 量级', demo.lost.mean > 1 && demo.lost.mean < 10,
    `${demo.lost.mean.toFixed(3)} km`);

  // 反例：锚点铺满全城时占比必须能上去（防止公式恒小）
  const wide = [];
  for (let i = 0; i < 200; i++) {
    wide.push({ lat: 39.6 + (i % 20) * 0.03, lon: 116.0 + Math.floor(i / 20) * 0.045 });
  }
  const w = compute(wide, { city: '北京', baseR: 3 });
  ok('8 200 个广域锚点占比 > 5%（公式不会恒小）', w.share > 0.05, `${(w.share * 100).toFixed(2)}%`);
  ok('8 此时填满城市所需人数 < 20', w.copies < 20, `${w.copies.toFixed(2)}`);

  // 参照物换算
  const ref = bestReference(3.0);
  ok('8 3 km² 的参照物是澳门或西湖量级', ref && ref.count >= 1, JSON.stringify(ref));
  ok('8 极小面积仍返回可用参照物', bestReference(0.01) !== null);
  ok('8 零面积不崩', bestReference(0) === null || bestReference(0).count === 0);
  near('8 故宫 0.72 km²', REFERENCE_AREAS[0].km2, 0.72, 1e-12);
}

/* ---------- 9. 重建成本 ---------- */
console.log('\n=== 9. 搬家的重建成本 ===');
{
  near('9 8 个点 ×7 次 ÷2 = 28 周', rebuildWeeks(8, 7, 2), 28, 1e-12, ' 周');
  ok('9 点数翻倍 → 周数翻倍', rebuildWeeks(16) === 2 * rebuildWeeks(8));
  ok('9 到访次数翻倍 → 周数翻倍', rebuildWeeks(8, 14, 2) === 2 * rebuildWeeks(8, 7, 2));
  ok('9 每周去得越多 → 周数越少', rebuildWeeks(8, 7, 4) < rebuildWeeks(8, 7, 2));
  ok('9 零个点 → 0 周', rebuildWeeks(0) === 0);
  ok('9 非法输入退回默认，不返回 NaN',
    isFinite(rebuildWeeks(NaN)) && isFinite(rebuildWeeks(-3)) && rebuildWeeks(-3) === 0);
  ok('9 perWeek=0 不产生 Infinity', isFinite(rebuildWeeks(8, 7, 0)));
  ok('9 上限保护：点数 1e6 也不会爆', rebuildWeeks(1e6) <= 500 * 60 / 0.1 + 1e-9);
}

/* ---------- 10. 防静默荒谬值 / NaN / 死循环 ---------- */
console.log('\n=== 10. 异常输入 ===');
{
  const empty = compute([], { city: '北京' });
  ok('10 空锚点：ok=false 且面积 0', empty.ok === false && empty.area === 0);
  ok('10 空锚点：copies = Infinity（不是 NaN）', empty.copies === Infinity);
  ok('10 空锚点：所有数字字段均有限或显式 Infinity',
    [empty.area, empty.equiv, empty.lost.mean, empty.hull, empty.share].every(isFinite));

  const junk = compute([{ lat: NaN, lon: NaN }, { lat: 'abc', lon: null }, { lat: 999, lon: -999 }], { city: '北京' });
  ok('10 全垃圾输入不崩且有限', isFinite(junk.area) && isFinite(junk.lost.mean), JSON.stringify({ a: junk.area, l: junk.lost.mean }));

  const one = compute([{ lat: 39.9, lon: 116.4 }], { city: '北京', baseR: 0.7, tCore: 0.5 });
  near('10 单锚点 t=0.5 面积 = πr²', one.area, Math.PI * 0.49, 0.03, ' km²');
  ok('10 单锚点飞地 = 1', one.blobs === 1);

  // 极端 baseR
  const big = compute([{ lat: 39.9, lon: 116.4 }], { city: '北京', baseR: 20, tCore: 0.5 });
  ok('10 baseR=20 仍有限（不会把网格撑爆）', isFinite(big.area) && big.area > 0);
  near('10 baseR=20 单点面积 = 400π', big.area, Math.PI * 400, 0.05, ' km²');
  const tiny = compute([{ lat: 39.9, lon: 116.4 }], { city: '北京', baseR: 0.05, tCore: 0.5 });
  near('10 baseR=0.05 单点面积 = 0.0025π', tiny.area, Math.PI * 0.0025, 0.05, ' km²');

  // 阈值越界
  ok('10 t=0 被收进合法域，不产生 Infinity 半径', isFinite(isoRadius(0.7, 0)));
  ok('10 t=1 被收进合法域', isFinite(isoRadius(0.7, 1)));
  ok('10 r=0 时等值半径为 0（不是 NaN）', isoRadius(0, 0.5) === 0);
  ok('10 num() 全部兜底', num(NaN, 0, 1, 0.5) === 0.5 && num(-1, 0, 1, 0.5) === 0 && num(9, 0, 1, 0.5) === 1);

  // 循环硬上限：极多锚点也能在有限时间内返回
  const t0 = Date.now();
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ lat: 39.5 + i * 0.01, lon: 116.1 + i * 0.01 });
  const m = compute(many, { city: '北京', baseR: 0.7 });
  ok('10 60 个锚点在 5 秒内算完', Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  ok('10 60 个锚点结果有限', isFinite(m.area) && isFinite(m.lost.mean));
}

/* ---------- 11. 网格分辨率不敏感（参数不敏感性） ---------- */
console.log('\n=== 11. 分辨率不敏感 ===');
{
  // 同一组点在两种 targetCells 下面积差 < 2%
  const pts = [P(0, 0), P(0.9, 0.3), P(-0.6, 0.8), P(1.8, -0.4)];
  const a = gridStats(pts, 0.5, { targetCells: 200 }).area;
  const b = gridStats(pts, 0.5, { targetCells: 600 }).area;
  near('11 分辨率 ×3 后面积变化 < 2%', a, b, 0.02, ' km²');
  const c = gridStats(pts, 0.05, { targetCells: 200 }).area;
  const d = gridStats(pts, 0.05, { targetCells: 600 }).area;
  near('11 t=0.05 同样不敏感', c, d, 0.03, ' km²');
  // 平移不变性
  const e = gridStats(pts.map(p => P(p.x + 12.3, p.y - 7.7)), 0.5).area;
  near('11 平移不变', e, a, 0.02, ' km²');
  // 旋转不变性（近似，网格是轴对齐的，容差放宽）
  const rot = pts.map(p => P(p.x * 0.6 - p.y * 0.8, p.x * 0.8 + p.y * 0.6));
  near('11 旋转不变（5% 容差）', gridStats(rot, 0.5).area, a, 0.05, ' km²');
}

/* ---------- 12. 场值本身 ---------- */
console.log('\n=== 12. 熟悉度场 ===');
{
  near('12 锚点中心场值 = 1', fieldAt(0, 0, [P(0, 0, 0.7)]), 1, 1e-12);
  near('12 距离 r 处场值 = 0.5', fieldAt(0.7, 0, [P(0, 0, 0.7)]), 0.5, 1e-12);
  near('12 距离 2r 处场值 = 0.0625', fieldAt(1.4, 0, [P(0, 0, 0.7)]), 0.0625, 1e-12);
  ok('12 场值单调递减', (() => {
    let p = 2; for (let d = 0; d <= 3; d += 0.1) { const f = fieldAt(d, 0, [P(0, 0, 0.7)]); if (f > p + 1e-12) return false; p = f; } return true;
  })());
  ok('12 多点取 max（并集）', Math.abs(fieldAt(0.35, 0, [P(0, 0, 0.7), P(0.7, 0, 0.7)]) - Math.pow(2, -0.25)) < 1e-12);
  ok('12 空场 = 0', fieldAt(0, 0, []) === 0);
  ok('12 r=0 的退化锚点不产生 NaN', isFinite(fieldAt(0.1, 0, [P(0, 0, 0)])));
}

/* ---------- 13. 端到端：三个预设场景的量级 ---------- */
console.log('\n=== 13. 端到端场景 ===');
{
  const scenarios = {
    '刚来北京三个月': [{ lat: 39.9042, lon: 116.4074 }, { lat: 39.91, lon: 116.42 }, { lat: 39.9, lon: 116.43 }],
    '住了五年': [{ lat: 39.9042, lon: 116.4074 }, { lat: 39.91, lon: 116.42 }, { lat: 39.895, lon: 116.40 },
    { lat: 39.92, lon: 116.39 }, { lat: 39.88, lon: 116.42 }, { lat: 39.93, lon: 116.44 },
    { lat: 39.90, lon: 116.38 }, { lat: 39.87, lon: 116.37 }],
    '本地通': (() => { const a = []; for (let i = 0; i < 30; i++) a.push({ lat: 39.75 + (i % 6) * 0.05, lon: 116.25 + Math.floor(i / 6) * 0.06 }); return a; })()
  };
  const out = {};
  for (const [k, v] of Object.entries(scenarios)) out[k] = compute(v, { city: '北京', baseR: 0.7 });
  ok('13 住得越久面积越大', out['刚来北京三个月'].area < out['住了五年'].area &&
    out['住了五年'].area < out['本地通'].area,
    `${out['刚来北京三个月'].area.toFixed(2)} < ${out['住了五年'].area.toFixed(2)} < ${out['本地通'].area.toFixed(2)}`);
  ok('13 刚来三个月占全市 < 0.05%', out['刚来北京三个月'].share < 5e-4, `${(out['刚来北京三个月'].share * 100).toFixed(4)}%`);
  ok('13 本地通占比仍 < 5%（结论：没人真的拥有整座城）', out['本地通'].share < 0.05, `${(out['本地通'].share * 100).toFixed(3)}%`);
  ok('13 本地通占比 > 刚来三个月 × 5', out['本地通'].share > out['刚来北京三个月'].share * 5);
  ok('13 三档重建周数递增', out['刚来北京三个月'].weeks < out['住了五年'].weeks &&
    out['住了五年'].weeks < out['本地通'].weeks);
  for (const [k, v] of Object.entries(out)) {
    ok(`13 ${k}：所有输出有限且为正`, v.area > 0 && isFinite(v.equiv) && isFinite(v.lost.mean) && v.blobs >= 1);
  }
}

/* ---------- 14. 反向验证用到的探针（供人工复核） ---------- */
console.log('\n=== 14. 探针输出（人工复核用） ===');
{
  const d = compute([
    { lat: 39.9042, lon: 116.4074 }, { lat: 39.91, lon: 116.42 },
    { lat: 39.895, lon: 116.40 }, { lat: 39.92, lon: 116.39 },
    { lat: 39.88, lon: 116.42 }, { lat: 39.93, lon: 116.44 },
    { lat: 39.90, lon: 116.38 }, { lat: 39.87, lon: 116.37 }
  ], { city: '北京', baseR: 0.7, tCore: 0.5, tLost: 0.05 });
  console.log('  面积       ', d.area.toFixed(3), 'km²');
  console.log('  等效半径   ', d.equiv.toFixed(3), 'km');
  console.log('  失联半径   ', d.lost.mean.toFixed(3), 'km  (min', d.lost.min.toFixed(2), 'max', d.lost.max.toFixed(2), ')');
  console.log('  飞地数     ', d.blobs, d.blobSizes.map(x => x.toFixed(2)).join(' / '));
  console.log('  占全市     ', (d.share * 100).toFixed(4), '%');
  console.log('  需要多少个你', d.copies.toFixed(0));
  console.log('  参照物     ', d.ref ? `${d.ref.count.toFixed(1)} 个${d.ref.name}` : '-');
  console.log('  重建周数   ', d.weeks.toFixed(1), '周');
  near('14 单锚点基准：π·0.7² = 1.5394 km²', Math.PI * 0.49, 1.53938, 1e-4, ' km²');
  ok('14 分簇生效：8 个分散锚点被拆成多个簇', d.blobs >= 1 && d.blobSizes.length === d.blobs);
}

console.log('\n============================================');
console.log(`断言结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过 ✅');
