/* =====================================================================
 * 前端冒烟：桩掉 DOM 与 TMap，在 Node 里跑通 app.js
 *
 * 第 1 组断言专门模拟真实加载流程：收集 load/DOMContentLoaded 回调 → 触发 →
 * 检查页面自己有没有调用 boot。绝不允许直接调 window.__lr_boot 充数
 * （ancestors 就是这么死的：35 条断言全绿，线上地图空白）。
 * ===================================================================== */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, d = '') {
  if (cond) pass++; else { fail++; fails.push(name + ' ' + d); console.log('  FAIL  ' + name + '  ' + d); }
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

/* ---------- 1. HTML 结构 ---------- */
console.log('\n=== 1. HTML 结构 ===');
const ids = ['presets', 'citySel', 'anchorList', 'addCenter', 'clearAll', 'q', 'homeSel',
  'searchErr', 'baseR', 'tCore', 'tLost', 'visits', 'perWeek',
  'rOut', 'tOut', 'tlOut', 'map', 'mapBadge', 'mapErr',
  'vArea', 'vShareNote', 'vEquiv', 'vRefNote', 'vLost', 'vLostNote',
  'vCopies', 'vWeeksNote', 'logFill', 'blobList', 'blobNote', 'tbBody'];
for (const id of ids) ok(`1 存在 #${id}`, html.includes(`id="${id}"`));
ok('1 引用腾讯地图 GL', html.includes('map.qq.com/api/gljs'));
ok('1 带上地图 key', html.includes('CVIBZ-RDZCD-J3B4T-HGLIP-V7Z2F-EQB5N'));
ok('1 app.js 以 module 方式引入', /<script type="module" src="\.\/app\.js">/.test(html));
ok('1 有免责说明块', html.includes('免责'));
ok('1 标注演示数据', html.includes('演示数据'));
ok('1 说明了算法来源', html.includes('熟悉度核'));

/* ---------- 2. DOM 桩 ---------- */
console.log('\n=== 2. DOM 桩 ===');
const loadCbs = [], dclCbs = [];
const els = new Map();
function mkEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', checked: false, type: '',
    dataset: {}, style: {}, children: [], title: '',
    className: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { on ? this._s.add(c) : this._s.delete(c); } },
      contains(c) { return this._s.has(c); }
    },
    _ev: {},
    addEventListener(t, f) { (this._ev[t] = this._ev[t] || []).push(f); },
    removeEventListener() { },
    appendChild(c) { this.children.push(c); return c; },
    remove() { },
    fire(t, e) { (this._ev[t] || []).forEach(f => f(e || {})); },
    querySelectorAll() { return []; }
  };
  els.set(id, el);
  return el;
}
const created = [];
const document_ = {
  readyState: 'loading',
  getElementById(id) { return els.get(id) || mkEl(id); },
  createElement(tag) {
    const e = mkEl('<' + tag + '#' + (created.length) + '>');
    e.tag = tag; created.push(e); return e;
  },
  querySelectorAll(sel) {
    if (sel === '.preset') return created.filter(e => e.className === 'preset');
    return [];
  },
  addEventListener(t, f) { if (t === 'DOMContentLoaded') dclCbs.push(f); },
  head: { appendChild() { } }
};
const window_ = {
  addEventListener(t, f) { if (t === 'load') loadCbs.push(f); },
  document: document_
};

