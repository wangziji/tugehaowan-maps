/* =====================================================================
 * 《还剩几回 · HOW MANY TIMES LEFT》 前端
 *
 * 纪律提醒（本项目踩过两次的坑）：
 *   1) 入口必须自启动 —— 页面自己监听 load 调 boot()，
 *      不能只把 boot 挂到 window 上给冒烟脚本调用。
 *   2) catch 里不能只 console.warn —— 静默失败会让地图空白而数字照显，
 *      用户以为地图坏了其实是没画。这里一律落到可见的 #mapErr / #formErr。
 * ===================================================================== */
import {
  compute, haversineKm, remainingYears, jointRemainingYears,
  tripsNeededFor, CITY_FALLBACK
} from './model.js';

const KEY = 'CVIBZ-RDZCD-J3B4T-HGLIP-V7Z2F-EQB5N';
const $ = (id) => document.getElementById(id);

/* ---------------- 预设场景 ---------------- */
const PRESETS = [
  {
    name: '回老家见爸妈',
    youAge: 35, youSex: 'male', withPerson: true, otherAge: 62, otherSex: 'female',
    perYear: 2, hoursEach: 5, travelH: 6, cityA: '北京', cityB: '长沙'
  },
  {
    name: '见那个朋友',
    youAge: 29, youSex: 'female', withPerson: true, otherAge: 30, otherSex: 'female',
    perYear: 4, hoursEach: 5, travelH: 1.5, cityA: '深圳', cityB: '广州'
  },
  {
    name: '吃那家店（不涉及别人）',
    youAge: 38, youSex: 'male', withPerson: false, otherAge: 40, otherSex: 'male',
    perYear: 24, hoursEach: 1, travelH: 0.4, cityA: '北京', cityB: '北京'
  },
  {
    name: '去那座城市',
    youAge: 31, youSex: 'female', withPerson: false, otherAge: 31, otherSex: 'female',
    perYear: 1, hoursEach: 72, travelH: 4, cityA: '上海', cityB: '成都'
  }
];

const state = {
  preset: 0,
  ...PRESETS[0],
  coordA: null, coordB: null,
  distKm: 0
};

/* ---------------- 工具 ---------------- */
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const days = (h) => h / 24;

function pinSVG(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">`
    + `<path d="M17 43S33 26.5 33 16.5C33 7.4 25.8 0 17 0S1 7.4 1 16.5C1 26.5 17 43 17 43Z" fill="${color}" stroke="#ffffff" stroke-width="2.2"/>`
    + `<circle cx="17" cy="16" r="6.2" fill="#ffffff"/></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/* ---------------- 地址解析：JSONP + 本地回落 ---------------- */
let gcSeq = 0;
function geocode(address) {
  return new Promise((resolve, reject) => {
    const local = lookupLocal(address);
    const cbName = '__ntgc_' + (++gcSeq);
    const timer = setTimeout(() => { cleanup(); if (local) resolve({ ...local, via: 'local' }); else reject(new Error('解析超时')); }, 6000);
    function cleanup() { clearTimeout(timer); try { delete window[cbName]; } catch (e) { /* noop */ } const s = document.getElementById(cbName); if (s && s.parentNode) s.parentNode.removeChild(s); }
    window[cbName] = (data) => {
      cleanup();
      if (data && data.status === 0 && data.result && data.result.location) {
        resolve({ lat: data.result.location.lat, lng: data.result.location.lng, title: data.result.title || address, via: 'api' });
      } else if (local) resolve({ ...local, via: 'local' });
      else reject(new Error((data && data.message) || '未能解析该地址'));
    };
    const s = document.createElement('script');
    s.id = cbName;
    s.onerror = () => { cleanup(); if (local) resolve({ ...local, via: 'local' }); else reject(new Error('网络不可用')); };
    s.src = `https://apis.map.qq.com/ws/geocoder/v1/?address=${encodeURIComponent(address)}&key=${KEY}&output=jsonp&callback=${cbName}`;
    document.head.appendChild(s);
  });
}
function lookupLocal(name) {
  if (!name) return null;
  const t = String(name).trim();
  if (CITY_FALLBACK[t]) return { lat: CITY_FALLBACK[t][0], lng: CITY_FALLBACK[t][1], title: t };
  for (const k of Object.keys(CITY_FALLBACK)) {
    if (t.indexOf(k) >= 0 || k.indexOf(t) >= 0) return { lat: CITY_FALLBACK[k][0], lng: CITY_FALLBACK[k][1], title: k };
  }
  return null;
}

