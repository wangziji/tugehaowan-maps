/* =====================================================================
 * 起步税 · STARTUP TAX —— 界面与地图
 *
 * 纪律（历次踩坑，逐条对应下面代码）：
 *  1. 入口必须自启动（祖先洪流：boot 挂在 window 上却忘了调用，断言全绿而页面空白）
 *  2. catch 里不许只 console.warn —— 必须留下用户可见痕迹
 *  3. marker 图标一律内联 SVG data URI（腾讯官方示例外链图已 404，A/B 会退化成同一个）
 *  4. 圆半径按纬度钳制（MultiCircle 大半径会抛 LatLng 越界），超限降级 + 面板可见提示
 *  5. 本版 TMap GL 的 fitBounds 只挪中心不改 zoom —— 自己按容器像素解 Mercator zoom
 *  6. 节流函数先判前置条件再写时间戳，否则早退会污染节流状态
 * ===================================================================== */
import {
  MODES, MODE_BY_ID, CITIES, CITY_BY_NAME, PRESETS, EARTH_R,
  num, clamp, haversine, bearing, destPoint,
  timeH, wasteKm, wasteFrac, compare, bands, available, fmtDur, fmtKm,
} from './model.js';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* ---------------- 内联 SVG 图标（外链 markerDefault.png 已 404） ---------------- */
const svg = (body, w, h) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
const ICON_START = svg(`<circle cx="13" cy="13" r="10" fill="#1e2430" stroke="#fff" stroke-width="3"/><circle cx="13" cy="13" r="3.6" fill="#fff"/>`, 26, 26);
const ICON_END = svg(`<path d="M13 25 C13 25 4 16.4 4 10.6 A9 9 0 0 1 22 10.6 C22 16.4 13 25 13 25 Z" fill="#c2410c" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/><circle cx="13" cy="10.6" r="3.1" fill="#fff"/>`, 26, 26);

/* ---------------- 状态 ---------------- */
const state = {
  from: '北京',
  toCity: '上海',
  custom: null,        // {lat,lng} 地图点选的终点
  bearing: 118,
  d: 1055,
  selMode: null,       // 地图上展示「白走圈」的方式
  preset: null,
  view: 'route',       // route = 看两地 ｜ waste = 看白走圈（往往比两地远得多）
};

let map = null, mapReady = false;
let mkStart = null, mkEnd = null, mlLine = null, mcBands = null, mcWaste = null;
let lastFit = 0;
const BANDS = bands();

/* ---------------- 工具 ---------------- */
function toast(msg) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 1900);
}
function showError(msg) {
  const box = $('maperr'); if (!box) return;
  box.textContent = msg; box.style.display = 'block';
}
function clearError() { const box = $('maperr'); if (box) { box.style.display = 'none'; box.textContent = ''; } }

/** MultiCircle 大半径会抛 LatLng 越界，按纬度钳制（历次实测的安全上限） */
function safeRadiusKm(lat, rKm) {
  const cap = (83 - Math.abs(num(lat, -90, 90, 0))) * 0.90 * 111.19;
  return { r: Math.min(rKm, cap), capped: rKm > cap, cap };
}

/** 腾讯地图 GL 不接受 8 位十六进制颜色（#1e2430cc 会被判「属性无效」并刷控制台），
 *  必须转成 rgba()。这个错误只有真实浏览器看得见 —— Node 桩不会校验颜色。 */
