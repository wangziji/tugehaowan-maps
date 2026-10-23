/* =====================================================================
 * 人生质心 · LIFE CENTROID —— 界面与地图
 *
 * 纪律（历次踩坑）：
 *  1. 入口必须自启动（祖先洪流把 boot 挂在 window 上却忘了调用，35 条断言全绿但页面空白）
 *  2. catch 里不许只 console.warn —— 静默失败会把 bug 藏起来，必须留下用户可见痕迹
 *  3. marker 图标一律内联 SVG data URI（腾讯官方示例外链图已 404，会让 A/B 标记退化成同一个）
 *  4. 地图半径按纬度钳制（MultiCircle 大半径会抛 LatLng 越界），超限降级 + 提示
 * ===================================================================== */
import {
  num, haversine, bearing, bearingName, centroid, rmsRadius, effectiveCount,
  dominance, weightsFor, hMax, futureShift, hoursForDistance, yearsToMove,
  compute, PRESETS, HOURS_PER_WEEK, EARTH_R
} from './model.js';

const TMAP_KEY = 'CVIBZ-RDZCD-J3B4T-HGLIP-V7Z2F-EQB5N';
const C1 = '#5b4b8a', C2 = '#b4552e', C3 = '#2f7d6e';

/* ---------------- 内联 SVG 图标（外链 markerDefault.png 已 404） ---------------- */
const svg = (body, w, h) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
const ICON_ANCHOR = svg(`<circle cx="12" cy="12" r="9" fill="${C1}" stroke="#fff" stroke-width="3"/>`, 24, 24);
const ICON_HOME = svg(`<circle cx="12" cy="12" r="9" fill="${C1}" stroke="#fff" stroke-width="3"/><circle cx="12" cy="12" r="3.5" fill="#fff"/>`, 24, 24);
const ICON_CAND = svg(`<path d="M12 2 L22 21 L12 16 L2 21 Z" fill="${C2}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`, 24, 24);
const ICON_CENTROID = svg(
  `<circle cx="14" cy="14" r="11" fill="rgba(180,85,46,.18)"/>
   <circle cx="14" cy="14" r="7" fill="${C2}" stroke="#fff" stroke-width="3"/>
   <circle cx="14" cy="14" r="2.6" fill="#fff"/>`, 28, 28);
const ICON_FUTURE = svg(
  `<circle cx="14" cy="14" r="9" fill="none" stroke="${C3}" stroke-width="3" stroke-dasharray="3 2"/>
   <circle cx="14" cy="14" r="3" fill="${C3}"/>`, 28, 28);

/* ---------------- 状态 ---------------- */
let uid = 0;
const state = {
  anchors: [],
  homeIdx: 0,
  cand: null,
  mode: 'replace',
  h: 20, Yp: 10, Yf: 10, targetPct: 30,
  clickMode: 'anchor',
  preset: null
};

