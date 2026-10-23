/* =====================================================================
 * 人生质心 · LIFE CENTROID —— 计算核心（纯函数，浏览器与 Node 共用）
 *
 * 球面质心：把每个停留地按停留时长加权成三维单位向量再求平均
 *     S = Σ w_i · u_i ,   u_i = (cosφ·cosλ, cosφ·sinλ, sinφ)
 *     C = S / |S|
 * 向量法天然跨日期变更线正确：179°E 与 179°W 等权 → 质心落在 180°，不是 0°。
 * 它也天然暴露退化情形：对跖点等权时 |S| = 0，此时「重心」根本不存在，
 * 必须显式报错，绝不能静默给出 (0°N, 0°E) —— 那是几内亚湾，不是你的人生。
 *
 * 两种口径分开实现（纪律：一个量有两种口径就拆成两个函数）：
 *   追加 append  —— 在候选地额外投入每周 h 小时（总量增加）
 *   替换 replace —— 从现有各地点按比例挪走每周 h 小时，给候选地（总量守恒）
 * ===================================================================== */

export const EARTH_R = 6371.0088;                  // km, IUGG 平均半径
export const KM_PER_DEG = Math.PI * EARTH_R / 180; // 111.1949 km / 度
export const DEG = Math.PI / 180;
export const HOURS_PER_WEEK = 168;

/** 数值收进合法域：NaN / 越界一律退回 fallback，绝不把 NaN 放进循环 */
export function num(v, lo, hi, fallback) {
  const x = Number(v);
  if (!isFinite(x)) return fallback;
  return Math.min(hi, Math.max(lo, x));
}

export function clampLat(lat) { return num(lat, -90, 90, 0); }
export function clampLon(lon) {
  let x = num(lon, -720, 720, 0);
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

/* ---------------- 向量 ↔ 经纬度 ---------------- */

export function toVec(lat, lon) {
  const p = clampLat(lat) * DEG, l = clampLon(lon) * DEG;
  const cp = Math.cos(p);
  return { x: cp * Math.cos(l), y: cp * Math.sin(l), z: Math.sin(p) };
}

/** 返回 {lat, lon}；零向量返回 null（调用方必须处理，不许拿 0,0 当答案） */
export function fromVec(v) {
  const n = Math.hypot(v.x, v.y, v.z);
  if (!(n > 0) || !isFinite(n)) return null;
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, v.z / n))) / DEG,
    lon: Math.atan2(v.y, v.x) / DEG
  };
}

/* ---------------- 距离与方位 ---------------- */

export function haversine(a, b) {
  const p1 = clampLat(a.lat) * DEG, p2 = clampLat(b.lat) * DEG;
  const dp = p2 - p1, dl = (clampLon(b.lon) - clampLon(a.lon)) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(Math.max(0, h))));
}

/** 正北起算的方位角（度，0..360） */
export function bearing(a, b) {
  const p1 = clampLat(a.lat) * DEG, p2 = clampLat(b.lat) * DEG;
  const dl = (clampLon(b.lon) - clampLon(a.lon)) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  let th = Math.atan2(y, x) / DEG;
  if (th < 0) th += 360;
  return th;
}

/** 大圆中点（slerp，独立公式）—— 用于校验等权两点质心，不能用质心自己验自己 */
export function slerpMid(a, b) {
  const d = haversine(a, b) / EARTH_R;
  const v1 = toVec(a.lat, a.lon), v2 = toVec(b.lat, b.lon);
  if (d < 1e-12) return { lat: clampLat(a.lat), lon: clampLon(a.lon) };
  if (Math.abs(Math.sin(d)) < 1e-12) return null;      // 对跖点：中点不唯一
  const A = Math.sin((1 - 0.5) * d) / Math.sin(d), B = Math.sin(0.5 * d) / Math.sin(d);
  return fromVec({ x: A * v1.x + B * v2.x, y: A * v1.y + B * v2.y, z: A * v1.z + B * v2.z });
}