function rgba(hex, a) {
  const h = String(hex).replace('#', '');
  const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(s, 16);
  if (!isFinite(n)) return `rgba(30,36,48,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 每像素米数（Web Mercator，256px world） */
function metersPerPixel(lat, zoom) {
  return 156543.03392 * Math.cos(toRadLocal(lat)) / Math.pow(2, clamp(zoom, 0, 30));
}
const toRadLocal = d => d * Math.PI / 180;

/* ---------------- 自己解 zoom（fitBounds 在本版 TMap GL 只挪中心不改 zoom） ---------------- */
const mercX = lng => (num(lng, -360, 360, 0) + 180) / 360;
const mercY = lat => {
  const s = Math.sin(toRadLocal(clamp(num(lat, -90, 90, 0), -85, 85)));
  return 0.5 - Math.atanh(clamp(s, -0.999999, 0.999999)) / (2 * Math.PI);
};
const invMercY = y => {
  const t = (0.5 - clamp(y, -1, 2)) * 2 * Math.PI;
  return (Math.atan(Math.sinh(t)) * 180) / Math.PI;
};
function fitView(pts, pad = 0.14) {
  if (!map || !mapReady || !pts.length) return;
  const box = $('map'); if (!box) return;
  const W = Math.max(box.clientWidth || 640, 240), H = Math.max(box.clientHeight || 462, 240);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    const x = mercX(p.lng), y = mercY(p.lat);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  let dx = Math.abs(x1 - x0); if (dx > 0.5) dx = 1 - dx;          // 跨 180° 经线
  const dy = Math.abs(y1 - y0);
  const kx = (W * (1 - 2 * pad)) / 256, ky = (H * (1 - 2 * pad)) / 256;
  const zx = dx > 1e-9 ? Math.log2(kx / dx) : 16;
  const zy = dy > 1e-9 ? Math.log2(ky / dy) : 16;
  const z = clamp(Math.floor(Math.min(zx, zy) * 100) / 100, 3, 15.5);
  const cx = (Math.min(x0, x1) + Math.max(x0, x1)) / 2, cy = (y0 + y1) / 2;
  map.setCenter(new TMap.LatLng(invMercY(cy), cx * 360 - 180));
  map.setZoom(z);
}

/* ---------------- 终点与距离 ---------------- */
function currentTarget() {
  if (state.custom) return { lat: state.custom.lat, lng: state.custom.lng, label: '地图选点' };
  const c = CITY_BY_NAME[state.toCity];
  if (c && !state.custom) {
    // 城市模式下距离固定为两城实际距离；拖动滑块时改用方位 + 距离重算落点
    const a = CITY_BY_NAME[state.from];
    const realD = haversine(a.lat, a.lng, c.lat, c.lng);
    if (Math.abs(realD - state.d) < 0.5) return { lat: c.lat, lng: c.lng, label: c.name };
  }
  const a = CITY_BY_NAME[state.from] || CITIES[0];
  const p = destPoint(a.lat, a.lng, state.bearing, state.d);
  return { lat: p.lat, lng: p.lng, label: state.toCity === '__custom' ? '自定义距离' : state.toCity };
}

/* ---------------- 渲染：数字卡 ---------------- */
function renderStats(c) {
  const best = c.best;
  $('s-best').innerHTML = best ? esc(best.name) : '—';
  $('s-best').style.color = best ? best.color : '';
  const second = c.ranked[1];
  $('s-best-ft').textContent = second
    ? `第二选择是${second.name}，多花 ${fmtDur(second.t - best.t)}`
    : '—';

  $('s-time').innerHTML = best ? fmtDur(best.t) : '—';
  $('s-time-ft').textContent = best
    ? `其中在途 ${fmtDur(best.ride)}，起步税 ${fmtDur(MODE_BY_ID[best.id].S / 60)}`
    : '—';

  const m = MODE_BY_ID[state.selMode || (best && best.id) || 'taxi'];
  $('s-waste').innerHTML = fmtKm(wasteKm(m)) + ' <small>km</small>';
  $('s-waste').style.color = m.color;
  $('s-waste-ft').textContent = `${m.name}：起步税 ${m.S} 分钟，够走 ${fmtKm(wasteKm(m))} 公里`;

  const frac = best ? wasteFrac(MODE_BY_ID[best.id], state.d) : 0;
  $('s-frac').innerHTML = (frac * 100).toFixed(0) + ' <small>%</small>';
  $('s-frac-ft').textContent = best
    ? `最优方式下，这段路有 ${(frac * 100).toFixed(0)}% 的时间花在「出发」上`
    : '—';
}

/* ---------------- 渲染：排行 ---------------- */
function renderRank(c) {
  const maxT = Math.max(...c.ranked.map(r => r.t));
  const box = $('rank'); if (!box) return;
  box.innerHTML = '';
  const ordered = c.list.slice().sort((a, b) => (a.t - b.t) || (a.id < b.id ? -1 : 1));
  for (const r of ordered) {
    const row = document.createElement('div');
    row.className = 'rk' + (r.ok ? '' : ' off') + (c.best && r.id === c.best.id ? ' best' : '');
    row.dataset.mode = r.id;
    const pct = r.ok ? clamp(r.t / maxT, 0, 1) * 100 : 0;
    const wPct = r.ok ? clamp(wasteFrac(MODE_BY_ID[r.id], state.d), 0, 1) * 100 : 0;
    row.innerHTML =
      `<div class="nm"><i class="dot" style="background:${r.color}"></i>${esc(r.name)}</div>` +
      `<div><div class="bar"><i style="width:${pct.toFixed(1)}%;background:${r.color}"></i>` +
      `<i class="ghost" style="width:${wPct.toFixed(1)}%;background:#1e2430"></i></div>` +
      `<div class="wst">${r.ok ? `起步税占 ${(wasteFrac(MODE_BY_ID[r.id], state.d) * 100).toFixed(0)}%` : esc(r.note)}</div></div>` +
      `<div class="tm">${r.ok ? fmtDur(r.t) : '—'}</div>`;
    row.addEventListener('click', () => {
      state.selMode = r.id; state.preset = null; state.view = 'waste';
      renderAll(); fitNow(true);
    });
    box.appendChild(row);
  }
  const hint = $('rank-hint');
  if (hint) hint.textContent = '细灰条 = 起步税占门到门时间的比例。灰色越长的那一行，说明你越多时间花在「出发」而不是「路上」。';
}

/* ---------------- 渲染：相图曲线 ---------------- */
const XMIN = -1, XMAX = 3.7, YMAX = 10;
const CW = 720, CH = 300, PL = 44, PR = 12, PT = 12, PB = 34;
const PW = CW - PL - PR, PH = CH - PT - PB;
const cx = d => PL + (Math.log10(clamp(d, 1e-6, 1e7)) - XMIN) / (XMAX - XMIN) * PW;
const cy = t => PT + (1 - clamp(t, -2, 40) / YMAX) * PH;

function renderChart(curD, c) {
  const parts = [];
  parts.push(`<svg class="chart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="门到门时间随距离变化">`);
  parts.push(`<defs><clipPath id="cp"><rect x="${PL}" y="${PT - 40}" width="${PW}" height="${PH + 40}"/></clipPath></defs>`);
  parts.push(`<rect x="${PL}" y="${PT}" width="${PW}" height="${PH}" fill="#fbfcfd" stroke="#e9ecf1"/>`);
  for (let t = 0; t <= YMAX; t += 2) {
    parts.push(`<line x1="${PL}" y1="${cy(t).toFixed(1)}" x2="${PL + PW}" y2="${cy(t).toFixed(1)}" stroke="#eef1f5"/>`);
    parts.push(`<text x="${PL - 7}" y="${(cy(t) + 4).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#8f97a6">${t}h</text>`);
  }
  for (const d of [0.1, 1, 10, 100, 1000]) {
    parts.push(`<line x1="${cx(d).toFixed(1)}" y1="${PT}" x2="${cx(d).toFixed(1)}" y2="${PT + PH}" stroke="#eef1f5"/>`);
    parts.push(`<text x="${cx(d).toFixed(1)}" y="${PT + PH + 16}" text-anchor="middle" font-size="10.5" fill="#8f97a6">${d < 1 ? d : d}</text>`);
  }
  parts.push(`<text x="${PL + PW}" y="${PT + PH + 16}" text-anchor="end" font-size="10.5" fill="#8f97a6">5000</text>`);
  parts.push(`<text x="${PL + PW / 2}" y="${CH - 5}" text-anchor="middle" font-size="10.5" fill="#8f97a6">直线距离（公里，对数刻度）</text>`);

  // 临界距离竖线
  for (const b of BANDS) {
    if (!isFinite(b.to)) continue;
    const x = cx(b.to).toFixed(1);
    parts.push(`<line x1="${x}" y1="${PT}" x2="${x}" y2="${PT + PH}" stroke="#c9cfd8" stroke-dasharray="3 3"/>`);
  }

  parts.push('<g clip-path="url(#cp)">');
  for (const m of MODES) {
    let dpath = '';
    const N = 260;
    for (let i = 0; i <= N; i++) {
      const d = Math.pow(10, XMIN + (XMAX - XMIN) * i / N);
      const t = timeH(m, d);
      if (!isFinite(t)) { dpath = ''; continue; }
      const px = cx(d).toFixed(1), py = cy(t).toFixed(1);
      dpath += (dpath ? ' L' : 'M') + px + ' ' + py;
      if (py > PT + PH + 30) { dpath = ''; }   // 已经掉出画布，截断避免拖长线
    }
    if (dpath) parts.push(`<path d="${dpath}" fill="none" stroke="${m.color}" stroke-width="1.7" opacity=".85"/>`);
  }
  // 下包络（最优方式）
  let env = '';
  for (let i = 0; i <= 520; i++) {
    const d = Math.pow(10, XMIN + (XMAX - XMIN) * i / 520);
    const b = compare(d).best; if (!b) continue;
    env += (env ? ' L' : 'M') + cx(d).toFixed(1) + ' ' + cy(b.t).toFixed(1);
  }
  if (env) parts.push(`<path d="${env}" fill="none" stroke="#1e2430" stroke-width="3.4" stroke-linejoin="round" opacity=".92"/>`);
  parts.push('</g>');

  // 当前距离标记
  const xc = cx(curD).toFixed(1);
  parts.push(`<line x1="${xc}" y1="${PT}" x2="${xc}" y2="${PT + PH}" stroke="#c2410c" stroke-width="1.6"/>`);
  if (c.best) {
    const py = cy(c.best.t).toFixed(1);
    parts.push(`<circle cx="${xc}" cy="${py}" r="4.6" fill="#fff" stroke="#c2410c" stroke-width="2.4"/>`);
  }
  parts.push('</svg>');
  const box = $('chart'); if (box) box.innerHTML = parts.join('');

  const lg = $('legend');
  if (lg) lg.innerHTML = MODES.map(m =>
    `<span><i style="background:${m.color}"></i>${esc(m.name)}</span>`).join('') +
    `<span><i style="background:#1e2430"></i>下包络 = 该距离上的最优方式</span>`;
}

