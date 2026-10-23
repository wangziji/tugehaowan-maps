/* =====================================================================
 * 起步税 · STARTUP TAX —— 门到门出行模型
 *
 * 核心命题：每一种交通工具都有一笔「与距离无关的固定成本」——
 * 等车、走到上车点、安检候机、找车位、出站进城。这笔钱（时间）不随距离变化，
 * 于是存在一个「最短适用距离」：低于它，这种方式比更慢但零启动的方式还慢。
 *
 * 门到门时间（小时）：
 *     T(d) = S / 60 + (d * k) / V
 *   S = 固定启动税（分钟）   k = 路径绕行系数（路径里程 / 直线距离）
 *   V = 在途速度（km/h）     d = 两点直线距离（km）
 *
 * 自驾例外：城市段与高速段速度不同，走两段模型。
 * ===================================================================== */

const EARTH_R = 6371.0088;   // km，IUGG 平均半径
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 数值收口：任何可直填的输入先过这里，杜绝 NaN 死循环 */
function num(v, lo, hi, dft) {
  const x = Number(v);
  if (!isFinite(x)) return dft;
  return clamp(x, lo, hi);
}

/** 大圆距离（km） */
function haversine(lat1, lon1, lat2, lon2) {
  const p1 = toRad(num(lat1, -90, 90, 0)), p2 = toRad(num(lat2, -90, 90, 0));
  const dp = p2 - p1;
  const dl = toRad(num(lon2, -360, 360, 0) - num(lon1, -360, 360, 0));
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(clamp(Math.sqrt(a), 0, 1));
}

/** 起点方位角（度，正北为 0，顺时针） */
function bearing(lat1, lon1, lat2, lon2) {
  const p1 = toRad(num(lat1, -90, 90, 0)), p2 = toRad(num(lat2, -90, 90, 0));
  const dl = toRad(num(lon2, -360, 360, 0) - num(lon1, -360, 360, 0));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** 从 (lat,lng) 沿 bearing 走 d km 后的落点 */
function destPoint(lat, lng, brngDeg, d) {
  const R = EARTH_R, dlt = num(d, 0, 1e6, 0) / R, th = toRad(num(brngDeg, -720, 720, 0));
  const p1 = toRad(num(lat, -90, 90, 0)), l1 = toRad(num(lng, -360, 360, 0));
  const sp2 = Math.sin(p1) * Math.cos(dlt) + Math.cos(p1) * Math.sin(dlt) * Math.cos(th);
  const p2 = Math.asin(clamp(sp2, -1, 1));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(dlt) * Math.cos(p1), Math.cos(dlt) - Math.sin(p1) * sp2);
  return { lat: toDeg(p2), lng: ((toDeg(l2) + 540) % 360) - 180 };
}

/* ---------------------------------------------------------------------
 * 方式参数表
 * 全部为「典型城市 / 典型城际」的量级估算，页面上标注为演示模型。
 *   S   固定启动税（分钟）：从门到「已经在路上」+ 从「到达」到门口
 *   V   在途速度（km/h），已含站停、红灯、滑行等随距离弱相关的损耗
 *   k   路径里程 / 直线距离
 *   Vw  算「白走公里数」时用的速度（自驾取高速段，否则取 V）
 * ------------------------------------------------------------------- */
const MODES = [
  { id: 'walk',  name: '步行', S: 0,   V: 4.8, k: 1.00, Vw: 4.8,       dmin: 0,   dmax: Infinity, color: '#64748b', note: '零启动税，只有脚' },
  { id: 'bike',  name: '骑车', S: 4,   V: 11,  k: 1.15, Vw: 11,        dmin: 0,   dmax: 15,       color: '#0ea5e9', note: '找车 + 解锁 + 还车' },
  { id: 'taxi',  name: '打车', S: 8,   V: 21,  k: 1.35, Vw: 21,        dmin: 0,   dmax: 120,      color: '#f59e0b', note: '等车 + 走到上车点' },
  { id: 'metro', name: '地铁', S: 18,  V: 30,  k: 1.15, Vw: 30,        dmin: 0,   dmax: 60,       color: '#22c55e', note: '走到站 + 等车 + 进出站' },
  { id: 'car',   name: '自驾', S: 20,  V: null, k: 1.20, Vw: 85,       dmin: 0,   dmax: Infinity, color: '#ef4444', note: '取车 + 找车位 + 停好走进去' },
  { id: 'rail',  name: '高铁', S: 105, V: 260, k: 1.25, Vw: 260,       dmin: 40,  dmax: Infinity, color: '#8b5cf6', note: '去火车站 + 安检候车 + 出站进城' },
  { id: 'air',   name: '飞机', S: 240, V: 650, k: 1.05, Vw: 650,       dmin: 250, dmax: Infinity, color: '#06b6d4', note: '去机场 + 值机安检候机 + 取行李 + 进城' },
];