/* ---------------- 球面质心 ---------------- */

/**
 * @param {Array<{lat:number,lon:number,w:number}>} pts
 * @returns {{ok:boolean, reason?:string, lat:number, lon:number,
 *            R:number, sumW:number, n:number, unstable:boolean}}
 *   R = |S|/Σw ∈ [0,1]，结果向量长度：1 = 全部时间压在一点，0 = 彻底对冲
 */
export function centroid(pts) {
  const list = (Array.isArray(pts) ? pts : []).map(p => ({
    lat: clampLat(p && p.lat), lon: clampLon(p && p.lon), w: num(p && p.w, 0, 1e9, 0)
  }));
  let sx = 0, sy = 0, sz = 0, sw = 0, nz = 0;
  for (const p of list) {
    if (p.w <= 0) continue;
    nz++;
    const v = toVec(p.lat, p.lon);
    sx += p.w * v.x; sy += p.w * v.y; sz += p.w * v.z; sw += p.w;
  }
  if (nz === 0 || sw <= 0) {
    return { ok: false, reason: 'no-weight', lat: NaN, lon: NaN, R: 0, sumW: 0, n: nz, unstable: true };
  }
  const S = { x: sx, y: sy, z: sz };
  const mag = Math.hypot(sx, sy, sz);
  const R = mag / sw;
  // 退化：对跖点等权（或近似对冲）时 |S| ≈ 0，重心不存在
  if (R < 1e-9) {
    return { ok: false, reason: 'degenerate', lat: NaN, lon: NaN, R, sumW: sw, n: nz, unstable: true };
  }
  const c = fromVec(S);
  if (!c) {
    return { ok: false, reason: 'degenerate', lat: NaN, lon: NaN, R, sumW: sw, n: nz, unstable: true };
  }
  return { ok: true, lat: c.lat, lon: c.lon, R, sumW: sw, n: nz, unstable: R < 0.05 };
}

/** 平面近似质心（等距圆柱投影，围绕 lat0）—— 只用于断言对拍，不作产品输出 */
export function planarCentroid(pts, lat0) {
  const p0 = clampLat(lat0);
  const kx = KM_PER_DEG * Math.cos(p0 * DEG), ky = KM_PER_DEG;
  let sx = 0, sy = 0, sw = 0;
  for (const p of pts) {
    const w = num(p.w, 0, 1e9, 0); if (w <= 0) continue;
    sx += w * (clampLon(p.lon) - p0ref(pts)) * kx;
    sy += w * (clampLat(p.lat) - p0) * ky;
    sw += w;
  }
  if (sw <= 0) return { lat: NaN, lon: NaN };
  return { lat: p0 + (sy / sw) / ky, lon: p0ref(pts) + (sx / sw) / kx };
}
function p0ref(pts) { return clampLon(pts[0].lon); }

/** 加权均方根离散半径（km）：你的人生被拉扯在多大的圈里 */
export function rmsRadius(pts, center) {
  let s = 0, sw = 0;
  for (const p of pts) {
    const w = num(p.w, 0, 1e9, 0); if (w <= 0) continue;
    s += w * haversine({ lat: p.lat, lon: p.lon }, center) ** 2; sw += w;
  }
  return sw > 0 ? Math.sqrt(s / sw) : 0;
}

/** 有效地点数（参与比）：(Σw)² / Σw² ∈ [1, n] */
export function effectiveCount(pts) {
  let s1 = 0, s2 = 0;
  for (const p of pts) { const w = num(p.w, 0, 1e9, 0); s1 += w; s2 += w * w; }
  if (s2 <= 0) return 0;
  return (s1 * s1) / s2;
}

/** 主导度：最大权重占比 ∈ [1/n, 1] */
export function dominance(pts) {
  let mx = 0, s = 0, n = 0;
  for (const p of pts) { const w = num(p.w, 0, 1e9, 0); if (w > mx) mx = w; s += w; if (w > 0) n++; }
  return s > 0 ? mx / s : 0;
}