/* ---------------- 渲染：相带条 ---------------- */
function renderBands() {
  const H = 46, W = 720;
  const parts = [`<svg class="chart" viewBox="0 0 ${W} ${H + 42}" role="img" aria-label="七个相带">`];
  const x = d => (Math.log10(clamp(d, 1e-6, 1e7)) - XMIN) / (XMAX - XMIN) * W;
  for (const b of BANDS) {
    const x0 = x(b.from), x1 = isFinite(b.to) ? x(b.to) : W;
    const w = Math.max(x1 - x0, 1.2);
    parts.push(`<rect x="${x0.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}" fill="${b.color}" opacity=".88"/>`);
    if (w > 46) {
      parts.push(`<text x="${(x0 + w / 2).toFixed(1)}" y="${H / 2 + 4}" text-anchor="middle" font-size="11.5" fill="#fff" font-weight="600">${esc(b.name)}</text>`);
    }
  }
  // 当前距离游标
  const xc = x(state.d).toFixed(1);
  parts.push(`<line x1="${xc}" y1="-3" x2="${xc}" y2="${H + 6}" stroke="#1e2430" stroke-width="2"/>`);
  // 下方文字列表（窄带放不下字，用列表补全）
  const txt = BANDS.map(b => {
    const to = isFinite(b.to) ? fmtKm(b.to) + ' km' : '∞';
    return `${esc(b.name)} ${fmtKm(b.from)}–${to}`;
  }).join('   ·   ');
  parts.push(`<text x="0" y="${H + 22}" font-size="11" fill="#5a6374">${txt}</text>`);
  parts.push('</svg>');
  const box = $('bandstrip'); if (box) box.innerHTML = parts.join('');
}