/** 自驾两段模型：前 15 km 路径按城市速度 28 km/h，之后按高速 85 km/h */
const CAR_CITY_KM = 15, CAR_CITY_V = 28, CAR_HW_V = 85;

const MODE_BY_ID = Object.fromEntries(MODES.map(m => [m.id, m]));

/** 该方式在这个距离上是否成立（高铁 40 km 起步、飞机 250 km 起步等） */
function available(mode, d) {
  return d >= mode.dmin && d <= mode.dmax;
}

/** 门到门时间（小时）。不适用时返回 Infinity，绝不返回负数或 NaN。 */
function timeH(mode, d) {
  const dd = num(d, 0, 1e6, 0);
  if (!available(mode, dd)) return Infinity;
  if (mode.id === 'car') {
    const p = dd * mode.k;
    const city = Math.min(p, CAR_CITY_KM);
    const hw = Math.max(0, p - CAR_CITY_KM);
    return mode.S / 60 + city / CAR_CITY_V + hw / CAR_HW_V;
  }
  return mode.S / 60 + (dd * mode.k) / mode.V;
}

/** 纯在途时间（小时），不含启动税 */
function rideH(mode, d) {
  const t = timeH(mode, d);
  if (!isFinite(t)) return Infinity;
  return t - mode.S / 60;
}

/** 「白走的公里数」：启动税这段时间，本来能走/飞多远（按直线距离折算） */
function wasteKm(mode) {
  return (mode.S / 60) * (mode.Vw / mode.k);
}

/** 启动税占门到门时间的比例（0–1） */
function wasteFrac(mode, d) {
  const t = timeH(mode, d);
  if (!isFinite(t) || t <= 0) return 0;
  return clamp((mode.S / 60) / t, 0, 1);
}

/** 在给定距离上，所有方式的时间与可用性 */
function compare(d) {
  const list = MODES.map(m => {
    const t = timeH(m, d);
    return {
      id: m.id, name: m.name, color: m.color, note: m.note,
      t, ok: available(m, d),
      ride: isFinite(t) ? t - m.S / 60 : Infinity,
      wasteFrac: wasteFrac(m, d),
      wasteKm: wasteKm(m),
    };
  });
  const usable = list.filter(x => x.ok);
  usable.sort((a, b) => a.t - b.t);
  return { list, ranked: usable, best: usable[0] || null };
}