/* ---------------- 地图 ---------------- */
let map = null, markerLayer = null, lineLayer = null;

function greatCircle(a, b, n) {
  const toRad = (d) => (d * Math.PI) / 180, toDeg = (r) => (r * 180) / Math.PI;
  const p1 = toRad(a[0]), l1 = toRad(a[1]), p2 = toRad(b[0]), l2 = toRad(b[1]);
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(
    Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    if (d < 1e-9) { pts.push(new TMap.LatLng(a[0], a[1])); continue; }
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push(new TMap.LatLng(toDeg(Math.atan2(z, Math.hypot(x, y))), toDeg(Math.atan2(y, x))));
  }
  return pts;
}

function initMap() {
  if (typeof TMap === 'undefined') { showMapErr('地图脚本未能加载'); return false; }
  try {
    map = new TMap.Map('map', {
      center: new TMap.LatLng(32.5, 113.5),
      zoom: 5,
      pitch: 0,
      baseMap: { type: 'vector', features: ['base', 'building2d', 'point', 'label'] }
    });
    markerLayer = new TMap.MultiMarker({
      map,
      styles: {
        a: new TMap.MarkerStyle({ width: 34, height: 44, anchor: { x: 17, y: 44 }, src: pinSVG('#c0542c') }),
        b: new TMap.MarkerStyle({ width: 34, height: 44, anchor: { x: 17, y: 44 }, src: pinSVG('#2f6b5e') })
      },
      geometries: []
    });
    lineLayer = new TMap.MultiPolyline({
      map,
      styles: { p: new TMap.PolylineStyle({ color: '#c0542c', width: 4, borderWidth: 1, borderColor: '#ffffff', lineCap: 'round', dashArray: [12, 8] }) },
      geometries: []
    });
    $('mapErr').style.display = 'none';
    return true;
  } catch (e) {
    showMapErr('地图初始化失败：' + (e && e.message ? e.message : e));
    return false;
  }
}
function showMapErr(msg) {
  const el = $('mapErr');
  if (!el) return;
  el.textContent = msg + '。右侧数字不受影响，仍可正常使用。';
  el.style.display = 'flex';
}

function drawMap() {
  if (!map || !state.coordA || !state.coordB) return;
  try {
    markerLayer.setGeometries([
      { id: 'A', styleId: 'a', position: new TMap.LatLng(state.coordA[0], state.coordA[1]) },
      { id: 'B', styleId: 'b', position: new TMap.LatLng(state.coordB[0], state.coordB[1]) }
    ]);
    const path = greatCircle(state.coordA, state.coordB, 72);
    lineLayer.setGeometries([{ id: 'L', styleId: 'p', paths: path }]);
    const la = Math.min(state.coordA[0], state.coordB[0]), la2 = Math.max(state.coordA[0], state.coordB[0]);
    const lo = Math.min(state.coordA[1], state.coordB[1]), lo2 = Math.max(state.coordA[1], state.coordB[1]);
    const bounds = new TMap.LatLngBounds(
      new TMap.LatLng(la - 1.5, lo - 1.5), new TMap.LatLng(la2 + 1.5, lo2 + 1.5));
    map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 60, right: 60 } });
  } catch (e) {
    showMapErr('地图绘制失败：' + (e && e.message ? e.message : e));
  }
}

/* ---------------- 读数 ---------------- */
function readForm() {
  state.youAge = Number($('youAge').value);
  state.otherAge = Number($('otherAge').value);
  state.withPerson = $('withPerson').checked;
  state.perYear = Number($('perYear').value);
  state.hoursEach = Number($('hoursEach').value);
  state.travelH = Number($('travelH').value);
  state.cityA = $('cityA').value.trim();
  state.cityB = $('cityB').value.trim();
}

function inputs() {
  return {
    youAge: state.youAge, youSex: state.youSex,
    withPerson: state.withPerson, otherAge: state.otherAge, otherSex: state.otherSex,
    perYear: state.perYear, hoursEach: state.hoursEach,
    travelHoursOneWay: state.travelH, distanceKm: state.distKm
  };
}