let map = null, mapReady = false;
let mkAnchors = null, mkSpecial = null, mcWeight = null, mlSpokes = null, mlShift = null;
let lastFit = 0;
let lastGeo = null;          // 上一次逆解析的质心，避免每帧打接口
let geoTimer = null;

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function fmtKm(v) {
  if (!isFinite(v)) return '∞';
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + ' 万';
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
function fmtNum(v, d = 1) { return isFinite(v) ? v.toFixed(d) : '∞'; }

/* ---------------- 地图 ---------------- */
function initMap() {
  if (typeof TMap === 'undefined') return false;
  try {
    map = new TMap.Map($('map'), {
      center: new TMap.LatLng(34.5, 112),
      zoom: 4.2,
      pitch: 0,
      showControl: true
    });
    mapReady = true;
    map.on('click', onMapClick);
    return true;
  } catch (e) {
    showMapErr('地图初始化失败：' + (e && e.message ? e.message : e));
    return false;
  }
}

/** 纬度越高，MultiCircle 能画的最大半径越小（球面采样会越出 ±180） */
function safeRadiusKm(lat, wantKm) {
  const cap = (83 - Math.abs(lat)) * 0.90 * 111.19;
  return Math.min(wantKm, cap);
}

function drawMap(res) {
  if (!mapReady) return;
  try {
    // 清掉上一轮
    for (const o of [mkAnchors, mkSpecial, mcWeight, mlSpokes, mlShift]) {
      try { if (o) o.setMap(null); } catch (e) { }
    }
    const A = state.anchors;
    if (!A.length) { return; }

    // 1) 权重气泡：只在「看得清地理尺度」的视野里画。
    //    全国视野下 10 km 的圆还不到 1 像素，画出来只是一坨色块，反而盖住标注 —— 干脆不画。
    const maxW = Math.max(1e-6, ...A.map(a => num(a.w, 0, HOURS_PER_WEEK, 0)));
    let laMin = 90, laMax = -90, loMin = 180, loMax = -180;
    for (const a of A) {
      laMin = Math.min(laMin, a.lat); laMax = Math.max(laMax, a.lat);
      loMin = Math.min(loMin, a.lon); loMax = Math.max(loMax, a.lon);
    }
    const spanDeg = Math.max(laMax - laMin, loMax - loMin);
    if (spanDeg < 4) {
      const circles = [];
      for (const a of A) {
        const w = num(a.w, 0, HOURS_PER_WEEK, 0);
        if (w <= 0) continue;
        const want = 3 + 22 * Math.sqrt(w / maxW);          // 3~25 km
        circles.push({
          styleId: 'w',
          center: new TMap.LatLng(a.lat, a.lon),
          radius: safeRadiusKm(a.lat, want) * 1000
        });
      }
      if (circles.length) {
        mcWeight = new TMap.MultiCircle({
          map, styles: {
            w: new TMap.CircleStyle({
              color: 'rgba(91,75,138,0.14)',
              showBorder: true, borderColor: 'rgba(91,75,138,0.5)', borderWidth: 1
            })
          }, geometries: circles
        });
      }
    }

    // 2) 锚点 marker：大小按权重分三档（大中小），否则全国视野下所有点一样大，看不出谁在拽你
    const sizeFor = w => (w / maxW >= 0.6 ? 34 : w / maxW >= 0.22 ? 27 : 21);
    const gs = A.map((a, i) => {
      const w = num(a.w, 0, HOURS_PER_WEEK, 0);
      const sz = sizeFor(w);
      return {
        id: 'a' + i,
        styleId: (i === state.homeIdx ? 'h' : 'a') + sz,
        position: new TMap.LatLng(a.lat, a.lon),
        rank: 100 + i
      };
    });
    const mstyles = {};
    for (const sz of [21, 27, 34]) {
      mstyles['a' + sz] = new TMap.MarkerStyle({ width: sz, height: sz, src: ICON_ANCHOR, anchor: { x: sz / 2, y: sz / 2 } });
      mstyles['h' + sz] = new TMap.MarkerStyle({ width: sz, height: sz, src: ICON_HOME, anchor: { x: sz / 2, y: sz / 2 } });
    }
    mkAnchors = new TMap.MultiMarker({ map, styles: mstyles, geometries: gs });

    // 3) 候选地 + 现状质心 + 未来质心
    const special = [];
    if (state.cand) {
      special.push({
        id: 'cand', styleId: 'cand', rank: 300,
        position: new TMap.LatLng(state.cand.lat, state.cand.lon)
      });
    }
    if (res && res.ok) {
      special.push({
        id: 'centroid', styleId: 'centroid', rank: 400,
        position: new TMap.LatLng(res.lat, res.lon)
      });
      if (res.fut && res.fut.ok && res.fut.dist > 0.5) {
        special.push({
          id: 'future', styleId: 'future', rank: 350,
          position: new TMap.LatLng(res.fut.lat, res.fut.lon)
        });
      }
    }
    if (special.length) {
      mkSpecial = new TMap.MultiMarker({
        map,
        styles: {
          cand: new TMap.MarkerStyle({ width: 24, height: 24, src: ICON_CAND, anchor: { x: 12, y: 21 } }),
          centroid: new TMap.MarkerStyle({ width: 28, height: 28, src: ICON_CENTROID, anchor: { x: 14, y: 14 } }),
          future: new TMap.MarkerStyle({ width: 28, height: 28, src: ICON_FUTURE, anchor: { x: 14, y: 14 } })
        },
        geometries: special
      });
    }

    // 4)  spokes：每个地点 → 质心
    if (res && res.ok) {
      const paths = A.map(a => [new TMap.LatLng(a.lat, a.lon), new TMap.LatLng(res.lat, res.lon)]);
      mlSpokes = new TMap.MultiPolyline({
        map,
        styles: {
          s: new TMap.PolylineStyle({
            color: 'rgba(91,75,138,0.55)', width: 2, borderWidth: 0,
            lineCap: 'round', eraseColor: 'rgba(0,0,0,0)'
          })
        },
        geometries: paths.map(p => ({ styleId: 's', paths: p }))
      });
      // 5) 位移箭头
      if (res.fut && res.fut.ok && res.fut.dist > 0.5) {
        mlShift = new TMap.MultiPolyline({
          map,
          styles: {
            sh: new TMap.PolylineStyle({
              color: C2, width: 5, borderWidth: 1, borderColor: '#fff',
              lineCap: 'round', showArrow: true,
              arrowOptions: { width: 6, height: 8, space: 60 }
            })
          },
          geometries: [{
            styleId: 'sh',
            paths: [new TMap.LatLng(res.lat, res.lon), new TMap.LatLng(res.fut.lat, res.fut.lon)]
          }]
        });
      }
    }
  } catch (e) {
    // 静默失败会少画东西 —— 必须留下可见痕迹
    showMapErr('画图层时出错：' + (e && e.message ? e.message : e) + '（计算不受影响，左侧数字仍然作数）');
  }
}

/* =====================================================================
 * 视野：自己算 zoom，不用 map.fitBounds
 *
 * 坑（2026-10-17 实测）：这个版本的 TMap GL 里 fitBounds 是**半残**的 ——
 * 它只把中心挪到 bounds 中心，zoom 一动不动（4.19 进、4.19 出），
 * 也不抛错。表现就是：数据全在北京/长沙，地图却停在全中国，标注挤成两个像素。
 * 旧作品里 fitBounds 看起来"能用"，是因为那些作品的点位本来就跨省甚至跨洲，
 * 初始 zoom 恰好接近目标；一旦点集变紧凑，这个 bug 就会静默露出来。
 * 所以这里改成按容器像素尺寸自己解 Web Mercator 的 zoom，再 setCenter + setZoom。
 * ===================================================================== */
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + num(lat, -85, 85, 0) * Math.PI / 360));
const mercYInv = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;