/* ---------------- 反事实：未来 ---------------- */

/** 未来权重占比 r = Yf / (Yp + Yf) ∈ [0,1] */
export function futureShare(Yp, Yf) {
  const a = num(Yp, 0, 200, 10), b = num(Yf, 0, 200, 10);
  const t = a + b;
  return t <= 0 ? 0 : b / t;
}

/**
 * 追加口径：现有各地不变，候选地额外 +h 小时/周（按比例折算到全周期）
 */
export function weightsAppend(base, cand, h, Yp, Yf) {
  const r = futureShare(Yp, Yf);
  const out = base.map(p => ({ lat: p.lat, lon: p.lon, w: num(p.w, 0, 1e9, 0) }));
  const hh = num(h, 0, HOURS_PER_WEEK, 0);
  if (cand) out.push({ lat: clampLat(cand.lat), lon: clampLon(cand.lon), w: hh * r });
  return out;
}

/**
 * 替换口径：未来那段里，从现有各地按权重比例挪走 h 小时/周给候选地（总量守恒）。
 * 挪走的总量被每周可挪上限（Σw）钳住 —— 你每周只有那么多小时。
 */
export function weightsReplace(base, cand, h, Yp, Yf) {
  const r = futureShare(Yp, Yf);
  const clean = base.map(p => ({ lat: p.lat, lon: p.lon, w: num(p.w, 0, 1e9, 0) }));
  const sumW = clean.reduce((s, p) => s + p.w, 0);
  const hh = Math.min(num(h, 0, HOURS_PER_WEEK, 0), sumW);   // 可挪上限
  const frac = sumW > 0 ? hh / sumW : 0;                      // 各地被挪走的比例
  const out = clean.map(p => ({ lat: p.lat, lon: p.lon, w: p.w * (1 - frac * r) }));
  if (cand) out.push({ lat: clampLat(cand.lat), lon: clampLon(cand.lon), w: hh * r });
  return out;
}

export function weightsFor(base, cand, h, Yp, Yf, mode) {
  return mode === 'replace' ? weightsReplace(base, cand, h, Yp, Yf)
    : weightsAppend(base, cand, h, Yp, Yf);
}

/** 追加口径每周可投入上限；替换口径每周可挪上限 */
export function hMax(base, mode) {
  const sumW = (base || []).reduce((s, p) => s + num(p.w, 0, 1e9, 0), 0);
  return mode === 'replace' ? sumW : HOURS_PER_WEEK;
}

/** 位移：现状质心 → 未来质心（km） */
export function futureShift(base, cand, h, Yp, Yf, mode) {
  const c0 = centroid(base);
  const w = weightsFor(base, cand, h, Yp, Yf, mode);
  const c1 = centroid(w);
  if (!c0.ok || !c1.ok) return { ok: false, dist: NaN, bearing: NaN, lat: NaN, lon: NaN };
  return {
    ok: true, lat: c1.lat, lon: c1.lon,
    dist: haversine(c0, c1), bearing: bearing(c0, c1)
  };
}

/**
 * 反解 A：要让质心进入距候选地 targetKm 以内，每周得在那儿花多少小时。
 * g(h) 单调递减；不可达返回 Infinity（绝不返回负数）。
 */
export function hoursForDistance(base, cand, Yp, Yf, mode, targetKm) {
  const tgt = num(targetKm, 0.1, 20000, 50);
  const hi = hMax(base, mode);
  const g = h => {
    const w = weightsFor(base, cand, h, Yp, Yf, mode);
    const c = centroid(w);
    return c.ok ? haversine(c, cand) : Infinity;
  };
  if (g(0) <= tgt) return 0;
  if (hi <= 0) return Infinity;
  if (g(hi) > tgt) return Infinity;
  let lo = 0, up = hi;
  for (let i = 0; i < 80 && (up - lo) > 1e-7; i++) {
    const mid = (lo + up) / 2;
    if (g(mid) > tgt) lo = mid; else up = mid;
  }
  return (lo + up) / 2;
}

