/* =====================================================================
 * 失联半径 · LOST RADIUS —— 前端接线
 *
 * 纪律提醒（前作踩过的坑，别再犯）：
 *  1. 入口必须自启动，不许只挂在 window 上给冒烟脚本按 —— ancestors 就死在这。
 *  2. catch 里不能只 console.warn，静默失败必须留用户可见痕迹。
 *  3. 腾讯地图官方示例的 marker 外链图已 404，必须内联 SVG data URI。
 *  4. 表单一律过 num() 收进合法域，防 NaN 死循环。
 * ===================================================================== */
import {
  num, isoRadius, project, convexHull, unproject,
  CITY_AREAS, compute
} from './model.js';

const $ = id => document.getElementById(id);
const TMAP_KEY = 'CVIBZ-RDZCD-J3B4T-HGLIP-V7Z2F-EQB5N';

/* ---------------- 内联 SVG 图标（外链 marker 图已 404） ---------------- */
function icon(color, glyph) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38">' +
    '<path d="M15 1C8.4 1 3 6.4 3 13c0 10.2 12 23 12 23s12-12.8 12-23c0-6.6-5.4-12-12-12z" ' +
    'fill="' + color + '" stroke="#ffffff" stroke-width="2.2"/>' +
    '<circle cx="15" cy="13" r="5.2" fill="#ffffff"/>' +
    (glyph ? '<text x="15" y="16.4" font-size="7" text-anchor="middle" fill="' + color +
      '" font-family="sans-serif" font-weight="700">' + glyph + '</text>' : '') +
    '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
const ICON_HOME = icon('#c0552e', '家');
const ICON_SPOT = icon('#1f6f5c', '');

/* ---------------- 预设场景（演示数据） ---------------- */
const PRESETS = {
  '刚来三个月': {
    city: '北京',
    anchors: [
      { name: '租的房子', lat: 39.9042, lon: 116.4074, w: 1.5 },
      { name: '公司', lat: 39.9098, lon: 116.4180, w: 1.5 },
      { name: '楼下便利店', lat: 39.9060, lon: 116.4098, w: 1.0 }
    ], baseR: 0.6
  },
  '住了五年': {
    city: '北京',
    anchors: [
      { name: '家', lat: 39.9042, lon: 116.4074, w: 1.5 },
      { name: '公司', lat: 39.9098, lon: 116.4180, w: 1.5 },
      { name: '常去的小馆', lat: 39.9062, lon: 116.4102, w: 1.0 },
      { name: '健身房', lat: 39.9078, lon: 116.4131, w: 1.0 },
      { name: '菜市场', lat: 39.9019, lon: 116.4048, w: 1.0 },
      { name: '朋友家', lat: 39.9140, lon: 116.4230, w: 0.6 },
      { name: '常去的公园', lat: 39.8995, lon: 116.3980, w: 0.6 },
      { name: '孩子学校', lat: 39.9120, lon: 116.4002, w: 0.6 }
    ], baseR: 0.7
  },
  '本地通': {
    city: '北京',
    anchors: (() => {
      const a = [];
      const names = ['家', '公司', '老丈人家', '常去菜场', '球场', '老同学店', '医院', '小学',
        '常吃面馆', '健身房', '图书馆', '公园', '商场', '车站', '朋友家', '理发店'];
      for (let i = 0; i < 16; i++) {
        a.push({
          name: names[i % names.length] + (i >= names.length ? ' ' + (Math.floor(i / names.length) + 1) : ''),
          lat: 39.86 + (i % 4) * 0.022 + (i > 7 ? 0.01 : 0),
          lon: 116.34 + Math.floor(i / 4) * 0.028,
          w: [1.5, 1.0, 0.6][i % 3]
        });
      }
      return a;
    })(), baseR: 0.9
  },
  '双城飞人': {
    city: '上海',
    anchors: [
      { name: '虹桥枢纽', lat: 31.1940, lon: 121.3220, w: 1.0 },
      { name: '公司', lat: 31.2280, lon: 121.4690, w: 1.5 },
      { name: '租的房子', lat: 31.2160, lon: 121.4360, w: 1.5 },
      { name: '常去的商场', lat: 31.2320, lon: 121.4780, w: 1.0 },
      { name: '机场', lat: 31.1430, lon: 121.8050, w: 0.6 }
    ], baseR: 0.7
  }
};

/* ---------------- 状态 ---------------- */
const state = {
  city: '北京',
  anchors: [],
  homeIdx: 0,
  baseR: 0.7,
  tCore: 0.5,
  tLost: 0.05,
  visits: 7,
  perWeek: 2
};
let uid = 0;
let map = null, markerLayer = null, circleLayer = null, lostLayer = null, hullLayer = null;
let mapReady = false;

