/* =====================================================================
 * 失联半径 · LOST RADIUS —— 计算核心（纯函数，浏览器与 Node 共用）
 *
 * 熟悉度核（半高核，可解析验证）：
 *     f_i(d) = 2 ^ (-(d / r_i)^2)      —— 在 d = r_i 处恰好衰减到 0.5
 *     F(p)   = max_i f_i(|p - p_i|)     —— 取并集，谁近听谁的
 *
 * 阈值 t 的等值区域，对单点是一个圆，半径 R = r * sqrt(log2(1/t))，
 * 面积 = π r² log2(1/t)。这条解析式是所有断言的锚。
 * ===================================================================== */

export const EARTH_R = 6371.0088;                       // km, IUGG 平均半径
export const KM_PER_DEG = Math.PI * EARTH_R / 180;      // 111.1949 km / 度

export function kmPerDegLon(lat) {
  return KM_PER_DEG * Math.cos(lat * Math.PI / 180);
}

/** 数值收进合法域：非法一律退回 fallback，绝不把 NaN 放进循环 */
export function num(v, lo, hi, fallback) {
  const x = Number(v);
  if (!isFinite(x)) return fallback;
  return Math.min(hi, Math.max(lo, x));
}

export const LOG2 = Math.log(2);

/** 单点在阈值 t 下的等值圆半径（km）。t 必须在 (0,1) */
export function isoRadius(r, t) {
  r = num(r, 0, 1e4, 0); t = num(t, 1e-6, 0.999999, 0.5);
  return r * Math.sqrt(Math.log(1 / t) / LOG2);
}

/** 单点等值圆面积的解析值（km²） */
export function areaAnalyticOne(r, t) {
  const R = isoRadius(r, t);
  return Math.PI * R * R;
}

/**
 * 两个等半径点的并集面积解析值：2πR² 减去透镜交叠
 * @param {number} D 两点距离 km
 */
export function areaAnalyticTwo(D, r, t) {
  const R = isoRadius(r, t);
  if (R <= 0) return 0;
  if (D >= 2 * R) return 2 * Math.PI * R * R;
  if (D <= 0) return Math.PI * R * R;
  const lens = 2 * R * R * Math.acos(D / (2 * R))
    - (D / 2) * Math.sqrt(Math.max(0, 4 * R * R - D * D));
  return 2 * Math.PI * R * R - lens;
}

/** 熟悉度场值 */
export function fieldAt(x, y, pts) {
  let best = 0;
  for (let i = 0; i < pts.length; i++) {
    const dx = x - pts[i].x, dy = y - pts[i].y;
    const r = pts[i].r;
    if (r <= 0) { if (dx === 0 && dy === 0) best = 1; continue; }
    const q = (dx * dx + dy * dy) / (r * r);
    const f = Math.pow(2, -q);
    if (f > best) best = f;
  }
  return best;
}

/**
 * 把经纬度点集投影到以质心为原点的局部切平面（km）
 * @param {Array<{lat:number,lon:number,r?:number,w?:number}>} anchors
 * @param {number} baseR 基准熟悉半径 km
 */
export function project(anchors, baseR) {
  const list = (Array.isArray(anchors) ? anchors : [])
    .map(a => ({ lat: num(a.lat, -90, 90, 0), lon: num(a.lon, -180, 180, 0), w: num(a.w, 0.1, 5, 1) }))
    .filter(a => isFinite(a.lat) && isFinite(a.lon));
  if (!list.length) return { pts: [], lat0: 0, lon0: 0, span: 0 };
  let la = 0, lo = 0;
  for (const p of list) { la += p.lat; lo += p.lon; }
  const lat0 = la / list.length, lon0 = lo / list.length;
  const kx = kmPerDegLon(lat0), ky = KM_PER_DEG;
  const pts = list.map((a, i) => ({
    i, lat: a.lat, lon: a.lon, w: a.w,
    x: (a.lon - lon0) * kx,
    y: (a.lat - lat0) * ky,
    r: num(baseR, 0.01, 50, 0.7) * a.w
  }));
  let span = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      span = Math.max(span, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  return { pts, lat0, lon0, span };
}

/**
 * 把点集按「等值圆是否可能相交」分组（并查集）。
 * 组与组之间必然不相交，可以各自用局部精细网格算面积再相加 ——
 * 这是断言 4 抓出来的坑：6 个相距 100 km 的点放在一张全局网格上，
 * 网格步长被跨度拉到跟半径同量级，面积被高估 14.3%。
 */
export function clusterize(pts, t) {
  const n = pts.length, R = pts.map(p => isoRadius(p.r, t));
  const par = pts.map((_, i) => i);
  const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) <= R[i] + R[j]) uni(i, j);
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(pts[i]);
  }
  return [...groups.values()];
}