function fitMap(res) {
  if (!mapReady || !state.anchors.length) return;
  try {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    const eat = (lat, lon) => {
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    };
    for (const a of state.anchors) eat(a.lat, a.lon);
    if (res && res.ok) eat(res.lat, res.lon);
    if (state.cand) eat(state.cand.lat, state.cand.lon);
    if (res && res.fut && res.fut.ok) eat(res.fut.lat, res.fut.lon);

    // 单点 / 极小范围时给一个最小跨度，避免 zoom 冲到 20
    const MIN_SPAN = 0.35;   // 度
    if (maxLat - minLat < MIN_SPAN) { const c = (maxLat + minLat) / 2; minLat = c - MIN_SPAN / 2; maxLat = c + MIN_SPAN / 2; }
    if (maxLon - minLon < MIN_SPAN) { const c = (maxLon + minLon) / 2; minLon = c - MIN_SPAN / 2; maxLon = c + MIN_SPAN / 2; }

    const el = $('map');
    const W = Math.max(120, el.clientWidth || 600) - 2 * 56;
    const H = Math.max(120, el.clientHeight || 480) - 2 * 56;

    // zoom=0 时整个世界是 256 px
    const dx0 = Math.abs(maxLon - minLon) / 360 * 256;
    const dy0 = Math.abs(mercY(maxLat) - mercY(minLat)) / (2 * Math.PI) * 256;
    const z = Math.min(
      dx0 > 0 ? Math.log2(W / dx0) : 16,
      dy0 > 0 ? Math.log2(H / dy0) : 16
    );
    const zc = Math.max(3, Math.min(16, isFinite(z) ? z : 6));

    const latc = mercYInv((mercY(maxLat) + mercY(minLat)) / 2);
    const lonc = (maxLon + minLon) / 2;
    map.setCenter(new TMap.LatLng(latc, lonc));
    map.setZoom(zc);
  } catch (e) {
    showMapErr('视野调整失败：' + (e && e.message ? e.message : e) + '（图面可能不在最佳视野，数字不受影响）');
  }
}

function showMapErr(msg) {
  const box = $('mapErr');
  if (!box) return;
  box.style.display = 'block';
  box.textContent = msg;
}
function clearMapErr() { const b = $('mapErr'); if (b) { b.style.display = 'none'; b.textContent = ''; } }

function onMapClick(evt) {
  const lat = evt.latLng.getLat(), lon = evt.latLng.getLng();
  if (state.clickMode === 'cand') {
    setCand(lat, lon, '地图上选的点');
  } else {
    addAnchor(lat, lon, '位置 ' + (state.anchors.length + 1), 10);
  }
}

/* ---------------- 地点列表 ---------------- */
function addAnchor(lat, lon, name, w) {
  state.anchors.push({ id: ++uid, lat, lon, name: name || ('位置 ' + (state.anchors.length + 1)), w: num(w, 0, HOURS_PER_WEEK, 10) });
  state.preset = null;
  renderAnchors(); refresh(true);
}
function removeAnchor(id) {
  const i = state.anchors.findIndex(a => a.id === id);
  if (i < 0) return;
  state.anchors.splice(i, 1);
  if (state.homeIdx >= state.anchors.length) state.homeIdx = Math.max(0, state.anchors.length - 1);
  state.preset = null;
  renderAnchors(); refresh(true);
}
function setCand(lat, lon, name) {
  state.cand = { lat, lon, name: name || '候选落脚点' };
  $('candName').textContent = state.cand.name;
  refresh(true);
}
function clearCand() {
  state.cand = null;
  $('candName').textContent = '未设置';
  refresh();
}