/**
 * 能靠到多近：把每周可挪/可投的额度用满之后，重心到候选地的最短距离。
 * 这个量解释了一件反直觉的事 —— 即使你从此 100% 时间待在候选地，
 * 重心也搬不过去，因为「过去那些年」已经在加权里占了固定份额。
 * 它决定了「搬得动 / 搬不动」的下限，比单纯的 Infinity 有用得多。
 */
export function minReachableDist(base, cand, Yp, Yf, mode) {
  if (!cand) return Infinity;
  const hi = hMax(base, mode);
  const c = centroid(weightsFor(base, cand, hi, Yp, Yf, mode));
  return c.ok ? haversine(c, cand) : Infinity;
}

/**
 * 反解 B：每周固定投入 h 小时，要让质心进入 targetKm 以内需要多少年。
 * 与 hoursForDistance 对偶；不可达返回 Infinity。
 */
export function yearsToMove(base, cand, h, Yp, Yf0, mode, targetKm) {
  const tgt = num(targetKm, 0.1, 20000, 50);
  const Yp0 = num(Yp, 0, 200, 10);
  const hh = num(h, 0, HOURS_PER_WEEK, 0);
  const g = r => {
    const Yf = r >= 1 ? 1e12 : (r * Yp0) / (1 - r);   // 由 r 反解出对应的年数
    const c = centroid(weightsFor(base, cand, hh, Yp0, Yf, mode));
    return c.ok ? haversine(c, cand) : Infinity;
  };
  if (hh <= 0) return Infinity;
  if (g(0) <= tgt) return 0;
  if (g(1) > tgt) return Infinity;              // 全部未来都押上也够不着
  let lo = 0, up = 1;
  for (let i = 0; i < 80 && (up - lo) > 1e-9; i++) {
    const mid = (lo + up) / 2;
    if (g(mid) > tgt) lo = mid; else up = mid;
  }
  const r = (lo + up) / 2;
  if (r >= 1) return Infinity;
  if (Yp0 <= 0) return 0;                        // 过去不计，未来一开年就到位
  return (r * Yp0) / (1 - r);
}

/* ---------------- 方位中文 ---------------- */
const DIRS = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'];
export function bearingName(deg) {
  const d = num(deg, 0, 360, 0);
  return DIRS[Math.round(d / 45) % 8];
}

/* ---------------- 预设场景（演示数据） ---------------- */
export const PRESETS = {
  '北漂十年': {
    home: 0, cand: { name: '长沙', lat: 28.2282, lon: 112.9388 },
    anchors: [
      { name: '北京·回龙观的家', lat: 40.0748, lon: 116.3372, w: 62 },
      { name: '北京·西二旗公司', lat: 40.0536, lon: 116.3039, w: 48 },
      { name: '保定·父母家', lat: 38.8730, lon: 115.4646, w: 3 },
      { name: '长沙·老家', lat: 28.2282, lon: 112.9388, w: 0.6 }
    ], Yp: 10, Yf: 10, h: 20, mode: 'replace', targetPct: 30
  },
  '双城生活': {
    home: 0, cand: { name: '杭州', lat: 30.2741, lon: 120.1551 },
    anchors: [
      { name: '北京·家', lat: 39.9042, lon: 116.4074, w: 70 },
      { name: '上海·家', lat: 31.2304, lon: 121.4737, w: 55 },
      { name: '老家·哈尔滨', lat: 45.8038, lon: 126.5349, w: 2 }
    ], Yp: 6, Yf: 10, h: 30, mode: 'replace', targetPct: 30
  },
  '异地恋': {
    home: 0, cand: { name: '成都', lat: 30.5728, lon: 104.0668 },
    anchors: [
      { name: '北京·家', lat: 39.9042, lon: 116.4074, w: 95 },
      { name: '成都·她的家', lat: 30.5728, lon: 104.0668, w: 25 }
    ], Yp: 3, Yf: 5, h: 40, mode: 'replace', targetPct: 30
  },
  '数字游民': {
    home: 0, cand: { name: '清迈', lat: 18.7883, lon: 98.9853 },
    anchors: [
      { name: '大理·古城', lat: 25.6065, lon: 100.2676, w: 100 },
      { name: '清迈·宁曼路', lat: 18.7883, lon: 98.9853, w: 40 },
      { name: '深圳·总部', lat: 22.5431, lon: 114.0579, w: 8 }
    ], Yp: 2, Yf: 5, h: 30, mode: 'append', targetPct: 30
  },
  '一辈子没挪窝': {
    home: 0, cand: { name: '广州', lat: 23.1291, lon: 113.2644 },
    anchors: [
      { name: '长沙·家里', lat: 28.2282, lon: 112.9388, w: 150 },
      { name: '长沙·公司', lat: 28.1890, lon: 112.9380, w: 12 }
    ], Yp: 35, Yf: 10, h: 20, mode: 'replace', targetPct: 30
  }
};