/* ---------------- 渲染 ---------------- */
function render() {
  const o = inputs();
  const r = compute(o);

  // 主数字
  $('vTimes').innerHTML = fmt(r.times, r.times < 100 ? 1 : 0) + '<span class="u">次</span>';
  const yrNote = o.withPerson
    ? `两个人都在世的期望年数 ${fmt(r.years, 1)} 年 × 每年 ${fmt(state.perYear, 1)} 次`
    : `你的期望剩余寿命 ${fmt(r.years, 1)} 年 × 每年 ${fmt(state.perYear, 1)} 次`;
  $('sTimes').textContent = yrNote;

  $('vDays').innerHTML = fmt(r.daysTogether, 1) + '<span class="u">天</span>';
  $('sDays').textContent = `合计 ${fmt(r.hoursTogether, 0)} 小时 —— 一年有 8760 小时`;

  // 条形对比
  const mx = Math.max(r.hoursTogether, r.hoursTravel, 1);
  const rows = [
    ['真正相处', r.hoursTogether, '#2f6b5e', `${fmt(r.hoursTogether, 0)} 小时（${fmt(days(r.hoursTogether), 1)} 天）`],
    ['花在路上', r.hoursTravel, '#c0542c', `${fmt(r.hoursTravel, 0)} 小时（${fmt(days(r.hoursTravel), 1)} 天）`]
  ];
  $('bars').innerHTML = rows.map(([nm, v, c, txt]) =>
    `<div class="bar"><span class="nm">${nm}</span><span class="tr"><span class="fl" style="width:${(v / mx * 100).toFixed(1)}%;background:${c}"></span></span><span class="vv">${txt}</span></div>`
  ).join('');

  const ratio = r.hoursTogether > 0 ? r.hoursTravel / r.hoursTogether : Infinity;
  $('ratioNote').textContent = r.hoursTogether <= 0
    ? '把「每次相处」填上一个大于 0 的数，这里就会出现对比。'
    : (ratio >= 1
      ? `你每换回 1 小时相处，要在路上花掉 ${fmt(ratio, 2)} 小时。这些年里你总共要走 ${fmt(r.totalKm, 0)} 公里 —— 绕地球 ${fmt(r.totalKm / 40075, 2)} 圈。`
      : `路上时间是相处时间的 ${fmt(ratio * 100, 0)}%，这笔账还算划算。这些年你总共要走 ${fmt(r.totalKm, 0)} 公里。`);

  // 改法对比
  const variants = [
    ['每年多回 1 次', { perYear: state.perYear + 1 }],
    ['每次多待 2 小时', { hoursEach: state.hoursEach + 2 }],
    ['搬到同城，每周见 1 次', { perYear: 52, travelH: 0.5 }]
  ];
  const tbody = variants.map(([nm, patch]) => {
    const r2 = compute({ ...o, perYear: patch.perYear ?? o.perYear, hoursEach: patch.hoursEach ?? o.hoursEach, travelHoursOneWay: patch.travelH ?? o.travelHoursOneWay });
    const dT = days(r2.hoursTogether - r.hoursTogether);
    const dV = days(r2.hoursTravel - r.hoursTravel);
    const net = dT - dV;
    return `<tr><td>${nm}</td><td class="${dT >= 0 ? 'pos' : 'neg'}">${dT >= 0 ? '+' : ''}${fmt(dT, 1)} 天</td>`
      + `<td class="${dV <= 0 ? 'pos' : 'neg'}">${dV >= 0 ? '+' : ''}${fmt(dV, 1)} 天</td>`
      + `<td class="net ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${fmt(net, 1)} 天</td></tr>`;
  }).join('');
  $('optBody').innerHTML = tbody;
  $('optNote').textContent = '净收益为负不代表不该做 —— 它只是把代价摆到台面上。注意「搬到同城」这一行的量级：距离不是细节，它是这道题里最大的一个变量。';

  // 反推
  renderReverse(o);
}

function renderReverse(o) {
  const target = Number($('targetRange').value);
  $('tgtLab').textContent = fmt(target, 0);
  const t = tripsNeededFor(o, target);
  const cur = o.perYear;
  if (!Number.isFinite(t.trips)) {
    $('revOut').textContent = '当前参数下无法达成（每次相处时长需要大于 0）。';
    return;
  }
  if (t.trips > 365) {
    $('revOut').textContent = `需要每年 ${fmt(t.trips, 1)} 次 —— 超过一天一次，已经不是「多回几趟」能解决的了。`;
    return;
  }
  const d = t.trips - cur;
  const word = d > 0.05 ? `比现在多 ${fmt(d, 1)} 次/年` : (d < -0.05 ? `比现在少 ${fmt(-d, 1)} 次/年` : '和现在基本持平');
  $('revOut').innerHTML = `每年大约要 <b>${fmt(t.trips, 1)} 次</b>（${word}）。`;
}