function renderAnchors() {
  const box = $('anchorList');
  box.innerHTML = '';
  state.anchors.forEach((a, i) => {
    const d = document.createElement('div');
    d.className = 'anchor' + (i === state.homeIdx ? ' home' : '');
    d.innerHTML = '<div class="ln">'
      + '<input type="text" value="' + esc(a.name) + '" data-id="' + a.id + '" class="nm">'
      + '<input type="number" class="h" min="0" max="168" step="0.5" value="' + a.w + '" data-id="' + a.id + '">'
      + '<button class="del" data-id="' + a.id + '" title="删掉">×</button>'
      + '</div><div class="meta">' + a.lat.toFixed(4) + ', ' + a.lon.toFixed(4)
      + ' · 每周 ' + a.w + ' 小时' + (i === state.homeIdx ? ' · 我以为的家' : '') + '</div>';
    box.appendChild(d);
  });
  if (!state.anchors.length) {
    box.innerHTML = '<div class="note">还没有地点。在地图上点一下，或者用上面的搜索框。</div>';
  }
  box.querySelectorAll('input.nm').forEach(el => {
    el.addEventListener('change', () => {
      const a = state.anchors.find(x => x.id === +el.dataset.id); if (a) a.name = el.value;
      renderAnchors(); refresh();
    });
  });
  box.querySelectorAll('input.h').forEach(el => {
    el.addEventListener('input', () => {
      const a = state.anchors.find(x => x.id === +el.dataset.id);
      if (a) a.w = num(el.value, 0, HOURS_PER_WEEK, 0);
      state.preset = null; refresh();
    });
  });
  box.querySelectorAll('button.del').forEach(el => {
    el.addEventListener('click', () => removeAnchor(+el.dataset.id));
  });

  const hs = $('homeSel');
  hs.innerHTML = '';
  state.anchors.forEach((a, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = a.name; hs.appendChild(o);
  });
  if (state.anchors.length) hs.value = String(Math.min(state.homeIdx, state.anchors.length - 1));
}

/* ---------------- 主刷新 ---------------- */
function refresh(fit) {
  const res = compute(state);
  render(res);
  drawMap(res);
  askAddress(res);
  if (fit) { const t = Date.now(); if (t - lastFit > 350) { lastFit = t; fitMap(res); } }
}