/* ---------------- 工具 ---------------- */
function fmt(x, d = 2) {
  if (!isFinite(x)) return '∞';
  return x.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtKm2(a) {
  if (!isFinite(a)) return '∞';
  if (a >= 100) return fmt(a, 0);
  if (a >= 10) return fmt(a, 1);
  return fmt(a, 2);
}
function showErr(msg) {
  const el = $('mapErr');
  el.textContent = msg;
  el.style.display = 'block';
  // 静默失败不可接受：出错必须留可见痕迹
}
function hideErr() { $('mapErr').style.display = 'none'; }

/* ---------------- 锚点列表 ---------------- */
function renderAnchors() {
  const box = $('anchorList');
  box.innerHTML = '';
  if (!state.anchors.length) {
    box.innerHTML = '<div class="note">还没有标任何地方。在地图上点一下，或者用上面的搜索框。</div>';
    $('homeSel').innerHTML = '<option value="0">—</option>';
    return;
  }
  state.anchors.forEach((a, i) => {
    const d = document.createElement('div');
    d.className = 'anchor' + (i === state.homeIdx ? ' home' : '');
    const ln = document.createElement('div'); ln.className = 'ln';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = a.name;
    inp.addEventListener('input', () => { a.name = inp.value; });
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '×'; del.title = '删掉';
    del.addEventListener('click', () => {
      state.anchors.splice(i, 1);
      if (state.homeIdx >= state.anchors.length) state.homeIdx = Math.max(0, state.anchors.length - 1);
      renderAnchors(); update();
    });
    ln.appendChild(inp); ln.appendChild(del);
    const meta = document.createElement('div'); meta.className = 'meta';
    const sel = document.createElement('select');
    [['1.5', '闭着眼都能走'], ['1', '常去'], ['0.6', '只去过几次']].forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t;
      if (Math.abs(a.w - Number(v)) < 1e-6) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => { a.w = num(sel.value, 0.1, 5, 1); update(); });
    const sp = document.createElement('span');
    sp.textContent = (i === state.homeIdx ? '家 · ' : '') + a.lat.toFixed(4) + ', ' + a.lon.toFixed(4);
    meta.appendChild(sel); meta.appendChild(sp);
    d.appendChild(ln); d.appendChild(meta);
    box.appendChild(d);
  });

  const hs = $('homeSel'); hs.innerHTML = '';
  state.anchors.forEach((a, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = a.name || ('锚点 ' + (i + 1));
    if (i === state.homeIdx) o.selected = true;
    hs.appendChild(o);
  });
}

/* ---------------- 地图 ---------------- */
function initMap() {
  if (typeof TMap === 'undefined') { showErr('地图脚本没加载出来，请检查网络后刷新。计算部分仍然可用。'); return false; }
  const c = CITY_AREAS[state.city] || CITY_AREAS['北京'];
  map = new TMap.Map('map', {
    center: new TMap.LatLng(c.lat, c.lon),
    zoom: c.zoom,
    pitch: 0,
    baseMap: { type: 'vector' }
  });
  markerLayer = new TMap.MultiMarker({ map, styles: {}, geometries: [] });
  circleLayer = new TMap.MultiCircle({ map, styles: {}, geometries: [] });
  lostLayer = new TMap.MultiCircle({ map, styles: {}, geometries: [] });
  hullLayer = new TMap.MultiPolygon({ map, styles: {}, geometries: [] });
  map.on('click', e => {
    const lat = e.latLng.getLat(), lon = e.latLng.getLng();
    addAnchor(lat, lon, '我在这儿认识一个地方');
  });
  mapReady = true;
  hideErr();
  return true;
}

function addAnchor(lat, lon, name) {
  lat = num(lat, -90, 90, NaN); lon = num(lon, -180, 180, NaN);
  if (!isFinite(lat) || !isFinite(lon)) { showErr('坐标不合法，这个点没加上。'); return; }
  if (state.anchors.length >= 200) { showErr('最多 200 个锚点，再多浏览器会卡。'); return; }
  state.anchors.push({ id: ++uid, name: name || ('锚点 ' + (state.anchors.length + 1)), lat, lon, w: 1 });
  if (state.anchors.length === 1) state.homeIdx = 0;
  renderAnchors(); update();
}