/* ---------------- 主计算 ---------------- */
export function compute(state) {
  const base = (state.anchors || []).map(a => ({ lat: a.lat, lon: a.lon, w: num(a.w, 0, HOURS_PER_WEEK, 0), name: a.name }));
  const cand = state.cand || null;
  const Yp = num(state.Yp, 0, 200, 10), Yf = num(state.Yf, 0, 200, 10);
  const h = num(state.h, 0, HOURS_PER_WEEK, 0);
  const mode = state.mode === 'replace' ? 'replace' : 'append';
  // 目标距离有两种给法：绝对公里数，或「把到候选地的距离拉近百分之几」。
  // 后者是默认 —— 绝对公里数在跨省场景里几乎总是够不着（50 km 对 1400 km 的分布来说
  // 是另一个量级），页面上会满屏 ∞，看着像坏了。按比例问，答案才总落在有意义的区间。
  const targetPct = isFinite(Number(state.targetPct)) ? num(state.targetPct, 1, 99, 50) : null;
  const homeIdx = Math.min(Math.max(0, Math.floor(num(state.homeIdx, 0, 1e6, 0))), Math.max(0, base.length - 1));

  const c0 = centroid(base);
  const out = {
    ok: c0.ok, reason: c0.reason || '', lat: c0.lat, lon: c0.lon,
    R: c0.R, n: c0.n, sumW: c0.sumW, unstable: c0.unstable,
    rms: 0, nEff: 0, dom: 0, home: null, homeDist: 0, homeBearing: 0,
    fut: null, hoursNeeded: Infinity, yearsNeeded: Infinity,
    bestDist: Infinity, share: futureShare(Yp, Yf), startDist: 0,
    totalWeekly: base.reduce((s, p) => s + p.w, 0),
    mode, h, Yp, Yf, targetKm: 0, targetPct, cand
  };
  if (!c0.ok) return out;

  out.rms = rmsRadius(base, { lat: c0.lat, lon: c0.lon });
  out.nEff = effectiveCount(base);
  out.dom = dominance(base);

  if (base.length > 0) {
    const hm = base[homeIdx];
    out.home = hm;
    out.homeDist = haversine(c0, hm);
    out.homeBearing = bearing(hm, c0);
  }
  if (cand) {
    out.startDist = haversine(c0, cand);                       // 现在重心离候选地多远
    out.targetKm = targetPct != null
      ? Math.max(1, out.startDist * (1 - targetPct / 100))
      : num(state.targetKm, 0.1, 20000, 50);
    out.fut = futureShift(base, cand, h, Yp, Yf, mode);
    out.hoursNeeded = hoursForDistance(base, cand, Yp, Yf, mode, out.targetKm);
    out.yearsNeeded = yearsToMove(base, cand, Math.max(h, 1e-6), Yp, Yf, mode, out.targetKm);
    out.bestDist = minReachableDist(base, cand, Yp, Yf, mode);
    out.share = futureShare(Yp, Yf);
  }
  return out;
}