function render(res) {
  const A = state.anchors;

  if (!A.length) {
    $('vAddr').textContent = '还没算';
    $('vAddrNote').textContent = '先在地图上点一个你每周待的地方。';
    ['vHome', 'vRms', 'vShift', 'vFloor', 'vHours'].forEach(k => $(k).textContent = '–');
    ['vHomeNote', 'vRmsNote', 'vShiftNote', 'vFloorNote', 'vHoursNote'].forEach(k => $(k).textContent = '–');
    $('wBars').innerHTML = '<div class="note">没有数据。</div>';
    $('wNote').textContent = '';
    $('tbBody').innerHTML = '';
    return;
  }

  if (!res.ok) {
    $('vAddr').textContent = '重心不存在';
    $('vAddrNote').textContent = res.reason === 'degenerate'
      ? '你的时间在地表的两侧完全对冲（比如两处对跖、等时长），加权向量和为零，这个位置上没有唯一的重心。把任一处的时长改一改就有了。'
      : '所有地点的时长都是 0，先给至少一个地方填上每周小时数。';
    ['vHome', 'vRms', 'vShift', 'vFloor', 'vHours'].forEach(k => $(k).textContent = '–');
    ['vHomeNote', 'vRmsNote', 'vShiftNote', 'vFloorNote', 'vHoursNote'].forEach(k => $(k).textContent = '–');
    $('wBars').innerHTML = '';
    $('tbBody').innerHTML = '';
    showMapErr('当前参数下重心不存在（' + res.reason + '），地图上的重心标记已省略。');
    return;
  }
  clearMapErr();

  /* --- 重心 --- */
  $('vAddr').textContent = lastGeo && lastGeo.addr ? lastGeo.addr
    : (res.lat.toFixed(3) + '°N, ' + res.lon.toFixed(3) + '°E');
  const near = nearestAnchor(res);
  $('vAddrNote').textContent = '坐标 ' + res.lat.toFixed(4) + '°, ' + res.lon.toFixed(4) + '°'
    + ' · 离你最近的一个落脚点「' + esc(near.name) + '」还有 ' + fmtKm(near.d) + ' km';

  /* --- 离家的距离 --- */
  $('vHome').textContent = fmtKm(res.homeDist);
  $('vHomeNote').textContent = '你以为的家在重心的' + bearingName(res.homeBearing)
    + '方向；方位角 ' + res.homeBearing.toFixed(0) + '°。';

  /* --- 离散 --- */
  $('vRms').textContent = fmtKm(res.rms);
  $('vRmsNote').textContent = '均方根口径。你的时间实际只押在 '
    + res.nEff.toFixed(1) + ' 个地方上（共 ' + res.n + ' 个），最大的那处占 '
    + (res.dom * 100).toFixed(0) + '%。';

  /* --- 位移 --- */
  if (res.fut && res.fut.ok) {
    $('vShift').textContent = fmtKm(res.fut.dist);
    $('vShiftNote').textContent = res.fut.dist < 0.5
      ? '往后 ' + res.Yf + ' 年，重心几乎没动。'
      : '往后 ' + res.Yf + ' 年，往' + bearingName(res.fut.bearing) + '方向飘 '
      + fmtKm(res.fut.dist) + ' km（方位角 ' + res.fut.bearing.toFixed(0) + '°）。';
  } else {
    $('vShift').textContent = '–'; $('vShiftNote').textContent = '还没设候选落脚点。';
  }

  /* --- 反解 --- */
  if (state.cand) {
    // 下限：把每周额度用满之后，重心最远也只能靠到这儿
    $('vFloor').textContent = fmtKm(res.bestDist);
    $('vFloorNote').textContent = '把每周可挪的 ' + fmtNum(hMax(A, res.mode), 0) + ' 小时全搬过去，'
      + '重心最近也只能到「' + esc(state.cand.name) + '」' + fmtKm(res.bestDist) + ' km 外 —— '
      + '因为过去 ' + res.Yp + ' 年已经占了总权重的 ' + ((1 - res.share) * 100).toFixed(0) + '%，搬不动。';

    // 拉近 pct% 需要每周多少小时
    $('vHoursLab').textContent = '拉近 ' + res.targetPct + '% · 每周要花';
    const hn = res.hoursNeeded;
    $('vHours').textContent = hn === Infinity ? '∞' : fmtNum(hn, 0);
    $('vHoursNote').textContent = hn === Infinity
      ? '连把距离砍掉 ' + res.targetPct + '% 都做不到：目标是 ' + fmtKm(res.targetKm)
      + ' km，而下限是 ' + fmtKm(res.bestDist) + ' km。把「往后算」拉长，或把目标比例调小。'
      : hn <= 0.5 ? '重心本来就在那儿附近了。'
        : '把重心到「' + esc(state.cand.name) + '」的距离从 ' + fmtKm(res.startDist) + ' km 拉到 '
        + fmtKm(res.targetKm) + ' km，每周得在那儿花 ' + fmtNum(hn, 0) + ' 小时。'
        + (isFinite(res.yearsNeeded) && res.yearsNeeded > 0.01
          ? '（若每周固定 ' + res.h + ' 小时，则要 ' + fmtNum(res.yearsNeeded, 1) + ' 年。）' : '');
  } else {
    $('vFloor').textContent = '–'; $('vFloorNote').textContent = '还没设候选落脚点。';
    $('vHours').textContent = '–'; $('vHoursNote').textContent = '还没设候选落脚点。';
  }

  /* --- 权重条 --- */
  const rows = A.map(a => ({ name: a.name, w: a.w, cand: false }));
  if (state.cand) {
    const eff = (state.mode === 'replace' ? Math.min(res.h, hMax(A, 'replace')) : res.h) * (res.Yf / Math.max(1e-9, res.Yp + res.Yf));
    rows.push({ name: '→ ' + state.cand.name, w: eff, cand: true });
  }
  const mx = Math.max(1e-6, ...rows.map(r => r.w));
  $('wBars').innerHTML = rows.map(r =>
    '<div class="wrow' + (r.cand ? ' cand' : '') + '">'
    + '<span class="nm" title="' + esc(r.name) + '">' + esc(r.name) + '</span>'
    + '<span class="bar" style="width:' + Math.max(1.5, 100 * r.w / mx * 0.62) + '%"></span>'
    + '<span class="vv">' + fmtNum(r.w, 1) + ' h/周</span></div>').join('');
  const tot = A.reduce((s, a) => s + a.w, 0);
  $('wNote').textContent = '你现在每周一共 ' + fmtNum(tot, 0) + ' 小时，占一周 168 小时的 '
    + (tot / HOURS_PER_WEEK * 100).toFixed(0) + '%。'
    + (state.mode === 'replace'
      ? '「挪过去」口径下每周最多只能挪 ' + fmtNum(hMax(A, 'replace'), 0) + ' 小时（你只有这么多小时可挪）。'
      : '「加一份」口径不受上限约束，等于凭空多花时间。');

  /* --- 对照表 --- */
  const crows = [
    ['现状质心', res.lat.toFixed(5) + '°N, ' + res.lon.toFixed(5) + '°E', '三维单位向量按每周小时数加权平均后归一化'],
    ['你以为的家', esc(A[Math.min(state.homeIdx, A.length - 1)].name), '你自己指定的基准点'],
    ['重心 ↔ 家', fmtKm(res.homeDist) + ' km / ' + bearingName(res.homeBearing), '大圆距离（Haversine）与方位角'],
    ['离散半径', fmtKm(res.rms) + ' km', '各地到质心距离的加权均方根'],
    ['有效地点数', res.nEff.toFixed(2) + ' / ' + res.n, '(Σw)² / Σw²，越大说明时间摊得越平'],
    ['主导度', (res.dom * 100).toFixed(1) + '%', '权重最大的那一处占总时长的比例'],
    ['集中度 R', res.R.toFixed(4), '|Σw·u| / Σw，1 = 全押一点，0 = 完全对冲'],
    ['每周总时长', fmtNum(tot, 0) + ' h', '你填的各地小时数之和（上限 168）']
  ];
  if (state.cand) {
    crows.push(['候选落脚点', esc(state.cand.name), '地图上选的，或搜索来的']);
    crows.push(['口径', state.mode === 'replace' ? '挪过去（守恒）' : '加一份（不守恒）', '两种口径拆成两个函数，算法不同']);
    crows.push(['未来权重占比', (res.Yf / Math.max(1e-9, res.Yp + res.Yf) * 100).toFixed(1) + '%',
      'Yf / (Yp + Yf) ＝ 未来年数在 whole 周期里的权重']);
    if (res.fut && res.fut.ok) {
      crows.push(['未来质心', res.fut.lat.toFixed(5) + '°N, ' + res.fut.lon.toFixed(5) + '°E', '把候选地按折算权重加进去再求一次']);
      crows.push(['重心位移', fmtKm(res.fut.dist) + ' km / ' + bearingName(res.fut.bearing), '两个质心之间的大圆距离']);
    }
    crows.push(['重心 ↔ 候选地（现在）', fmtKm(res.startDist) + ' km', '现状质心到候选落脚点的大圆距离']);
    crows.push(['目标距离', fmtKm(res.targetKm) + ' km', '＝ 现状距离 × (1 − ' + res.targetPct + '%)']);
    crows.push(['重心能靠到最近', fmtKm(res.bestDist) + ' km',
      '把每周额度用满后的极限；被「过去已经发生的那部分权重」钳住']);
    crows.push(['拉近 ' + res.targetPct + '% 需每周', res.hoursNeeded === Infinity ? '做不到' : fmtNum(res.hoursNeeded, 1) + ' h',
      '二分反解；够不着返回无穷，不返回负数']);
    crows.push(['固定 ' + res.h + ' h/周 需年数', res.yearsNeeded === Infinity ? '做不到' : fmtNum(res.yearsNeeded, 1) + ' 年',
      '同一个目标的另一种问法，对偶反解']);
  }
  $('tbBody').innerHTML = crows.map(r =>
    '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td><td class="note" style="color:var(--ink3)">' + r[2] + '</td></tr>').join('');

  $('modeNote').textContent = state.mode === 'replace'
    ? '从现有各地按权重比例挪出每周这么多小时给候选地，总时长守恒。'
    : '在候选地额外增加每周这么多小时，总时长变多（等于凭空多花时间）。';
  $('hNote').textContent = state.mode === 'replace'
    ? '每周最多挪 ' + fmtNum(hMax(A, 'replace'), 0) + ' 小时（你填的总时长）。'
    : '上限 168 小时/周。';
  $('tgtNote').textContent = state.cand && isFinite(res.startDist)
    ? '现在重心离「' + state.cand.name + '」' + fmtKm(res.startDist) + ' km，目标是把这段距离缩到 '
    + fmtKm(res.targetKm) + ' km。'
    : '';
}