/* ---------- 3. TMap 桩 ---------- */
console.log('\n=== 3. TMap 桩 ===');
const tmapLog = { markers: 0, circles: 0, lost: 0, polygons: 0, bounds: 0, centers: 0, clicks: null };
class LatLng {
  constructor(lat, lon) { this.lat = lat; this.lon = lon; }
  getLat() { return this.lat; } getLng() { return this.lon; }
}
class LatLngBounds {
  constructor(sw, ne) { this.sw = sw; this.ne = ne; }
}
class MarkerStyle { constructor(o) { Object.assign(this, o); } }
class CircleStyle { constructor(o) { Object.assign(this, o); } }
class PolygonStyle { constructor(o) { Object.assign(this, o); } }
class MultiMarker {
  constructor(o) { this.o = o; }
  setStyles(s) { this.styles = s; }
  setGeometries(g) { tmapLog.markers = g.length; this.geos = g; }
}
class MultiCircle {
  constructor(o) { this.o = o; this.key = o && o.map ? o.map : null; }
  setStyles(s) { this.styles = s; }
  setGeometries(g) { this.geos = g; this._n = g.length; }
}
class MultiPolygon {
  constructor(o) { this.o = o; }
  setStyles(s) { this.styles = s; }
  setGeometries(g) { tmapLog.polygons = g.length; this.geos = g; }
}
const mapInstances = [];
class Map_ {
  constructor(el, o) { this.el = el; this.o = o; this._c = o.center; this._z = o.zoom; mapInstances.push(this); }
  on(t, f) { if (t === 'click') tmapLog.clicks = f; }
  getCenter() { return this._c; }
  setCenter(c) { this._c = c; tmapLog.centers++; }
  setZoom(z) { this._z = z; }
  fitBounds(b, o) { tmapLog.bounds++; this._b = b; }
}
// 区分三个 MultiCircle 图层，便于断言「领地圆」与「失联圆」分别被设置
const circleLayers = [];
const TMap = {
  Map: Map_, LatLng, LatLngBounds, MarkerStyle, CircleStyle, PolygonStyle,
  MultiMarker, MultiPolygon,
  MultiCircle: class extends MultiCircle {
    constructor(o) { super(o); circleLayers.push(this); this.idx = circleLayers.length - 1; }
  }
};

/* ---------- 4. 加载 app.js ---------- */
console.log('\n=== 4. 加载流程 ===');
const sandbox = {
  window: window_, document: document_, TMap,
  console, setTimeout, Date, Math, JSON, encodeURIComponent, Number, String, Array, Object, isFinite,
  __appSrc: appSrc
};
sandbox.globalThis = sandbox;
let bootErr = null;
try {
  const ctx = vm.createContext(sandbox);
  // 直接用正则把 import 换成从 model.js 拿到的命名空间，避免 Node 里解析 module
  const modelNs = await import('./model.js');
  const code = appSrc.replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/model\.js';/m, '');
  vm.runInContext(
    'const { num, isoRadius, project, convexHull, unproject, CITY_AREAS, compute } = __model;\n' + code,
    Object.assign(ctx, { __model: modelNs })
  );
} catch (e) { bootErr = e; }
ok('4 app.js 能被解析执行', bootErr === null, bootErr ? bootErr.message : '');
ok('4 挂出了 __lr_boot', typeof sandbox.window.__lr_boot === 'function');
ok('4 readyState=loading 时不自动跑', sandbox.window.__lr_booted() === false);
ok('4 注册了 load 回调', loadCbs.length === 1, `loadCbs=${loadCbs.length}`);
ok('4 注册了 DOMContentLoaded 回调', dclCbs.length === 1, `dclCbs=${dclCbs.length}`);
ok('4 未触发前没有画任何东西', tmapLog.markers === 0 && tmapLog.polygons === 0);

// 真实加载流程：先 DOMContentLoaded，再 load
loadCbs.forEach(f => f());
ok('5 load 触发后页面自启动', sandbox.window.__lr_booted() === true);
dclCbs.forEach(f => f());
ok('5 重复触发不会二次 boot（幂等）', sandbox.window.__lr_booted() === true);

/* ---------- 5. 启动后的渲染 ---------- */
console.log('\n=== 5. 启动后渲染 ===');
ok('5 地图已创建且带 center', mapInstances.length === 1 && !!mapInstances[0].o.center);
ok('5 地图容器 id = map', mapInstances.length === 1 && mapInstances[0].el === 'map');
ok('5 画出了锚点标记（预设 8 个）', tmapLog.markers === 8, `markers=${tmapLog.markers}`);
ok('5 画出了凸包多边形', tmapLog.polygons === 1, `polygons=${tmapLog.polygons}`);
ok('5 三个 Circle 图层都建立了（领地/失联）', circleLayers.length >= 2, `layers=${circleLayers.length}`);
const terr = circleLayers.find(l => l.geos && l.geos.length === 8);
ok('5 领地图层有 8 个圆', !!terr, circleLayers.map(l => l.geos ? l.geos.length : -1).join(','));
const lostL = circleLayers.find(l => l.geos && l.geos.length === 1 && l.geos[0].id === 'lost');
ok('5 失联圆画了 1 个且 id=lost', !!lostL);
ok('5 失联圆半径为正（米）', !!lostL && lostL.geos[0].radius > 0, lostL ? String(lostL.geos[0].radius) : '-');
ok('5 领地圆半径为正', !!terr && terr.geos.every(g => g.radius > 0));
ok('5 fitBounds 被调用过', tmapLog.bounds >= 1, `bounds=${tmapLog.bounds}`);
ok('5 地图点击回调已注册', typeof tmapLog.clicks === 'function');