function drawMap(res) {
  if (!mapReady || !map) return;
  try {
    const pts = res._pts || [];
    // 标记
    const styles = {}, geos = [];
    pts.forEach((p, i) => {
      const key = i === state.homeIdx ? 'home' : 'spot';
      if (!styles[key]) styles[key] = new TMap.MarkerStyle({
        width: 30, height: 38, anchor: { x: 15, y: 37 }, src: i === state.homeIdx ? ICON_HOME : ICON_SPOT
      });
      geos.push({ id: 'm' + i, styleId: key, position: new TMap.LatLng(p.lat, p.lon) });
    });
    markerLayer.setStyles(styles);
    markerLayer.setGeometries(geos);

    // 领地圆
    const cstyles = {}, cgeos = [];
    pts.forEach((p, i) => {
      const R = isoRadius(p.r, state.tCore) * 1000;
      if (!(R > 0)) return;
      const key = 'c' + (Math.round(R / 50));
      if (!cstyles[key]) cstyles[key] = new TMap.CircleStyle({
        color: 'rgba(31,111,92,0.55)', fillColor: 'rgba(31,111,92,0.16)', radius: R, showCenter: false
      });
      cgeos.push({ id: 'c' + i, styleId: key, center: new TMap.LatLng(p.lat, p.lon), radius: R });
    });
    circleLayer.setStyles(cstyles);
    circleLayer.setGeometries(cgeos);

    // 失联半径（以家为圆心、平均失联距离为半径）
    const lg = [];
    if (pts.length && res.lost && isFinite(res.lost.mean) && res.lost.mean > 0) {
      const h = pts[num(state.homeIdx, 0, pts.length - 1, 0)];
      lg.push({
        id: 'lost', styleId: 'lost',
        center: new TMap.LatLng(h.lat, h.lon), radius: res.lost.mean * 1000
      });
    }
    lostLayer.setStyles({
      lost: new TMap.CircleStyle({
        color: 'rgba(192,85,46,0.85)', fillColor: 'rgba(192,85,46,0.06)',
        radius: Math.max(1, (res.lost && res.lost.mean ? res.lost.mean : 1) * 1000), showCenter: false
      })
    });
    lostLayer.setGeometries(lg);

    // 凸包
    const hull = convexHull(pts);
    if (hull.length >= 3) {
      const path = hull.map(p => {
        const g = unproject(p.x, p.y, res.center.lat, res.center.lon);
        return new TMap.LatLng(g.lat, g.lon);
      });
      path.push(path[0]);
      hullLayer.setStyles({
        hull: new TMap.PolygonStyle({
          color: 'rgba(31,111,92,0.9)', fillColor: 'rgba(31,111,92,0.04)',
          width: 2, borderWidth: 2, showBorder: true
        })
      });
      hullLayer.setGeometries([{ id: 'hull', styleId: 'hull', paths: path }]);
    } else {
      hullLayer.setGeometries([]);
    }
  } catch (err) {
    showErr('地图画图层报错：' + (err && err.message ? err.message : err) + '。下方数字仍然有效。');
  }
}

function fitMap(res) {
  if (!mapReady || !map || !res.ok) return;
  try {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const a of state.anchors) {
      minLat = Math.min(minLat, a.lat); maxLat = Math.max(maxLat, a.lat);
      minLon = Math.min(minLon, a.lon); maxLon = Math.max(maxLon, a.lon);
    }
    const padDeg = Math.max(0.01, res.equiv / 111 * 1.6);
    map.fitBounds(new TMap.LatLngBounds(
      new TMap.LatLng(minLat - padDeg, minLon - padDeg),
      new TMap.LatLng(maxLat + padDeg, maxLon + padDeg)
    ), { padding: 60 });
  } catch (err) { /* fitBounds 失败不影响数字 */ }
}