function nearestAnchor(res) {
  let best = { name: '–', d: Infinity };
  for (const a of state.anchors) {
    const d = haversine(res, a);
    if (d < best.d) best = { name: a.name, d };
  }
  return best;
}

/* ---------------- 逆地址解析（JSONP，失败要看得见） ---------------- */
function askAddress(res) {
  if (!res || !res.ok) { lastGeo = null; return; }
  if (lastGeo && haversine(lastGeo, res) < 0.3) return;   // 没动就不打接口
  const lat = res.lat, lon = res.lon;
  if (geoTimer) clearTimeout(geoTimer);
  geoTimer = setTimeout(() => regeo(lat, lon), 450);
}

function regeo(lat, lon) {
  const cb = '__lc_rg_' + Date.now();
  const s = document.createElement('script');
  const url = 'https://apis.map.qq.com/ws/geocoder/v1/?location=' + lat + ',' + lon
    + '&key=' + TMAP_KEY + '&output=jsonp&callback=' + cb;
  let done = false;
  const cleanup = () => { try { delete window[cb]; } catch (e) { } try { s.remove(); } catch (e) { } };
  window[cb] = data => {
    done = true; cleanup();
    const r = data && data.result;
    if (!data || data.status !== 0 || !r) {
      lastGeo = { lat, lon, addr: '' };
      $('vAddr').textContent = lat.toFixed(3) + '°N, ' + lon.toFixed(3) + '°E';
      $('vAddrNote').textContent = '坐标 ' + lat.toFixed(4) + '°, ' + lon.toFixed(4)
        + '°（地名接口没返回，直接给坐标 —— 计算不受影响）';
      return;
    }
    const t = r.formatted_addresses && r.formatted_addresses.recommend
      ? r.formatted_addresses.recommend : (r.address || '');
    lastGeo = { lat, lon, addr: t };
    if ($('vAddr')) $('vAddr').textContent = t || (lat.toFixed(3) + '°N, ' + lon.toFixed(3) + '°E');
  };
  s.src = url;
  s.onerror = () => {
    if (done) return; done = true; cleanup();
    lastGeo = { lat, lon, addr: '' };
    if ($('vAddr')) $('vAddr').textContent = lat.toFixed(3) + '°N, ' + lon.toFixed(3) + '°E';
    if ($('vAddrNote')) $('vAddrNote').textContent = '坐标 ' + lat.toFixed(4) + '°, ' + lon.toFixed(4) + '°（地名接口不可用）';
  };
  setTimeout(() => { if (!done) { done = true; cleanup(); } }, 8000);
  document.head.appendChild(s);
}

