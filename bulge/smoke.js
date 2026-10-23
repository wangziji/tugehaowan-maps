/* 地球鼓包 · 前端冒烟
 * 纪律（上一轮血的教训）：入口自启动必须单独断言，且必须模拟真实 load 流程，
 * 不允许冒烟脚本自己手动调 boot 充数。
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pass = 0, fail = 0;
function ok(c, n, d) {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   ' + d : '')); }
  else { fail++; console.log('  FAIL  ' + n + '   ' + d); }
}

/* ---------- 极简 DOM ---------- */
function El(id, tag) {
  this.id = id; this.tagName = tag || 'div';
  this._html = ''; this.textContent = ''; this.value = '';
  this.style = {}; this._attrs = {}; this._handlers = {}; this.children = [];
  this.classList = { _s: {}, toggle: function (c, v) { this._s[c] = !!v; },
                     add: function (c) { this._s[c] = true; }, remove: function (c) { delete this._s[c]; } };
}
Object.defineProperty(El.prototype, 'innerHTML', {
  get: function () { return this._html; },
  set: function (v) { this._html = String(v); }
});
El.prototype.addEventListener = function (t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); };
El.prototype.fire = function (t, ev) {
  (this._handlers[t] || []).forEach(function (f) { f(ev || {}); });
};
El.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
El.prototype.getAttribute = function (k) { return this._attrs[k] === undefined ? null : this._attrs[k]; };
El.prototype.closest = function (sel) {
  var m = /\[([\w-]+)\]/.exec(sel);          // 取 button[data-preset] 里的完整属性名
  if (m && this._attrs[m[1]] !== undefined) return this;
  return null;
};
El.prototype.appendChild = function (c) { this.children.push(c); return c; };
El.prototype.removeChild = function (c) {
  var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c;
};

var ids = ['err', 'tmap', 'mapfail', 'pickhint', 'presets', 'bigSag', 'bigSagSub', 'kvMain',
  'scaleNote', 'hVal', 'kvView', 'xsSvg', 'xsInfo', 'xsNote', 'cmpTable', 'wow', 'q',
  'btnSearch', 'btnSwap', 'btnRefr', 'hRange'];
var els = {};
ids.forEach(function (i) { els[i] = new El(i); });

var hButtons = ['0.0017', '0.05', '0.3', '0.632', '8.84886', '10.6', '420'].map(function (h) {
  var b = new El('hb', 'button'); b.setAttribute('data-h', h); return b;
});

var loadHandlers = [];
var document = {
  readyState: 'loading',
  body: new El('body', 'body'),
  getElementById: function (i) { return els[i] || null; },
  querySelectorAll: function (s) { return s === 'button[data-h]' ? hButtons : []; },
  createElement: function (t) { return new El('created', t); },
  addEventListener: function () {}
};
var window = {
  document: document,
  addEventListener: function (t, fn) { if (t === 'load') loadHandlers.push(fn); },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  Math: Math, JSON: JSON, isFinite: isFinite, Number: Number, String: String,
  console: console, encodeURIComponent: encodeURIComponent
};
window.window = window;
window.self = window;

/* TMap 桩 */
function LL(lat, lng) { this.lat = lat; this.lng = lng; }
LL.prototype.getLat = function () { return this.lat; };
LL.prototype.getLng = function () { return this.lng; };
var circleCalls = [], markerCalls = [], lineCalls = [];
window.TMap = {
  LatLng: LL,
  LatLngBounds: function () { this.extend = function () {}; },
  MarkerStyle: function () {}, PolylineStyle: function () {}, CircleStyle: function () {},
  Map: function () { this.on = function () {}; this.fitBounds = function () {}; },
  MultiMarker: function () { var s = this; s.setGeometries = function (g) { markerCalls.push(g); }; },
  MultiPolyline: function () { var s = this; s.setGeometries = function (g) { lineCalls.push(g); }; },
  MultiCircle: function () { var s = this; s.setGeometries = function (g) { circleCalls.push(g); }; }
};