/* ---------------- 事件 ---------------- */
function bind() {
  // 预设
  const box = $('presets');
  box.innerHTML = PRESETS.map((p, i) => `<button class="preset${i === 0 ? ' on' : ''}" data-i="${i}">${p.name}</button>`).join('');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.preset'); if (!b) return;
    const i = Number(b.dataset.i);
    state.preset = i;
    Object.assign(state, PRESETS[i]);
    [...box.querySelectorAll('.preset')].forEach((el, k) => el.classList.toggle('on', k === i));
    $('youAge').value = PRESETS[i].youAge;
    $('otherAge').value = PRESETS[i].otherAge;
    $('perYear').value = PRESETS[i].perYear;
    $('hoursEach').value = PRESETS[i].hoursEach;
    $('travelH').value = PRESETS[i].travelH;
    $('cityA').value = PRESETS[i].cityA;
    $('cityB').value = PRESETS[i].cityB;
    $('withPerson').checked = PRESETS[i].withPerson;
    setSeg('youSex', PRESETS[i].youSex); state.youSex = PRESETS[i].youSex;
    setSeg('otherSex', PRESETS[i].otherSex); state.otherSex = PRESETS[i].otherSex;
    syncPersonBlock();
    resolveCities().then(render).catch(() => render());
  });

  ['youSex', 'otherSex'].forEach((id) => {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      setSeg(id, b.dataset.v);
      state[id] = b.dataset.v;
      render();
    });
  });
  function setSeg(id, v) {
    [...$(id).querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  }

  $('withPerson').addEventListener('change', () => { syncPersonBlock(); readForm(); render(); });
  ['youAge', 'otherAge', 'perYear', 'hoursEach', 'travelH'].forEach((id) => {
    $(id).addEventListener('input', () => { readForm(); render(); });
  });

  let timer = null;
  ['cityA', 'cityB'].forEach((id) => {
    $(id).addEventListener('change', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        readForm();
        resolveCities().then(render).catch(() => render());
      }, 120);
    });
  });

  $('targetRange').addEventListener('input', () => renderReverse(inputs()));
}

function syncPersonBlock() {
  const on = $('withPerson').checked;
  $('otherBlock').classList.toggle('hidden', !on);
  $('cityBWrap').classList.toggle('hidden', !on);
}

async function resolveCities() {
  const a = await geocode(state.cityA || '北京').catch(() => lookupLocal(state.cityA));
  const b = await geocode(state.cityB || '北京').catch(() => lookupLocal(state.cityB));
  const fa = a || lookupLocal(state.cityA) || CITY_FALLBACK['北京'];
  const fb = b || lookupLocal(state.cityB) || CITY_FALLBACK['北京'];
  state.coordA = [fa.lat, fa.lng];
  state.coordB = [fb.lat, fb.lng];
  state.distKm = haversineKm(fa.lat, fa.lng, fb.lat, fb.lng);
  $('mapBadge').innerHTML = `直线距离 <b>${fmt(state.distKm, 0)} km</b>`;
  drawMap();
}

/* ---------------- 启动 ---------------- */
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  try {
    readForm();
    bind();
    syncPersonBlock();
    render();
    const okMap = initMap();
    // 地图失败也必须继续：数字不依赖地图
    resolveCities().then(render).catch((e) => {
      $('formErr').classList.remove('hidden');
      $('formErr').textContent = '城市解析失败（' + (e && e.message ? e.message : e) + '），已使用内置坐标，里程为近似值。';
      render();
    });
    if (!okMap) { /* initMap 已写可见提示 */ }
  } catch (e) {
    const el = $('formErr');
    if (el) { el.classList.remove('hidden'); el.textContent = '页面初始化出错：' + (e && e.message ? e.message : e); }
  }
}

// 自启动：页面自己负责调用，不是留给外部脚本按的按钮
if (document.readyState === 'complete') boot();
else window.addEventListener('load', boot);

// 供冒烟脚本在「已加载」语境下复算校验（页面本身不依赖它）
window.__nt_boot = boot;
window.__nt_state = state;
window.__nt_compute = compute;