/* ---------------- 渲染：参数表 ---------------- */
function renderParams() {
  const rows = MODES.map(m => {
    const on = available(m, state.d);
    const w = wasteKm(m);
    return `<tr class="${on ? '' : 'dim'}">
      <td><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${m.color};margin-right:6px"></span>${esc(m.name)}</td>
      <td class="n">${m.S} min</td>
      <td class="n">${m.V == null ? '28 / 85' : m.V} km/h</td>
      <td class="n">${m.k.toFixed(2)}</td>
      <td class="n">${w > 0 ? fmtKm(w) + ' km' : '0'}</td>
      <td>${esc(m.note)}</td></tr>`;
  }).join('');
  const box = $('params');
  if (box) box.innerHTML =
    `<thead><tr><th>方式</th><th class="n">起步税 S</th><th class="n">在途速度 V</th><th class="n">绕行 k</th><th class="n">白走</th><th>起步税花在哪</th></tr></thead><tbody>${rows}</tbody>`;
}

/* ---------------- 地图 ---------------- */
function ensureMap() {
  if (map) return map;
  if (typeof TMap === 'undefined') { showError('地图 SDK 未加载（网络或 key 问题），数字与图表仍可正常使用。'); return null; }
  try {
    const c = CITY_BY_NAME[state.from] || CITIES[0];
    map = new TMap.Map($('map'), {
      center: new TMap.LatLng(c.lat, c.lng), zoom: 9, pitch: 0, baseMap: { type: 'vector' },
    });
    mkStart = new TMap.MultiMarker({ map, styles: { s: new TMap.MarkerStyle({ width: 26, height: 26, src: ICON_START, anchor: { x: 13, y: 13 } }) }, geometries: [] });
    mkEnd = new TMap.MultiMarker({ map, styles: { e: new TMap.MarkerStyle({ width: 26, height: 26, src: ICON_END, anchor: { x: 13, y: 24 } }) }, geometries: [] });
    mlLine = new TMap.MultiPolyline({ map, styles: { l: new TMap.PolylineStyle({ color: rgba('#1e2430', .78), width: 3, borderWidth: 0, lineCap: 'round' }) }, geometries: [] });
    mcBands = new TMap.MultiCircle({ map, styles: {}, geometries: [] });
    mcWaste = new TMap.MultiCircle({ map, styles: {}, geometries: [] });
    mapReady = true;
    lastFit = 0;                                  // 节流清零：地图刚建好，必须强制对一次视野
    map.on('click', ev => {
      if (!ev || !ev.latLng) return;
      state.custom = { lat: ev.latLng.getLat(), lng: ev.latLng.getLng() }; state.view = 'route';
      const a = CITY_BY_NAME[state.from] || CITIES[0];
      state.bearing = bearing(a.lat, a.lng, state.custom.lat, state.custom.lng);
      state.d = clamp(haversine(a.lat, a.lng, state.custom.lat, state.custom.lng), 0.1, 5000);
      state.preset = null;
      $('sel-to').value = '__pick';
      renderAll(); fitNow(true);
      toast(`终点已设为地图上这点，距离 ${fmtKm(state.d)} km`);
    });
    return map;
  } catch (e) {
    showError('地图初始化失败：' + (e && e.message ? e.message : String(e)));
    console.error(e);
    return null;
  }
}