/** 二分求两种方式的交叉距离（km）；无交叉返回 null */
function crossover(a, b, lo, hi) {
  const fa = d => timeH(a, d) - timeH(b, d);
  let flo = fa(lo), fhi = fa(hi);
  if (!isFinite(flo) || !isFinite(fhi)) {
    // 端点可能落在不可用域，向内收一点再判
    flo = fa(lo * 1.0001); fhi = fa(hi * 0.9999);
  }
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(lo * hi);          // 几何中点：跨数量级时收敛更快
    const fm = fa(mid);
    if (fm === 0) return mid;
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

/** 七段相图：按最优方式把距离轴切成若干带 */
function bands(dLo = 1e-3, dHi = 5000, steps = 4000) {
  const out = [];
  let prevId = null, startD = dLo;
  const at = d => { const b = compare(d).best; return b ? b.id : null; };
  for (let i = 0; i <= steps; i++) {
    const d = dLo * Math.pow(dHi / dLo, i / steps);
    const id = at(d);
    if (id !== prevId) {
      if (prevId !== null) {
        // 在 [上一个采样点, d] 之间二分出真正的边界
        const dPrev = dLo * Math.pow(dHi / dLo, (i - 1) / steps);
        const A = MODE_BY_ID[prevId], B = MODE_BY_ID[id];
        let edge = null;
        // 边界可能是 A→B，也可能是因为 A 失效（dmax）而让位，先试两两交叉
        if (A && B) edge = crossover(A, B, dPrev, d);
        if (edge == null) edge = d;
        out.push({ from: startD, to: edge, id: prevId, name: MODE_BY_ID[prevId].name, color: MODE_BY_ID[prevId].color });
        startD = edge;
      }
      prevId = id;
    }
  }
  if (prevId !== null) out.push({ from: startD, to: Infinity, id: prevId, name: MODE_BY_ID[prevId].name, color: MODE_BY_ID[prevId].color });
  return out;
}

/* ---------------- 城市坐标（腾讯地图 WebService 地址解析实测） ---------------- */
const CITIES = [
  { name: '北京', lat: 39.905023, lng: 116.724502 },
  { name: '天津', lat: 39.085318, lng: 117.201509 },
  { name: '济南', lat: 36.652069, lng: 117.120128 },
  { name: '郑州', lat: 34.746303, lng: 113.625351 },
  { name: '上海', lat: 31.230525, lng: 121.473667 },
  { name: '南京', lat: 32.059344, lng: 118.796624 },
  { name: '杭州', lat: 30.246026, lng: 120.210792 },
  { name: '武汉', lat: 30.593354, lng: 114.304569 },
  { name: '长沙', lat: 28.228304, lng: 112.938882 },
  { name: '广州', lat: 23.130061, lng: 113.264499 },
  { name: '深圳', lat: 22.543527, lng: 114.057939 },
  { name: '西安', lat: 34.343207, lng: 108.939645 },
  { name: '成都', lat: 30.572961, lng: 104.066301 },
  { name: '重庆', lat: 29.562686, lng: 106.551720 },
  { name: '哈尔滨', lat: 45.802981, lng: 126.535050 },
  { name: '乌鲁木齐', lat: 43.825377, lng: 87.616824 },
  { name: '拉萨', lat: 29.653491, lng: 91.171924 },
  { name: '昆明', lat: 24.881490, lng: 102.833669 },
];
const CITY_BY_NAME = Object.fromEntries(CITIES.map(c => [c.name, c]));

/** 演示预设：起点固定北京，覆盖七个相带 */
const PRESETS = [
  { name: '下楼买咖啡', from: '北京', to: null, d: 0.4, hint: '门到门 400 米' },
  { name: '地铁口两公里', from: '北京', to: null, d: 2, hint: '打车还是骑车' },
  { name: '跨城通勤', from: '北京', to: null, d: 12, hint: ' Metro 与自驾的分水岭' },
  { name: '北京 → 天津', from: '北京', to: '天津', d: null, hint: '自驾与高铁的边界' },
  { name: '北京 → 济南', from: '北京', to: '济南', d: null, hint: '高铁稳赢区' },
  { name: '北京 → 上海', from: '北京', to: '上海', d: null, hint: '飞机反超区' },
  { name: '北京 → 广州', from: '北京', to: '广州', d: null, hint: '长途' },
  { name: '北京 → 乌鲁木齐', from: '北京', to: '乌鲁木齐', d: null, hint: '极长途' },
];

/** 人类可读时长 */
function fmtDur(h) {
  if (!isFinite(h)) return '—';
  const m = Math.round(h * 60);
  if (m < 60) return m + ' 分钟';
  const H = Math.floor(m / 60), M = m % 60;
  return M === 0 ? H + ' 小时' : H + ' 小时 ' + M + ' 分';
}

function fmtKm(v) {
  if (!isFinite(v)) return '∞';
  if (v >= 10000) return (v / 10000).toFixed(2) + ' 万';
  if (v >= 1000) return (v / 1000).toFixed(2) + ' 千';
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export {
  EARTH_R, MODES, MODE_BY_ID, CITIES, CITY_BY_NAME, PRESETS,
  CAR_CITY_KM, CAR_CITY_V, CAR_HW_V,
  num, clamp, haversine, toRad, toDeg, bearing, destPoint,
  available, timeH, rideH, wasteKm, wasteFrac, compare, crossover, bands,
  fmtDur, fmtKm,
};