/* ---------------- 结果渲染 ---------------- */
function render(res) {
  const city = CITY_AREAS[state.city];
  if (!res.ok) {
    $('vArea').textContent = '–'; $('vShareNote').textContent = '先在地图上标几个地方';
    $('vEquiv').textContent = '–'; $('vRefNote').textContent = '—';
    $('vLost').textContent = '–'; $('vLostNote').textContent = '—';
    $('vCopies').textContent = '–'; $('vWeeksNote').textContent = '—';
    $('logFill').style.width = '0%';
    $('blobList').innerHTML = '<div class="note">—</div>';
    $('blobNote').textContent = '';
    $('tbBody').innerHTML = '';
    return;
  }

  $('vArea').textContent = fmtKm2(res.area);
  $('vShareNote').textContent = '占' + city.area.toLocaleString('zh-CN') + ' km² 全市的 '
    + (res.share * 100).toFixed(4) + '%';
  $('vEquiv').textContent = fmt(res.equiv, 2);
  $('vRefNote').textContent = res.ref
    ? '相当于 ' + fmt(res.ref.count, 1) + ' 个' + res.ref.name
    : '—';
  $('vLost').textContent = fmt(res.lost.mean, 2);
  $('vLostNote').textContent = '从「' + (state.anchors[state.homeIdx] ? state.anchors[state.homeIdx].name : '家')
    + '」往任何方向走这么远（'
    + fmt(res.lost.min, 2) + '–' + fmt(res.lost.max, 2) + ' km），熟悉度就掉到 '
    + state.tLost.toFixed(2) + ' 以下';
  $('vCopies').textContent = fmt(res.copies, 0);
  $('vWeeksNote').textContent = '换个城市从零开始，要 ' + fmt(res.weeks, 0) + ' 周（'
    + fmt(res.weeks / 52, 1) + ' 年）才回到今天这个熟法';

  // 对数条：1e-3 → 全市
  const lo = Math.log10(0.001), hi = Math.log10(city.area);
  const v = Math.log10(Math.max(res.area, 0.001));
  const pct = Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
  $('logFill').style.width = pct.toFixed(2) + '%';
  $('lg3').textContent = '1000 km²';
  $('lg4').textContent = '全市 ' + fmt(city.area, 0) + ' km²';
  $('logNote').textContent = '你的领地落在对数刻度的 '
    + pct.toFixed(1) + '% 处。线性刻度下，你这块还不到一个像素宽。';

  // 飞地
  const bl = $('blobList'); bl.innerHTML = '';
  const maxB = res.blobSizes[0] || 1;
  res.blobSizes.forEach((s, i) => {
    const row = document.createElement('div'); row.className = 'blobrow';
    const bar = document.createElement('div'); bar.className = 'bar';
    bar.style.width = Math.max(2, s / maxB * 220) + 'px';
    bar.style.opacity = String(1 - i * 0.12);
    const nm = document.createElement('div'); nm.className = 'nm';
    nm.textContent = fmtKm2(s) + ' km²';
    row.appendChild(bar); row.appendChild(nm);
    bl.appendChild(row);
  });
  if (res.blobs === 1) {
    $('blobNote').textContent = '连成一片。你的生活是收敛的——家和公司把其余地方都串起来了。';
  } else {
    const top = res.blobSizes[0], rest = res.area - top;
    $('blobNote').textContent = '分成 ' + res.blobs + ' 块，最大的一块占 '
      + (top / res.area * 100).toFixed(0) + '%，剩下 ' + fmtKm2(rest)
      + ' km² 散在别处。飞地越多，说明你的生活被路切成了一段一段。';
  }

  // 逐条对照
  const rows = [
    ['锚点数', res.n + ' 个', '你在地图上标出来的地方'],
    ['熟悉半径基准', fmt(state.baseR, 2) + ' km', '滑块设定，权重后每个点各不相同'],
    ['领地面积', fmtKm2(res.area) + ' km²', '熟悉度 ≥ ' + state.tCore.toFixed(2) + ' 的等值区域'],
    ['等效圆半径', fmt(res.equiv, 2) + ' km', '同面积的圆，半径 √(A/π)'],
    ['凸包面积', fmtKm2(res.hull) + ' km²', '锚点的外接多边形'],
    ['离散度', fmt(res.spread, 1), '凸包 ÷ 领地，越大说明点越分散'],
    ['失联半径（均值）', fmt(res.lost.mean, 2) + ' km', '从家出发 36 个方向的平均'],
    ['失联半径（最短）', fmt(res.lost.min, 2) + ' km', '最容易走丢的那个方向'],
    ['失联半径（最长）', fmt(res.lost.max, 2) + ' km', '最经得起走的方向'],
    ['占全市', (res.share * 100).toFixed(4) + '%', '全市 ' + fmt(city.area, 0) + ' km²'],
    ['铺满全市需要', fmt(res.copies, 0) + ' 个你', '全市面积 ÷ 你的领地'],
    ['参照物', res.ref ? fmt(res.ref.count, 1) + ' 个' + res.ref.name : '—', '把面积换成能想象的东西'],
    ['重建周数', fmt(res.weeks, 0) + ' 周', res.n + ' 个点 × ' + state.visits + ' 趟 ÷ 每周 '
      + state.perWeek + ' 个新地方']
  ];
  $('tbBody').innerHTML = rows.map(r =>
    '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td><td class="note">' + r[2] + '</td></tr>'
  ).join('');
}