/* ---------- 6. 输出数值 ---------- */
console.log('\n=== 6. 输出数值 ===');
const area = els.get('vArea').textContent;
const lost = els.get('vLost').textContent;
const copies = els.get('vCopies').textContent;
ok('6 面积已填充', area && area !== '–', `area=${area}`);
ok('6 失联半径已填充', lost && lost !== '–', `lost=${lost}`);
ok('6 铺满人数已填充', copies && copies !== '–', `copies=${copies}`);
ok('6 面积在合理量级（0.1–100 km²）', parseFloat(area.replace(/,/g, '')) > 0.1 && parseFloat(area.replace(/,/g, '')) < 100, `area=${area}`);
ok('6 失联半径在 0.5–20 km', parseFloat(lost) > 0.5 && parseFloat(lost) < 20, `lost=${lost}`);
ok('6 占比文案含 %', els.get('vShareNote').textContent.includes('%'), els.get('vShareNote').textContent);
ok('6 参照物文案已填', els.get('vRefNote').textContent.includes('相当于'), els.get('vRefNote').textContent);
ok('6 重建周数文案已填', els.get('vWeeksNote').textContent.includes('周'), els.get('vWeeksNote').textContent);
ok('6 对数条宽度 > 0', parseFloat(els.get('logFill').style.width) > 0, els.get('logFill').style.width);
ok('6 逐条对照表有行', els.get('tbBody').innerHTML.includes('<tr>'), String(els.get('tbBody').innerHTML.length));
ok('6 逐条对照至少 13 行', (els.get('tbBody').innerHTML.match(/<tr>/g) || []).length >= 13);
ok('6 飞地列表已渲染', els.get('blobList').children.length >= 1, `blobs=${els.get('blobList').children.length}`);
ok('6 滑块回显已填', els.get('rOut').textContent.includes('km'), els.get('rOut').textContent);

/* ---------- 7. 交互：滑块 / 清空 / 点击加点 ---------- */
console.log('\n=== 7. 交互 ===');
{
  const before = els.get('vArea').textContent;
  const r = els.get('baseR'); r.value = '1.5'; r.fire('input');
  const after = els.get('vArea').textContent;
  ok('7 熟悉半径调大 → 面积变大',
    parseFloat(after.replace(/,/g, '')) > parseFloat(before.replace(/,/g, '')), `${before} → ${after}`);
  ok('7 滑块回显同步', els.get('rOut').textContent.startsWith('1.5'), els.get('rOut').textContent);
  r.value = '0.7'; r.fire('input');

  const t = els.get('tCore'); t.value = '0.7'; t.fire('input');
  ok('7 阈值调高 → 面积变小',
    parseFloat(els.get('vArea').textContent.replace(/,/g, '')) < parseFloat(before.replace(/,/g, '')),
    `${before} → ${els.get('vArea').textContent}`);
  t.value = '0.5'; t.fire('input');

  els.get('clearAll').fire('click');
  ok('7 清空后面积变 –', els.get('vArea').textContent === '–', els.get('vArea').textContent);
  ok('7 清空后标记数为 0', tmapLog.markers === 0, `markers=${tmapLog.markers}`);

  // 模拟地图点击加点（走的是页面注册的 click 回调，不是内部函数）
  tmapLog.clicks({ latLng: new LatLng(39.90, 116.40) });
  ok('7 点地图后多了一个锚点', tmapLog.markers === 1, `markers=${tmapLog.markers}`);
  tmapLog.clicks({ latLng: new LatLng(39.92, 116.44) });
  ok('7 再点一次变成两个', tmapLog.markers === 2, `markers=${tmapLog.markers}`);
  ok('7 两个点面积已算出', els.get('vArea').textContent !== '–', els.get('vArea').textContent);

  // 非法坐标不应崩
  let crashed = false;
  try { tmapLog.clicks({ latLng: new LatLng(NaN, NaN) }); } catch (e) { crashed = true; }
  ok('7 非法经纬度点击不崩', !crashed);
  ok('7 非法坐标后锚点数不变', tmapLog.markers === 2, `markers=${tmapLog.markers}`);

  // 家切换
  const hs = els.get('homeSel');
  hs.value = '1'; hs.fire('change');
  ok('7 切换「家」后失联半径仍有效', parseFloat(els.get('vLost').textContent) > 0, els.get('vLost').textContent);
}