/** 单簇的网格积分 */
function gridStatsCluster(pts, t, targetCells) {
  let maxR = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    maxR = Math.max(maxR, p.r);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const R = isoRadius(maxR, t);
  if (!(R > 0)) return { area: 0, sizes: [], dx: 0 };

  const pad = R * 1.06;
  const x0 = minX - pad, x1 = maxX + pad, y0 = minY - pad, y1 = maxY + pad;
  const spanX = x1 - x0, spanY = y1 - y0;
  // 分辨率：既要覆盖本簇跨度，也要保证半径方向至少 14 个格子
  let dx = Math.min(Math.max(spanX, spanY) / targetCells, R / 14);
  dx = Math.max(dx, 1e-4);
  let cols = Math.ceil(spanX / dx), rows = Math.ceil(spanY / dx);
  // 硬上限，防止爆内存（此时精度降级但不崩）
  const MAXC = 1200;
  while (cols > MAXC || rows > MAXC) {
    dx *= 1.25;
    cols = Math.ceil(spanX / dx); rows = Math.ceil(spanY / dx);
  }

  const mask = new Uint8Array(cols * rows);
  let count = 0;
  for (let j = 0; j < rows; j++) {
    const y = y0 + (j + 0.5) * dx;
    for (let i = 0; i < cols; i++) {
      const x = x0 + (i + 0.5) * dx;
      if (fieldAt(x, y, pts) >= t) { mask[j * cols + i] = 1; count++; }
    }
  }
  const area = count * dx * dx;

  // 4-邻接 flood fill 求连通块
  const seen = new Uint8Array(cols * rows);
  const sizes = [];
  const stack = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    let n = 0; stack.length = 0; stack.push(s); seen[s] = 1;
    while (stack.length) {
      const c = stack.pop(); n++;
      const ci = c % cols, cj = (c - ci) / cols;
      if (ci > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
      if (ci < cols - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      if (cj > 0 && mask[c - cols] && !seen[c - cols]) { seen[c - cols] = 1; stack.push(c - cols); }
      if (cj < rows - 1 && mask[c + cols] && !seen[c + cols]) { seen[c + cols] = 1; stack.push(c + cols); }
    }
    sizes.push(n * dx * dx);
  }
  return { area, sizes, dx };
}

/**
 * 求阈值 t 的等值区域面积与连通块（飞地）
 * @returns {{area:number, blobs:number, blobSizes:number[], dx:number, clusters:number}}
 */
export function gridStats(pts, t, opts = {}) {
  t = num(t, 1e-6, 0.999999, 0.5);
  const targetCells = opts.targetCells || 340;
  if (!pts || !pts.length) return { area: 0, blobs: 0, blobSizes: [], dx: 0, clusters: 0 };
  const groups = clusterize(pts, t);
  let area = 0, dx = 0;
  const sizes = [];
  for (const g of groups) {
    const r = gridStatsCluster(g, t, targetCells);
    area += r.area;
    dx = Math.max(dx, r.dx);
    for (const s of r.sizes) sizes.push(s);
  }
  sizes.sort((a, b) => b - a);
  return { area, blobs: sizes.length, blobSizes: sizes, dx, clusters: groups.length };
}

/**
 * 失联半径：从 home 出发向外射线，找熟悉度降到 t 的第一个距离
 * @returns {{mean:number, median:number, min:number, max:number}}
 */
export function lostRadius(homeIdx, pts, t, opts = {}) {
  t = num(t, 1e-6, 0.999999, 0.05);
  const dirs = opts.dirs || 36;
  if (!pts || !pts.length) return { mean: 0, median: 0, min: 0, max: 0 };
  const h = pts[num(homeIdx, 0, Math.max(0, pts.length - 1), 0)] || pts[0];
  let maxR = 0; for (const p of pts) maxR = Math.max(maxR, p.r);
  const hard = isoRadius(maxR, t) + 1e-9;
  let span = 0;
  for (const p of pts) span = Math.max(span, Math.hypot(p.x - h.x, p.y - h.y));
  const limit = span + hard * 1.2;
  const step = Math.max(hard / 400, 1e-3);
  const out = [];
  for (let k = 0; k < dirs; k++) {
    const a = (k / dirs) * Math.PI * 2;
    const ux = Math.cos(a), uy = Math.sin(a);
    let d = 0, found = limit;
    // 先粗扫再二分
    let prev = fieldAt(h.x, h.y, pts);
    for (d = step; d <= limit; d += step) {
      const f = fieldAt(h.x + ux * d, h.y + uy * d, pts);
      if (f < t) {
        let lo = d - step, hi = d;
        for (let it = 0; it < 40 && hi - lo > 1e-6; it++) {
          const mid = (lo + hi) / 2;
          if (fieldAt(h.x + ux * mid, h.y + uy * mid, pts) < t) hi = mid; else lo = mid;
        }
        found = (lo + hi) / 2; break;
      }
      prev = f;
    }
    out.push(found);
  }
  out.sort((a, b) => a - b);
  const mean = out.reduce((s, v) => s + v, 0) / out.length;
  return {
    mean,
    median: out[Math.floor(out.length / 2)],
    min: out[0], max: out[out.length - 1]
  };
}

/** 等效圆半径：把不规则领地换成同面积的圆 */
export function equivRadius(area) {
  if (!(area > 0)) return 0;
  return Math.sqrt(area / Math.PI);
}

/** 凸包顶点（Andrew monotone chain），返回按逆时针排列的点数组 */
export function convexHull(pts) {
  const p = (pts || []).slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p.slice();
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** 凸包面积（鞋带公式，km²）—— 用于算「领地的离散度」 */
export function hullArea(pts) {
  const hull = convexHull(pts);
  if (hull.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 把局部切平面坐标还原成经纬度（渲染凸包用） */
export function unproject(x, y, lat0, lon0) {
  const kx = kmPerDegLon(lat0);
  return { lat: lat0 + y / KM_PER_DEG, lon: lon0 + x / kx };
}

/* ---------------- 城市面积（行政区划面积，km²）---------------- */
export const CITY_AREAS = {
  '北京': { area: 16410.54, lat: 39.9042, lon: 116.4074, zoom: 11 },
  '上海': { area: 6340.5, lat: 31.2304, lon: 121.4737, zoom: 11 },
  '广州': { area: 7434.4, lat: 23.1291, lon: 113.2644, zoom: 11 },
  '深圳': { area: 1997.47, lat: 22.5431, lon: 114.0579, zoom: 11 },
  '成都': { area: 14335, lat: 30.5728, lon: 104.0668, zoom: 11 },
  '杭州': { area: 16850, lat: 30.2741, lon: 120.1551, zoom: 11 },
  '武汉': { area: 8569.15, lat: 30.5928, lon: 114.3055, zoom: 11 },
  '西安': { area: 10752, lat: 34.3416, lon: 108.9398, zoom: 11 },
  '重庆': { area: 82402, lat: 29.5630, lon: 106.5516, zoom: 11 },
  '南京': { area: 6587.04, lat: 32.0603, lon: 118.7969, zoom: 11 },
  '天津': { area: 11966.45, lat: 39.3434, lon: 117.3616, zoom: 11 },
  '苏州': { area: 8657.32, lat: 31.2989, lon: 120.5853, zoom: 11 },
  '长沙': { area: 11816, lat: 28.2282, lon: 112.9388, zoom: 11 },
  '郑州': { area: 7567, lat: 34.7466, lon: 113.6254, zoom: 11 },
  '沈阳': { area: 12860, lat: 41.8057, lon: 123.4315, zoom: 11 },
  '哈尔滨': { area: 53076.4, lat: 45.8038, lon: 126.5349, zoom: 10 }
};

/** 参照物：把面积换成能想象的东西 */
export const REFERENCE_AREAS = [
  { name: '故宫', km2: 0.72 },
  { name: '天安门广场', km2: 0.44 },
  { name: '西湖（水域）', km2: 6.39 },
  { name: '澳门', km2: 33.3 },
  { name: '梵蒂冈', km2: 0.49 }
];

export function bestReference(area) {
  if (!(area > 0)) return null;
  let best = null, bestN = 0;
  for (const r of REFERENCE_AREAS) {
    const n = area / r.km2;
    if (n >= 1 && (best === null || n < bestN)) { best = r; bestN = n; }
  }
  return best ? { ...best, count: bestN } : { ...REFERENCE_AREAS[0], count: area / REFERENCE_AREAS[0].km2 };
}

/**
 * 重建成本：搬到一个全新城市，熟悉度归零，恢复到现在的锚点数需要多久
 * @param {number} n        现在有几个锚点
 * @param {number} visits   熟悉一个新地方需要到访几次（默认 7）
 * @param {number} perWeek  每周能去几个新地方（默认 2）
 */
export function rebuildWeeks(n, visits = 7, perWeek = 2) {
  n = num(n, 0, 500, 0); visits = num(visits, 1, 60, 7); perWeek = num(perWeek, 0.1, 30, 2);
  return n * visits / perWeek;
}

/**
 * 一次性算完所有输出
 * @param {Array} anchors [{lat,lon,w}]
 * @param {object} cfg {baseR, tCore, tLost, city, homeIdx, visits, perWeek}
 */
export function compute(anchors, cfg = {}) {
  const baseR = num(cfg.baseR, 0.05, 20, 0.7);
  const tCore = num(cfg.tCore, 1e-6, 0.999999, 0.5);
  const tLost = num(cfg.tLost, 1e-6, 0.999999, 0.05);
  const city = CITY_AREAS[cfg.city] ? cfg.city : '北京';

  const { pts, lat0, lon0, span } = project(anchors, baseR);
  if (!pts.length) {
    return {
      ok: false, n: 0, area: 0, equiv: 0, blobs: 0, blobSizes: [],
      lost: { mean: 0, median: 0, min: 0, max: 0 }, hull: 0, spread: 0,
      share: 0, copies: Infinity, ref: null, weeks: 0, city, cityArea: CITY_AREAS[city].area,
      center: { lat: lat0, lon: lon0 }, span: 0
    };
  }
  const gs = gridStats(pts, tCore);
  const area = gs.area;
  const lost = lostRadius(cfg.homeIdx, pts, tLost);
  const hull = hullArea(pts);
  const cityArea = CITY_AREAS[city].area;
  return {
    ok: true,
    n: pts.length,
    area,
    equiv: equivRadius(area),
    blobs: gs.blobs,
    blobSizes: gs.blobSizes,
    lost,
    hull,
    spread: area > 0 ? hull / area : 0,
    share: area / cityArea,
    copies: area > 0 ? cityArea / area : Infinity,
    ref: bestReference(area),
    weeks: rebuildWeeks(pts.length, cfg.visits, cfg.perWeek),
    city, cityArea,
    center: { lat: lat0, lon: lon0 },
    span,
    dx: gs.dx
  };
}