/** 节流：先判前置条件，再写时间戳（否则早退会污染节流状态） */
function fitNow(force) {
  const now = Date.now();
  if (!map || !mapReady) return;                  // 先判条件，不写时间戳
  if (!force && now - lastFit < 320) return;
  lastFit = now;
  try { drawMap(); fitCurrent(); } catch (e) { showError('绘制失败：' + (e && e.message ? e.message : String(e))); console.error(e); }
}

/** 视野：默认框住两地；切到「白走圈」时框住以起点为圆心、白走距离为半径的圆 */
function fitCurrent() {
  if (!map || !mapReady) return;
  const a = CITY_BY_NAME[state.from] || CITIES[0];
  if (state.view === 'waste') {
    const sel = MODE_BY_ID[state.selMode] || MODE_BY_ID['taxi'];
    const g = safeRadiusKm(a.lat, wasteKm(sel));
    if (g.r > 0) {
      fitView([
        { lat: a.lat, lng: a.lng },
        destPoint(a.lat, a.lng, 0, g.r), destPoint(a.lat, a.lng, 90, g.r),
        destPoint(a.lat, a.lng, 180, g.r), destPoint(a.lat, a.lng, 270, g.r),
      ], 0.07);
      return;
    }
  }
  const t = currentTarget();
  fitView([{ lat: a.lat, lng: a.lng }, { lat: t.lat, lng: t.lng }]);
}