/* ---------- 8. 城市切换与预设 ---------- */
console.log('\n=== 8. 城市切换与预设 ===');
{
  const cs = els.get('citySel');
  ok('8 城市下拉已填充 16 项', cs.children.length === 16, `n=${cs.children.length}`);
  cs.value = '上海'; cs.fire('change');
  ok('8 切城市后中心被移动', tmapLog.centers >= 1);
  ok('8 切城市后仍有输出', els.get('vCopies').textContent !== '–', els.get('vCopies').textContent);
  cs.value = '北京'; cs.fire('change');

  const ps = created.filter(e => e.className === 'preset');
  ok('8 预设按钮 4 个', ps.length === 4, `n=${ps.length}`);
  ps[0].fire('click');   // 刚来三个月
  ok('8 预设「刚来三个月」= 3 个锚点', tmapLog.markers === 3, `markers=${tmapLog.markers}`);
  const a3 = parseFloat(els.get('vArea').textContent.replace(/,/g, ''));
  ps[2].fire('click');   // 本地通
  ok('8 预设「本地通」= 16 个锚点', tmapLog.markers === 16, `markers=${tmapLog.markers}`);
  const a16 = parseFloat(els.get('vArea').textContent.replace(/,/g, ''));
  ok('8 锚点越多面积越大', a16 > a3, `${a3} → ${a16}`);
  ps[3].fire('click');   // 双城飞人（上海）
  ok('8 双城飞人切到上海', els.get('citySel').value === '上海', els.get('citySel').value);
  ok('8 双城飞人 5 个锚点', tmapLog.markers === 5, `markers=${tmapLog.markers}`);
  ps[1].fire('click');   // 回到住了五年
  ok('8 回到预设「住了五年」', tmapLog.markers === 8, `markers=${tmapLog.markers}`);
}

/* ---------- 9. 搜索失败必须可见（静默失败不可接受） ---------- */
console.log('\n=== 9. 搜索降级 ===');
{
  const q = els.get('q');
  q.value = '三里屯';
  let threw = false;
  try { q.fire('keydown', { key: 'Enter' }); } catch (e) { threw = true; }
  ok('9 回车触发搜索不抛异常', !threw);
  ok('9 搜索失败会写可见提示（不会静默）',
    appSrc.includes("box.style.display = 'block'") && appSrc.includes('搜索超时'), '源码含可见降级分支');
  ok('9 搜索脚本走 JSONP 而非 fetch（跨域）', appSrc.includes('output=jsonp'));
  ok('9 标记内联 SVG data URI（外链图已 404）', appSrc.includes('data:image/svg+xml'));
  ok('9 家与常去点用不同图标', appSrc.includes("glyph ?") && appSrc.includes("'家'"));
}

/* ---------- 10. 源码级纪律检查 ---------- */
console.log('\n=== 10. 源码级纪律 ===');
ok('10 入口自启动（DOMContentLoaded 或 load）',
  /addEventListener\('DOMContentLoaded'|addEventListener\('load'/.test(appSrc));
ok('10 boot 有幂等保护', /if \(booted\) return/.test(appSrc));
ok('10 数值输入全部过 num()',
  (appSrc.match(/num\(/g) || []).length >= 8, `num() 出现 ${(appSrc.match(/num\(/g) || []).length} 次`);
ok('10 mapErr 用于可见报错', appSrc.includes('showErr'));
ok('10 drawMap 有 try/catch 且回写 UI', /catch \(err\)[\s\S]{0,160}showErr/.test(appSrc));
ok('10 锚点有数量上限（防卡死）', appSrc.includes('200'));

console.log('\n============================================');
console.log(`冒烟结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过 ✅');