/* ---------------- 主更新 ---------------- */
let lastFit = 0;
function update(fit) {
  state.baseR = num($('baseR').value, 0.05, 20, 0.7);
  state.tCore = num($('tCore').value, 0.01, 0.99, 0.5);
  state.tLost = num($('tLost').value, 0.001, 0.9, 0.05);
  state.visits = num($('visits').value, 1, 60, 7);
  state.perWeek = num($('perWeek').value, 0.1, 30, 2);
  state.homeIdx = num($('homeSel').value, 0, Math.max(0, state.anchors.length - 1), 0);
  $('rOut').textContent = fmt(state.baseR, 2) + ' km';
  $('tOut').textContent = state.tCore.toFixed(2);
  $('tlOut').textContent = state.tLost.toFixed(2);

  const res = compute(state.anchors, {
    city: state.city, baseR: state.baseR, tCore: state.tCore, tLost: state.tLost,
    homeIdx: state.homeIdx, visits: state.visits, perWeek: state.perWeek
  });
  const pr = project(state.anchors, state.baseR);
  // 注意：这里必须把局部坐标 x/y 一起带上，drawMap 里的凸包要用
  res._pts = pr.pts.map(p => ({ lat: p.lat, lon: p.lon, r: p.r, x: p.x, y: p.y }));
  render(res);
  drawMap(res);
  if (fit) { const t = Date.now(); if (t - lastFit > 400) { lastFit = t; fitMap(res); } }
}

/* ---------------- 地点搜索（WebService，失败要看得见） ---------------- */
function search(text) {
  const box = $('searchErr');
  const city = state.city;
  const cb = '__lr_cb_' + Date.now();
  const s = document.createElement('script');
  const url = 'https://apis.map.qq.com/ws/geocoder/v1/?address='
    + encodeURIComponent(city + text)
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
    addAnchor(loc.lat, loc.lng, data.result.title || text);
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

/* ---------------- 预设 / 事件 ---------------- */
function applyPreset(name) {
  const p = PRESETS[name]; if (!p) return;
  state.city = p.city;
  state.anchors = p.anchors.map(a => ({ id: ++uid, name: a.name, lat: a.lat, lon: a.lon, w: a.w }));
  state.homeIdx = 0;
  state.baseR = p.baseR;
  $('citySel').value = p.city;
  $('baseR').value = String(p.baseR);
  [...document.querySelectorAll('.preset')].forEach(b => b.classList.toggle('on', b.textContent === name));
  renderAnchors(); update(true);
}

function bind() {
  const cs = $('citySel');
  Object.keys(CITY_AREAS).forEach(k => {
    const o = document.createElement('option'); o.value = k; o.textContent = k; cs.appendChild(o);
  });
  cs.value = state.city;
  cs.addEventListener('change', () => {
    state.city = CITY_AREAS[cs.value] ? cs.value : '北京';
    if (mapReady) {
      const c = CITY_AREAS[state.city];
      try { map.setCenter(new TMap.LatLng(c.lat, c.lon)); map.setZoom(c.zoom); } catch (e) { }
    }
    update(true);
  });

  const pd = $('presets');
  Object.keys(PRESETS).forEach(k => {
    const b = document.createElement('button'); b.className = 'preset'; b.textContent = k;
    b.addEventListener('click', () => applyPreset(k));
    pd.appendChild(b);
  });

  $('addCenter').addEventListener('click', () => {
    let lat, lon;
    if (mapReady) {
      try { const c = map.getCenter(); lat = c.getLat(); lon = c.getLng(); } catch (e) { }
    }
    if (!isFinite(lat)) { const c = CITY_AREAS[state.city]; lat = c.lat; lon = c.lon; }
    addAnchor(lat, lon, '我在这儿认识一个地方');
  });
  $('clearAll').addEventListener('click', () => {
    state.anchors = []; state.homeIdx = 0; renderAnchors(); update();
  });
  $('homeSel').addEventListener('change', () => { update(); renderAnchors(); });
  ['baseR', 'tCore', 'tLost'].forEach(id => $(id).addEventListener('input', () => update(false)));
  ['visits', 'perWeek'].forEach(id => $(id).addEventListener('input', () => update(false)));

  const q = $('q');
  q.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const t = q.value.trim();
    if (!t) return;
    search(t);
    q.value = '';
  });
}

/* ---------------- 入口：必须自启动 ---------------- */
let booted = false;
function boot() {
  if (booted) return;          // DOMContentLoaded 与 load 都挂了，别跑两遍
  booted = true;
  bind();
  const okMap = initMap();
  applyPreset('住了五年');
  if (!okMap) update(true);
}
window.__lr_boot = boot;
window.__lr_booted = () => booted;
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  boot();
} else {
  document.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('load', boot);
}