function drawMap() {
  if (!map || !mapReady) return;
  const a = CITY_BY_NAME[state.from] || CITIES[0];
  const t = currentTarget();
  const c = compare(state.d);
  const sel = MODE_BY_ID[state.selMode || (c.best && c.best.id) || 'taxi'];

  mkStart.setGeometries([{ id: 'start', styleId: 's', position: new TMap.LatLng(a.lat, a.lng) }]);
  mkEnd.setGeometries([{ id: 'end', styleId: 'e', position: new TMap.LatLng(t.lat, t.lng) }]);
  mlLine.setGeometries([{
    id: 'line', styleId: 'l',
    paths: [new TMap.LatLng(a.lat, a.lng), new TMap.LatLng(t.lat, t.lng)],
  }]);

  /* 相带环：以起点为圆心，半径 = 各临界距离 */
  const z = map.getZoom();
  const mpp = metersPerPixel(a.lat, z);
  const styles = {}, geos = [];
  BANDS.forEach((b, i) => {
    if (!isFinite(b.to)) return;
    const px = (b.to * 1000) / mpp;
    if (px < 3) return;                            // 不足 3 px 不画，否则只是一坨色块
    const id = 'b' + i;
    styles[id] = new TMap.CircleStyle({ color: rgba(b.color, .72), fillColor: rgba(b.color, .10), width: 1.4, showBorder: true });
    geos.push({ id, styleId: id, center: new TMap.LatLng(a.lat, a.lng), radius: b.to * 1000 });
  });
  try { mcBands.setStyles(styles); mcBands.setGeometries(geos); }
  catch (e) { showError('相带环绘制失败（半径超出地图能力）：' + (e && e.message ? e.message : String(e))); console.error(e); }

  /* 白走圈：起步税这段时间本来能走多远 */
  const wr = wasteKm(sel);
  let note = `${sel.name}：起步税 ${sel.S} 分钟，这段时间够走 ${fmtKm(wr)} 公里`;
  let drewWaste = false;
  if (wr > 0) {
    const g = safeRadiusKm(a.lat, wr);
    const px = (g.r * 1000) / mpp;
    if (px >= 3) {
      try {
        mcWaste.setStyles({ w: new TMap.CircleStyle({ color: rgba(sel.color, .92), fillColor: rgba(sel.color, .14), width: 2.4, showBorder: true }) });
        mcWaste.setGeometries([{ id: 'w', styleId: 'w', center: new TMap.LatLng(a.lat, a.lng), radius: g.r * 1000 }]);
        drewWaste = true;
      } catch (e) {
        showError('白走圈绘制失败：' + (e && e.message ? e.message : String(e))); console.error(e);
      }
    }
    if (g.capped) note += `（实际 ${fmtKm(wr)} km 超出该纬度可画上限 ${fmtKm(g.cap)} km，已按上限绘制）`;
    else if (px < 3) mcWaste.setGeometries([]);   // 不画就清空，否则会残留上一种方式的圈，误导读者
  } else {
    mcWaste.setGeometries([]);
    note += '（步行的起步税是 0，没有白走的距离）';
  }
  if (wr > 0 && !drewWaste && !$('maperr').style.display.match(/block/)) {
    note += '（当前视野下该圈太小，放大后可见）';
  }

  const mn = $('mapnote');
  if (mn) mn.innerHTML = `实线 = 起点到终点的直线。${esc(note)}；${BANDS.filter(b => isFinite(b.to)).length} 圈彩色细圆 = 相邻方式之间的临界距离（小于 3 像素的已自动隐藏）。`;
}

/* ---------------- 总渲染 ---------------- */
function renderAll() {
  const c = compare(state.d);
  if (!state.selMode && c.best) state.selMode = c.best.id;

  $('d-km').textContent = fmtKm(state.d) + ' km';
  const cur = currentTarget();
  const noteEl = $('d-note');
  if (noteEl) {
    if (state.custom) noteEl.textContent = `（终点：地图上选的点）`;
    else if (Math.abs(haversine(CITY_BY_NAME[state.from].lat, CITY_BY_NAME[state.from].lng,
      CITY_BY_NAME[state.toCity].lat, CITY_BY_NAME[state.toCity].lng) - state.d) < 0.5) {
      noteEl.textContent = `（${state.from} → ${state.toCity} 实际直线距离）`;
    } else noteEl.textContent = `（${state.from} 出发，沿 ${state.bearing.toFixed(0)}° 方向 ${fmtKm(state.d)} km）`;
  }
  const sl = $('slider'); if (sl && Math.abs(Math.log10(state.d) * 1000 - Number(sl.value)) > 1) {
    sl.value = String(Math.round(Math.log10(clamp(state.d, 0.1, 5000)) * 1000));
  }
  for (const b of document.querySelectorAll('.preset')) b.classList.toggle('on', b.dataset.name === state.preset);
  for (const b of document.querySelectorAll('.vbtn')) b.classList.toggle('on', b.dataset.view === state.view);

  renderStats(c);
  renderRank(c);
  renderChart(state.d, c);
  renderBands();
  renderParams();
  window.__st_rendered = (window.__st_rendered || 0) + 1;
  window.__st_last = { d: state.d, best: c.best && c.best.id, sel: state.selMode, target: cur };
}