/* ---------- 载入脚本 ---------- */
var ctx = vm.createContext(window);
function load(f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f });
}

console.log('\n=== S1. 入口自启动（模拟真实 load 流程） ===');
load('model.js');
load('app.js');
ok(loadHandlers.length === 1, 'S1.1 页面注册且仅注册了一个 load 回调（自启动挂上了）',
   'count=' + loadHandlers.length);
ok(els.kvMain._html === '', 'S1.2 触发 load 之前，面板确实还是空的（不是脚本预先填好的）');
ok(els.cmpTable._html === '', 'S1.3 触发 load 之前，对照表也是空的');
loadHandlers.forEach(function (f) { f(); });
ok(els.kvMain._html.length > 50, 'S1.4 触发 load 后，主面板被真实填充',
   'len=' + els.kvMain._html.length);
ok(els.cmpTable._html.indexOf('对跖点') >= 0, 'S1.5 对照表已构建');
ok(els.wow._html.indexOf('珠穆朗玛峰') >= 0, 'S1.6 反常识列表已构建');
ok(els.bigSag.textContent.length > 0, 'S1.7 主数字已渲染', els.bigSag.textContent);

console.log('\n=== S2. 反例验证：不派发 load 就什么都不该发生 ===');
// 干净地重跑一遍：这次不派发 load 回调，断言页面确实是空的
var els2 = {};
ids.forEach(function (i) { els2[i] = new El(i); });
var loadH2 = [];
var doc2 = Object.assign({}, document, {
  readyState: 'loading',
  getElementById: function (i) { return els2[i] || null; },
  body: new El('body', 'body')
});
var win2 = Object.assign({}, window, {
  document: doc2,
  addEventListener: function (t, fn) { if (t === 'load') loadH2.push(fn); }
});
win2.window = win2; win2.self = win2; win2.TMap = window.TMap;
var ctx2 = vm.createContext(win2);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'model.js'), 'utf8'), ctx2, { filename: 'model.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), ctx2, { filename: 'app.js' });
ok(loadH2.length === 1, 'S2.1 干净环境里同样挂上了 load 回调');
ok(els2.kvMain._html === '', 'S2.2 未派发 load 时主面板为空 —— 证明填充确实来自 load 回调');
ok(els2.cmpTable._html === '', 'S2.3 未派发 load 时对照表为空');
ok(els2.bigSag.textContent === '', 'S2.4 未派发 load 时主数字为空');

console.log('\n=== S3. 地图图层真的被喂了数据 ===');
ok(markerCalls.length >= 1 && markerCalls[0].length === 2, 'S3.1 两个标记已下发',
   'n=' + (markerCalls[0] || []).length);
ok(lineCalls.length >= 1 && lineCalls[0].length === 1, 'S3.2 连线已下发');
ok(circleCalls.length >= 1 && circleCalls[0][0].radius > 0, 'S3.3 视野圈已下发且半径为正',
   'r=' + Math.round(circleCalls[0][0].radius) + ' m');
ok(document.getElementById('mapfail').style.display !== 'block', 'S3.4 地图正常时不应显示失败提示');

console.log('\n=== S4. 交互改动会改变主体 ===');
var before = els.bigSag.textContent;
els.presets.fire('click', { target: (function () {
  var b = new El('p', 'button'); b.setAttribute('data-preset', '5'); return b; })() });
ok(els.bigSag.textContent !== before, 'S4.1 点击「对跖点」预设后主数字变化',
   before + ' -> ' + els.bigSag.textContent);
ok(els.kvMain._html.indexOf('不可能') >= 0, 'S4.2 对跖点应给出「无论多高都不可能」');

els.presets.fire('click', { target: (function () {
  var b = new El('p', 'button'); b.setAttribute('data-preset', '1'); return b; })() });
var bjsh = els.bigSag.textContent;
// 默认状态就是北京-上海，所以这里比对的是「从对跖点切回来」确实变了
ok(bjsh.indexOf('公里') >= 0 && bjsh !== '6,371 公里',
   'S4.3 从对跖点切回北京-上海预设，主数字回到公里级鼓包', bjsh);

var beforeSwap = els.bigSagSub._html;
els.btnSwap.fire('click');
ok(els.bigSagSub._html !== beforeSwap, 'S4.4 交换 A/B 后副标题变化');

els.btnRefr.fire('click');
ok(els.kvMain._html.length > 50 && els.kvView._html.length > 50, 'S4.5 开启折射后面板仍正常');
ok(els.btnRefr.textContent === '已计入大气折射', 'S4.6 折射按钮文案已切换', els.btnRefr.textContent);
els.btnRefr.fire('click');

var hBefore = els.hVal.textContent;
els.hRange.value = '1000';
els.hRange.fire('input');
ok(els.hVal.textContent !== hBefore, 'S4.7 拖动高度滑块后高度读数变化',
   hBefore + ' -> ' + els.hVal.textContent);
ok(els.kvView._html.indexOf('地平线距离') >= 0, 'S4.8 视野面板已渲染');

hButtons[4].fire('click');   // 珠峰
ok(els.hVal.textContent.indexOf('8.85') >= 0,
   'S4.9 珠峰预设把高度设为 8848 米（显示为 8.85 公里）', els.hVal.textContent);
ok(els.kvView._html.indexOf('335') >= 0 || els.kvView._html.indexOf('336') >= 0,
   'S4.10 珠峰高度下视距约 336 公里');

console.log('\n=== S5. 剖面 SVG ===');
ok(els.xsSvg._html.indexOf('<polyline') >= 0, 'S5.1 剖面画出了地表弧线');
ok(els.xsSvg._html.indexOf('polygon') >= 0, 'S5.2 剖面画出了鼓包填充');
ok(els.xsSvg._html.indexOf('NaN') < 0, 'S5.3 剖面里没有 NaN');
ok(els.xsInfo._html.indexOf('弦长') >= 0, 'S5.4 剖面信息区已填充');
ok(els.xsNote._html.indexOf('自相似') >= 0, 'S5.5 剖面注明了垂直放大与自相似');

console.log('\n=== S6. 异常可见性 ===');
els.btnSearch.fire('click');
ok(els.err.style.display === 'block' && els.err._html.indexOf('请先输入') >= 0,
   'S6.1 空输入会给出可见提示，而不是静默', els.err._html);

console.log('\n=== S7. 数字抽查（与 verify.js 一致） ===');
var BM = window.BM;
ok(Math.abs(BM.solve(100, false).sagittaM - 196.2) < 0.5, 'S7.1 100km 鼓包 196.2 m');
ok(Math.abs(BM.view(0.0017, false).areaKm2 - 68.05) < 0.5, 'S7.2 平地可见 68.05 km²');
ok(BM.solve(Math.PI * BM.R, false).sagittaM / 1000 > 6370, 'S7.3 对跖点鼓包 = 一个地球半径');
ok(BM.solve(Math.PI * BM.R, false).oneSidedM === Infinity,
   'S7.4 对跖点单侧高度必须是 Infinity（页面据此显示「无论多高都不可能」）',
   'raw=' + BM.solve(Math.PI * BM.R, false).oneSidedM);
els.presets.fire('click', { target: (function () {
  var b = new El('p', 'button'); b.setAttribute('data-preset', '5'); return b; })() });
ok(els.kvMain._html.indexOf('不可能') >= 0 || els.kvMain._html.indexOf('无论多高') >= 0,
   'S7.5 切到对跖点后，主面板确实印出了「不可能」字样');
ok(els.bigSag.textContent.indexOf('6,371') >= 0,
   'S7.6 对跖点鼓包显示为一个地球半径 6371 公里', els.bigSag.textContent);

console.log('\n========================================');
console.log('  PASS ' + pass + '   FAIL ' + fail);
console.log('========================================\n');
process.exit(fail ? 1 : 0);
