/* 真实浏览器验收 —— 纯 Node 冒烟测不到的那一层（TMap 是桩，桩不会 404） */
import pw from '/Users/mark/.workbuddy/binaries/node/workspace/node_modules/playwright/index.js';
const { chromium } = pw;
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(__dirname, u === '/' ? 'index.html' : u);
  if (!f.startsWith(__dirname) || !fs.existsSync(f)) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; fails.push(n + ' ' + d); console.log('  FAIL ' + n + '  ' + d); } };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

const consoleErrors = [];
const failedReqs = [];
const tile200 = new Set();
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('requestfailed', r => failedReqs.push(r.url() + ' :: ' + (r.failure() && r.failure().errorText)));
page.on('response', r => { if (/tile|\/vectiles|maptiles/.test(r.url()) && r.status() === 200) tile200.add(r.url()); });

console.log('\n=== A. 加载 ===');
await page.goto(base + '/index.html', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(6000);

ok('A 页面标题正确', (await page.title()).includes('失联半径'));
ok('A 地图容器挂载了 canvas', await page.locator('#map canvas').count() > 0,
  `canvas=${await page.locator('#map canvas').count()}`);
ok('A 地图容器有子节点', await page.locator('#map').evaluate(e => e.children.length) > 0);
ok('A 默认预设已出数：面积不是 –', (await page.locator('#vArea').textContent()) !== '–',
  await page.locator('#vArea').textContent());
ok('A 失联半径已出数', (await page.locator('#vLost').textContent()) !== '–',
  await page.locator('#vLost').textContent());
ok('A 铺满人数已出数', (await page.locator('#vCopies').textContent()) !== '–',
  await page.locator('#vCopies').textContent());
ok('A 飞地列表有内容', (await page.locator('#blobList .blobrow').count()) >= 1,
  `rows=${await page.locator('#blobList .blobrow').count()}`);
ok('A 对照表有行', (await page.locator('#tbBody tr').count()) >= 13,
  `rows=${await page.locator('#tbBody tr').count()}`);
ok('A 地图错误条未显示', await page.locator('#mapErr').evaluate(e => getComputedStyle(e).display) === 'none');
ok('A 瓦片 200 数 > 3（底图真的到了，不是靠排除错误码）', tile200.size > 3, `tiles=${tile200.size}`);

console.log('\n=== B. 交互后图面真的变化 ===');
const shot1 = await page.locator('#map').screenshot();
await page.locator('.preset', { hasText: '本地通' }).click();
await page.waitForTimeout(2500);
const shot2 = await page.locator('#map').screenshot();
ok('B 切预设后地图像素发生变化', Buffer.compare(shot1, shot2) !== 0);
ok('B 切预设后锚点列表变成 16 条', (await page.locator('#anchorList .anchor').count()) === 16,
  `n=${await page.locator('#anchorList .anchor').count()}`);

const areaBefore = await page.locator('#vArea').textContent();
await page.locator('#baseR').fill('1.6');
await page.locator('#baseR').dispatchEvent('input');
await page.waitForTimeout(1500);
const areaAfter = await page.locator('#vArea').textContent();
ok('B 调大熟悉半径后面积变大', parseFloat(areaAfter.replace(/,/g, '')) > parseFloat(areaBefore.replace(/,/g, '')),
  `${areaBefore} → ${areaAfter}`);
const shot3 = await page.locator('#map').screenshot();
ok('B 调滑块后地图像素也变了', Buffer.compare(shot2, shot3) !== 0);

console.log('\n=== C. 点击地图加锚点 ===');
const nBefore = await page.locator('#anchorList .anchor').count();
const box = await page.locator('#map').boundingBox();
await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.55);
await page.waitForTimeout(1800);
const nAfter = await page.locator('#anchorList .anchor').count();
ok('C 点击地图后锚点 +1', nAfter === nBefore + 1, `${nBefore} → ${nAfter}`);

console.log('\n=== D. 清空与恢复 ===');
await page.locator('#clearAll').click();
await page.waitForTimeout(800);
ok('D 清空后面积回到 –', (await page.locator('#vArea').textContent()) === '–');
await page.locator('.preset', { hasText: '住了五年' }).click();
await page.waitForTimeout(1500);
ok('D 恢复预设后重新出数', (await page.locator('#vArea').textContent()) !== '–',
  await page.locator('#vArea').textContent());

console.log('\n=== E. 控制台与网络 ===');
const realErrors = consoleErrors.filter(e => !/ERR_ABORTED|net::ERR_ABORTED/.test(e));
ok('E 控制台零 error（ERR_ABORTED 为良性取消，已排除）', realErrors.length === 0, realErrors.join(' | ').slice(0, 400));
const realFailed = failedReqs.filter(u => !/ERR_ABORTED/.test(u));
ok('E 无真实请求失败（排除 fitBounds 取消的瓦片）', realFailed.length === 0, realFailed.join(' | ').slice(0, 400));
ok('E 没有 4xx 资源', !failedReqs.some(u => /40[0-9]/.test(u)), failedReqs.join(' | ').slice(0, 300));

console.log('\n=== F. 移动端 ===');
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mErr = [];
m.on('console', e => { if (e.type() === 'error') mErr.push(e.text()); });
await m.goto(base + '/index.html', { waitUntil: 'load', timeout: 60000 });
await m.waitForTimeout(5000);
ok('F 移动端地图 canvas 已挂载', await m.locator('#map canvas').count() > 0);
ok('F 移动端已出数', (await m.locator('#vArea').textContent()) !== '–', await m.locator('#vArea').textContent());
ok('F 移动端零 error', mErr.filter(e => !/ERR_ABORTED/.test(e)).length === 0, mErr.join(' | ').slice(0, 300));

await page.screenshot({ path: path.join(__dirname, 'shot-desktop.png'), fullPage: false });
await m.screenshot({ path: path.join(__dirname, 'shot-mobile.png'), fullPage: false });

await browser.close();
server.close();

console.log('\n============================================');
console.log(`浏览器实测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过 ✅');