/* ---------------- 地点搜索（JSONP） ---------------- */
function search(text) {
  const box = $('searchErr');
  const cb = '__lc_cb_' + Date.now();
  const s = document.createElement('script');
  const url = 'https://apis.map.qq.com/ws/geocoder/v1/?address=' + encodeURIComponent(text)
    + '&key=' + TMAP_KEY + '&output=jsonp&callback=' + cb;
  let done = false;
  const cleanup = () => { try { delete window[cb]; } catch (e) { } try { s.remove(); } catch (e) { } };
  window[cb] = data => {
    done = true; cleanup();
    if (!data || data.status !== 0 || !data.result || !data.result.location) {
      box.style.display = 'block';
      box.textContent = '没搜到「' + text + '」（' + ((data && data.message) || '接口无返回') + '）。可以直接在地图上点。';
      return;
    }
    box.style.display = 'none';
    const loc = data.result.location;
    if (state.clickMode === 'cand') { setCand(loc.lat, loc.lng, data.result.title || text); }
    else { addAnchor(loc.lat, loc.lng, data.result.title || text, 10); }
    if (mapReady) { try { map.setCenter(new TMap.LatLng(loc.lat, loc.lng)); } catch (e) { } }
  };
  s.src = url;
  s.onerror = () => {
    if (done) return; done = true; cleanup();
    box.style.display = 'block';
    box.textContent = '搜索接口不可用（网络或配额）。请直接在地图上点选——不影响计算。';
  };
  setTimeout(() => {
    if (done) return; done = true; cleanup();
    box.style.display = 'block';
    box.textContent = '搜索超时。请直接在地图上点选——不影响计算。';
  }, 8000);
  document.head.appendChild(s);
}

/* ---------------- 预设 ---------------- */
function applyPreset(name) {
  const p = PRESETS[name]; if (!p) return;
  state.anchors = p.anchors.map(a => ({ id: ++uid, name: a.name, lat: a.lat, lon: a.lon, w: a.w }));
  state.homeIdx = p.home || 0;
  state.cand = p.cand ? { lat: p.cand.lat, lon: p.cand.lon, name: p.cand.name } : null;
  state.mode = p.mode || 'replace';
  state.h = p.h; state.Yp = p.Yp; state.Yf = p.Yf; state.targetPct = p.targetPct || 30;
  state.preset = name;
  lastGeo = null;
  $('candName').textContent = state.cand ? state.cand.name : '未设置';
  $('hRange').value = state.h; $('YpRange').value = state.Yp;
  $('YfRange').value = state.Yf; $('tgtRange').value = state.targetPct;
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === state.mode));
  document.querySelectorAll('#presets .preset').forEach(b => b.classList.toggle('on', b.textContent === name));
  syncOut();
  renderAnchors();
  refresh(true);
}