/* ---------------- 初始化 ---------------- */
function buildControls() {
  const pf = $('sel-from'), pt = $('sel-to');
  pf.innerHTML = CITIES.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  pt.innerHTML = CITIES.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('') +
    `<option value="__pick">地图上选点…</option>`;
  pf.value = state.from; pt.value = state.toCity;

  pf.addEventListener('change', () => {
    state.from = pf.value; state.preset = null; state.view = 'route';
    const a = CITY_BY_NAME[state.from];
    if (state.custom) {
      state.bearing = bearing(a.lat, a.lng, state.custom.lat, state.custom.lng);
      state.d = clamp(haversine(a.lat, a.lng, state.custom.lat, state.custom.lng), 0.1, 5000);
    } else {
      const b = CITY_BY_NAME[state.toCity];
      state.bearing = bearing(a.lat, a.lng, b.lat, b.lng);
      state.d = clamp(haversine(a.lat, a.lng, b.lat, b.lng), 0.1, 5000);
    }
    state.selMode = null; renderAll(); fitNow(true);
  });
  pt.addEventListener('change', () => {
    state.preset = null; state.view = 'route';
    if (pt.value === '__pick') { if (!state.custom) toast('在地图上点一下即可设为终点'); return; }
    state.custom = null; state.toCity = pt.value;
    const a = CITY_BY_NAME[state.from], b = CITY_BY_NAME[state.toCity];
    state.bearing = bearing(a.lat, a.lng, b.lat, b.lng);
    state.d = clamp(haversine(a.lat, a.lng, b.lat, b.lng), 0.1, 5000);
    state.selMode = null; renderAll(); fitNow(true);
  });

  const box = $('presets');
  box.innerHTML = '';
  PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.className = 'preset'; b.textContent = p.name; b.dataset.name = p.name;
    b.addEventListener('click', () => {
      state.preset = p.name; state.custom = null; state.selMode = null; state.view = 'route';
      if (p.d != null) {
        state.from = p.from; state.d = p.d;
      } else {
        state.from = p.from; state.toCity = p.to;
        const a = CITY_BY_NAME[p.from], c2 = CITY_BY_NAME[p.to];
        state.bearing = bearing(a.lat, a.lng, c2.lat, c2.lng);
        state.d = clamp(haversine(a.lat, a.lng, c2.lat, c2.lng), 0.1, 5000);
      }
      pf.value = state.from; pt.value = state.custom ? '__pick' : state.toCity;
      renderAll(); fitNow(true);
    });
    box.appendChild(b);
  });

  for (const b of document.querySelectorAll('.vbtn')) {
    b.addEventListener('click', () => { state.view = b.dataset.view; renderAll(); fitNow(true); });
  }

  const sl = $('slider');
  sl.addEventListener('input', () => {
    state.d = clamp(Math.pow(10, Number(sl.value) / 1000), 0.1, 5000);
    state.preset = null; state.view = 'route'; renderAll(); fitNow(false);
  });
}

function boot() {
  try {
    buildControls();
    ensureMap();
    renderAll();
    fitNow(true);
    window.__st_boot_ok = true;
  } catch (e) {
    showError('初始化失败：' + (e && e.message ? e.message : String(e)));
    console.error(e);
    window.__st_boot_ok = false;
  }
}

/* 入口必须自启动（本项目硬纪律：只挂不调会让断言全绿而页面空白） */
function autostart() { boot(); }
if (typeof document !== 'undefined') {
  if (document.readyState === 'complete' || document.readyState === 'interactive') autostart();
  else window.addEventListener('DOMContentLoaded', autostart);
  window.addEventListener('load', () => { fitNow(true); });
}
window.__st_boot = boot;
window.__st_state = state;
/* 暴露给断言脚本：真实场景里最大白走半径只有 2476 km，永远触发不到钳制，
   不单独喂超限输入就等于没测（正是「指标失效」的那种假绿） */
window.__st_safeRadius = safeRadiusKm;
window.__st_fitView = pts => fitView(pts);