function syncOut() {
  $('hOut').textContent = state.h + ' h';
  $('YpOut').textContent = state.Yp + ' 年';
  $('YfOut').textContent = state.Yf + ' 年';
  $('tgtOut').textContent = state.targetPct + '%';
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  const ps = $('presets');
  Object.keys(PRESETS).forEach(name => {
    const b = document.createElement('button');
    b.className = 'preset'; b.textContent = name;
    b.addEventListener('click', () => applyPreset(name));
    ps.appendChild(b);
  });

  $('addCenter').addEventListener('click', () => {
    let lat = 34.5, lon = 112;
    if (mapReady) { try { const c = map.getCenter(); lat = c.getLat(); lon = c.getLng(); } catch (e) { } }
    addAnchor(lat, lon, '位置 ' + (state.anchors.length + 1), 10);
  });
  $('clearAll').addEventListener('click', () => {
    state.anchors = []; state.homeIdx = 0; state.preset = null; lastGeo = null;
    renderAnchors(); refresh();
  });
  $('q').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) search(v); e.target.value = ''; }
  });
  $('homeSel').addEventListener('change', e => { state.homeIdx = +e.target.value; renderAnchors(); refresh(); });
  $('pickCand').addEventListener('click', () => {
    state.clickMode = 'cand';
    document.querySelectorAll('#clickSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === 'cand'));
    $('mapBadge').textContent = '现在点地图 = 设为候选落脚点';
  });
  $('clearCand').addEventListener('click', clearCand);
  document.querySelectorAll('#clickSeg button').forEach(b => {
    b.addEventListener('click', () => {
      state.clickMode = b.dataset.v;
      document.querySelectorAll('#clickSeg button').forEach(x => x.classList.toggle('on', x === b));
      $('mapBadge').textContent = b.dataset.v === 'cand'
        ? '现在点地图 = 设为候选落脚点' : '现在点地图 = 加一个你每周待的地方';
    });
  });
  document.querySelectorAll('#modeSeg button').forEach(b => {
    b.addEventListener('click', () => {
      state.mode = b.dataset.v;
      document.querySelectorAll('#modeSeg button').forEach(x => x.classList.toggle('on', x === b));
      syncOut(); refresh();
    });
  });
  $('hRange').addEventListener('input', e => { state.h = num(e.target.value, 0, 168, 20); syncOut(); refresh(); });
  $('YpRange').addEventListener('input', e => { state.Yp = num(e.target.value, 0, 60, 10); syncOut(); refresh(); });
  $('YfRange').addEventListener('input', e => { state.Yf = num(e.target.value, 0, 60, 10); syncOut(); refresh(); });
  $('tgtRange').addEventListener('input', e => { state.targetPct = num(e.target.value, 10, 80, 30); syncOut(); refresh(); });
}

/* ---------------- 启动（必须自启动，不许只挂不调） ---------------- */
let booted = false;
function boot() {
  if (booted) return; booted = true;
  bind();
  syncOut();
  applyPreset('北漂十年');     // 默认给一个演示场景，进来就有东西看
}

function ensureMap() {
  // 坑：boot() 里就调过 refresh(true) 了，那时地图还没建好，fitMap 直接 return 却已经把
  // lastFit 写掉了 —— 后面这次 refresh(true) 被节流吃掉，地图永远停在建图时的 zoom 4.2，
  // 全中国一张图、标注全挤成两个像素。地图就绪时必须把节流清零再对一次视野。
  if (initMap()) { lastFit = 0; refresh(true); return; }
  let n = 0;
  const t = setInterval(() => {
    n++;
    if (initMap()) { clearInterval(t); lastFit = 0; refresh(true); return; }
    if (n > 40) {
      clearInterval(t);
      showMapErr('腾讯地图脚本没加载出来（网络或 Key 问题）。页面左侧的计算与结论不依赖地图，照常可用。');
      refresh(false);
    }
  }, 250);
}

function autostart() {
  boot();
  ensureMap();
}

if (document.readyState === 'complete') autostart();
else window.addEventListener('load', autostart);

/* 冒烟脚本用：只读状态与结果，不提供「手动启动」入口 —— 启动必须由页面自己完成 */
window.__lc = {
  state,
  get result() { return compute(state); },
  refresh, render, applyPreset, addAnchor, setCand, search, regeo,
  get mapReady() { return mapReady; },
  get mapZoom() { try { return map ? map.getZoom() : null; } catch (e) { return null; } },
  get centroidObj() { return centroid(state.anchors); },
  get futureShiftRaw() { return state.cand ? futureShift(state.anchors, state.cand, state.h, state.Yp, state.Yf, state.mode) : null; }
};
