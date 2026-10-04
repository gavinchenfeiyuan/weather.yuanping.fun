#!/usr/bin/env node
/*
 * 月相图标渲染验证（真实 DOM + 截图 + 像素分析）
 *
 * 为什么不用 canvas 方式：
 *   把 SVG 序列化后经 data:/blob: URL 交给 <img> 再 drawImage 的做法，
 *   在 WebKit（Safari 引擎）下会渲染为空白（any=0），测不出真实效果。
 *   而 iPhone 正是本项目的主要使用场景，WebKit 必须验证。
 *   因此本脚本改为：在页面内插入真实 SVG 实例 → 截图 → 逐格分析像素。
 *
 * 用法：
 *   node test/moon-render-check.js <页面URL> [--engine=chromium|webkit|both] [--png=输出路径] [--keep]
 * 参数：
 *   --png=路径  额外把截图另存到该路径（需要留档时用）
 *   --keep      保留内部临时截图（默认分析完即删除，避免在仓库里留垃圾）
 * 退出码：0 全部符合预期；1 有异常
 *
 * 覆盖两类判据：
 *   A. DOM 结构 —— 插入的每个实例 clipPath id 必须唯一（重复会导致 url(#id) 取到别人的形状）
 *   B. 几何 —— 亮面占比 ≈ 理论照亮比例 (1-cos(2πv))/2；朝向随相位翻转
 *
 * 注意（踩过的坑）：
 *   - 探针容器宽度 = 格数 × 格宽，必须小于 viewport 宽度，
 *     否则越界的格子截到的是空白/垃圾像素，会得到完全错误的占比。
 *   - 判定朝向时，亮/暗面小于约 3% 时不足 1px 宽，无法承载朝向信息，须跳过。
 */
const { chromium, webkit } = require("playwright");
const fs = require("fs");
const path = require("path");

// 本机存在 http_proxy / https_proxy 环境变量（Clash / 开发代理）。
// Chromium 会忽略它，但 WebKit 会照用 —— 于是访问本地 127.0.0.1:8770 也被送进代理，
// 拿回 HTTP 502、页面脚本根本没执行（表现为 cache / goView 全是 undefined）。
// 这里强制把环回地址排除在代理之外；同时保留代理供外部 CDN（和风图标字体）使用。
process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost,::1";

const PAGE = process.argv[2] || "http://127.0.0.1:8770/index.html";
const engArg = (process.argv.find(a => a.startsWith("--engine=")) || "").split("=")[1] || "both";
const KEEP = process.argv.includes("--keep");
const pngArg = (process.argv.find(a => a.startsWith("--png=")) || "").split("=")[1] || null;

const CELL = 96;               // 每个相位的截图格尺寸
const SIZE = CELL - 20;        // 图标边长（留白避免相邻格串色）
const TOL = 0.07;              // 亮面占比容差（含月海纹理带来的轻微偏差）
// ⚠ 必须与 index.html 里的 MOON_MIN_LIT 保持一致（极小月牙的可见下限）。
// 用于推算「多日预报本应有多少种形状」—— 保底会让极细月牙归并到同一档。
const MMIN = 0.06;

// ---- 临时截图清理 ----
// 截图落盘后若进程被强杀（超时被终止等），正常路径里的 unlink 执行不到，就会留下孤儿文件。
// 注意：Windows 下 Node 收不到 POSIX 信号，`process.on("SIGTERM")` 基本不触发，
// 所以不能只靠退出钩子 —— 真正可靠的是**下次启动时清扫孤儿**（见 sweepOrphans）。
const RUN_START = Date.now();
let __shot = null;
function cleanupShot() {
  if (__shot && !KEEP) { try { fs.unlinkSync(__shot); } catch (e) {} }
  __shot = null;
}
process.on("exit", cleanupShot);
["SIGINT", "SIGTERM", "SIGHUP"].forEach(s => process.on(s, () => { cleanupShot(); process.exit(130); }));

// 清扫上一次运行被中断后遗留的截图：只删「早于本次启动」的同名文件，
// 不碰本次刚生成的，也不会误删并发运行中的另一实例（其文件新得多）。
function sweepOrphans() {
  if (KEEP) return 0;
  let n = 0;
  try {
    const dir = require("os").tmpdir();
    for (const f of fs.readdirSync(dir)) {
      if (!/^moon-render-.+\.png$/.test(f)) continue;
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < RUN_START) { fs.unlinkSync(p); n++; } } catch (e) {}
    }
  } catch (e) {}
  return n;
}

// 8 个标准相位：value 定义 0=新月，0.25=上弦，0.5=满月，0.75=下弦
const PHASES = [
  ["新月", 0.000],
  ["蛾眉月", 0.125],
  ["上弦月", 0.250],
  ["盈凸月", 0.375],
  ["满月", 0.500],
  ["亏凸月", 0.625],
  ["下弦月", 0.750],
  ["残月", 0.875],
];
const EDGE = [0.010, 0.990];   // 极细月牙边界

// 用 Chromium 解码 PNG 并逐格统计（避免依赖外部图像库）
async function analyzePng(pngPath, cells) {
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const b = await chromium.launch();
  const p = await b.newPage();
  const stats = await p.evaluate(async ({ b64, cell, n }) => {
    const img = new Image();
    const st = await new Promise(r => { img.onload = () => r("ok"); img.onerror = () => r("err"); img.src = "data:image/png;base64," + b64; });
    if (st !== "ok") return { error: "PNG 解码失败" };
    const W = img.width, H = img.height;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const cx = cv.getContext("2d");
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, W, H).data;
    const out = [];
    for (let i = 0; i < n; i++) {
      const x0 = i * cell, x1 = (i + 1) * cell;
      let lit = 0, dark = 0, any = 0, sumLit = 0, sumDark = 0;
      for (let y = 0; y < H; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * W + x) * 4;
          const r = d[o], bb = d[o + 2], a = d[o + 3];
          if (a < 40) continue;                       // 透明背景
          any++;
          // 亮面 = 暖色（月色渐变 #FBF3DD→#B99A5C，r 明显大于 b）
          // 暗面 = 冷色（#3A4A63 叠透明，b 明显大于 r）
          // 用冷暖对比而非绝对亮度，避免受渐变明暗影响
          if (r - bb > 25) { lit++; sumLit += (x - x0); }
          else if (bb - r > 15) { dark++; sumDark += (x - x0); }
        }
      }
      out.push({
        lit, dark, any,
        lcx: lit ? sumLit / lit / cell : null,     // 亮面重心（0=左缘，1=右缘）
        dcx: dark ? sumDark / dark / cell : null,  // 暗面重心
      });
    }
    return { out, W, H };
  }, { b64, cell: CELL, n: cells });
  await b.close();
  return stats;
}

async function renderEngine(engineName, engine) {
  const b = await engine.launch();
  const p = await b.newPage({ viewport: { width: CELL * 22, height: 320 }, deviceScaleFactor: 1 });
  const errs = [];
  p.on("pageerror", e => errs.push(e.message.slice(0, 80)));
  // WebKit 加载本页偶发较慢（外部字体/图标 CDN），放宽超时
  await p.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 90000 });
  await p.waitForTimeout(2600);

  // ---------- A. 真实页面 DOM：clipPath id 必须唯一 ----------
  // 进入单城市页 → hero(1) + 多日预报(10 天 × 行首/详情 2 处) + 天文区(1) 全部渲染
  const domCheck = await p.evaluate((mmin) => {
    if (typeof goView === "function") goView(1);
    // 与 index.html 的 moonPhasePath 保持同一套夹取规则，用于算「期望有多少种形状」。
    // 极小月牙有可见下限，多天的 value 可能被夹到同一档 → 形状本就该相同。
    const shapeOf = v => {
      const pp = ((v % 1) + 1) % 1;
      let t = Math.cos(2 * Math.PI * pp);
      if (pp !== 0 && Math.abs(t) > 1 - 2 * mmin) t = Math.sign(t) * (1 - 2 * mmin);
      return t.toFixed(4);
    };
    return new Promise(res => setTimeout(() => {
      const all = [...document.querySelectorAll("svg.moon-svg")];
      const ids = [...document.querySelectorAll("svg.moon-svg clipPath")].map(c => c.id);
      const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
      // 同一天的行首与详情行必须同形（同一 value）
      const perDay = [...document.querySelectorAll(".d-row")].map(r =>
        [...r.querySelectorAll("clipPath path")].map(x => x.getAttribute("d")));
      const vals = (typeof cache !== "undefined" && cache[curCity] && cache[curCity].moon_phase)
        ? cache[curCity].moon_phase.days.map(x => x.value) : [];
      const expectShapes = new Set(vals.map(shapeOf)).size;
      res({
        instances: all.length, ids: ids.length, unique: new Set(ids).size, dup,
        days: perDay.length,
        sameInDay: perDay.every(x => x.length === 2 && x[0] === x[1]),
        distinctDays: new Set(perDay.map(x => x[0])).size,
        expectShapes,
        hasMoonBody: !!document.querySelector("svg.moon-svg use[href='#moonBody']"),
      });
    }, 2200));
  }, MMIN);
  console.log(`  实例 ${domCheck.instances} 个 / clipPath ${domCheck.ids} 个 / 唯一 id ${domCheck.unique} 个` +
    `　→ ${domCheck.ids === domCheck.unique && domCheck.hasMoonBody ? "✓ id 唯一" : "✗ " + (domCheck.dup.length ? "重复 " + domCheck.dup.join(",") : "缺 moonBody 引用")}`);
  // 形状种数只判「下界」：夹取归并后至少应有 expectShapes 种；实际可能更多 ——
  // path 里 rx 是全精度浮点，理论上相同的值（如 0.92 与 0.08）会因计算路径不同
  // 产生末位差异而被算作两种，视觉上并无区别。真正的退化（所有天同形）必被捕获。
  const shapeOk = domCheck.distinctDays >= domCheck.expectShapes;
  console.log(`  多日预报 ${domCheck.days} 天：行首与详情行同形 ${domCheck.sameInDay ? "✓" : "✗"}；` +
    `形状种数 ${domCheck.distinctDays} ≥ 期望下界 ${domCheck.expectShapes}（极小月牙保底会归并）${shapeOk ? " ✓" : " ✗"}`);
  const domOk = domCheck.ids === domCheck.unique && domCheck.hasMoonBody && domCheck.sameInDay && shapeOk;

  // ---------- B. 8 标准相位 + 极细月牙 + 真实数据值 ----------
  const real = await p.evaluate(() => {
    const d = cache[curCity];
    return d && d.moon_phase && d.moon_phase.days ? d.moon_phase.days.map(x => x.value) : [];
  });
  const cases = [...PHASES, ...EDGE.map(v => [`边界 ${v}`, v]), ...real.map(v => [`实况 ${v}`, v])];

  const mounted = await p.evaluate(({ list, cell, size }) => {
    const host = document.createElement("div");
    host.id = "__moon_probe";
    // 放在视口内，每格用纯黑底：黑色 r≈b，既不算暖色也不算冷色，不会干扰判据；
    // （不能依赖 omitBackground —— 对 fixed 元素无效，页面内容仍会透出）
    host.style.cssText = "position:fixed;left:0;top:0;z-index:99999;display:flex;background:#000";
    list.forEach(([, v]) => {
      const wrap = document.createElement("div");
      wrap.style.cssText = `width:${cell}px;height:${cell}px;display:flex;align-items:center;justify-content:center;background:#000`;
      if (typeof window.moonSvgByValue !== "function") { wrap.textContent = "no-fn"; host.appendChild(wrap); return; }
      wrap.innerHTML = window.moonSvgByValue(v, size);
      host.appendChild(wrap);
    });
    document.body.appendChild(host);
    const r = host.getBoundingClientRect();
    return { n: host.querySelectorAll("svg.moon-svg").length, w: Math.round(r.width), h: Math.round(r.height),
             probeIds: new Set([...host.querySelectorAll("clipPath")].map(c => c.id)).size };
  }, { list: cases.map(([zh, v]) => [zh, v]), cell: CELL, size: SIZE });

  if (!cases.length || mounted.n !== cases.length) {
    console.log(`  ✗ 挂载异常：期望 ${cases.length} 个实例，实际 ${mounted.n} 个`);
    await b.close();
    return { ok: false };
  }
  console.log(`  挂载 ${mounted.n} 个实例（clipPath 唯一 id ${mounted.probeIds} 个 → ${mounted.probeIds === mounted.n ? "✓" : "✗"}），合成图 ${mounted.w}×${mounted.h}`);

  // 中间截图默认写到系统临时目录：它只是一次性分析素材，不该留在仓库里。
  // 需要留档时用 --png=路径 另存，或用 --keep 改为落在本目录。
  const shotDir = KEEP ? __dirname : require("os").tmpdir();
  const shotPath = path.join(shotDir, `moon-render-${engineName}-${process.pid}.png`);
  __shot = shotPath;   // 交给退出钩子兜底
  // 用 page.screenshot + 坐标裁剪，而非 locator.screenshot：
  // WebKit 下对动态挂载的元素做 locator.screenshot 会长时间等待"元素稳定"直至超时。
  const box = await p.evaluate(({ cell, n }) => {
    const h = document.getElementById("__moon_probe");
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(cell * n), height: Math.round(cell) };
  }, { cell: CELL, n: cases.length });
  await p.screenshot({ path: shotPath, clip: box });
  await p.evaluate(() => { const h = document.getElementById("__moon_probe"); if (h) h.remove(); });
  await b.close();

  const res = await analyzePng(shotPath, cases.length);
  // 需要留档时先另存（必须赶在删除之前，否则复制不到文件）
  if (pngArg) { try { fs.copyFileSync(shotPath, pngArg); console.log(`  截图另存 → ${pngArg}`); } catch (e) { console.log(`  截图另存失败：${e.message}`); } }
  // 分析完即清理中间截图（--keep 时保留，便于人工核对）
  if (!KEEP) { try { fs.unlinkSync(shotPath); } catch (e) {} }
  __shot = null;
  if (res.error) { console.log(`  ✗ ${res.error}`); return { ok: false }; }
  if (pngArg && !pngArg.includes(engineName)) { /* 由调用方决定命名 */ }

  const stats = res.out;
  const full = stats[PHASES.findIndex(([, v]) => v === 0.5)].lit || 1;   // 满月 = 面积基准
  const sign = x => (!x || Math.abs(x - 0.5) < 0.005) ? 0 : (x > 0.5 ? 1 : -1);

  console.log("\n  相位        value   理论照亮  实测亮面   偏差    朝向    结果");
  console.log("  " + "─".repeat(62));
  let ok = 0;
  cases.forEach(([zh, v], i) => {
    const s = stats[i];
    const theory = (1 - Math.cos(2 * Math.PI * v)) / 2;   // 新 0 / 上弦 .5 / 满 1
    const meas = s.lit / full;
    const diff = meas - theory;
    // 朝向：月牙看亮面重心（盈→右、亏→左）；凸月看暗面重心（在对侧）；半圆不判。
    // 亮/暗面小于约 3% 时不足 1px 宽，无法承载朝向信息，跳过。
    let sExp = 0, sGot = 0, note = "—";
    if (theory < 0.45 && meas >= 0.03) { sExp = v < 0.5 ? 1 : -1; sGot = sign(s.lcx); note = "亮面"; }
    else if (theory > 0.55 && (1 - theory) >= 0.03) { sExp = v < 0.5 ? -1 : 1; sGot = sign(s.dcx); note = "暗面"; }
    const diffOk = Math.abs(diff) <= TOL, oriOk = sExp === 0 || sGot === sExp;
    const pass = diffOk && oriOk;
    if (pass) ok++;
    const dn = x => x === 0 ? "中" : (x > 0 ? "右" : "左");
    console.log(`  ${zh.padEnd(9)} ${v.toFixed(3).padStart(5)}  ${theory.toFixed(3).padStart(6)}  ${meas.toFixed(3).padStart(7)}  ${((diff >= 0 ? "+" : "") + diff.toFixed(3)).padStart(7)}  ${(note + dn(sGot)).padEnd(6)} ${pass ? "✓" : "✗" + (diffOk ? "" : " 占比") + (oriOk ? "" : " 朝向")}`);
  });
  console.log(`  → ${ok}/${cases.length} 通过 ${ok === cases.length ? "✓" : "✗"}`);
  if (errs.length) console.log(`  控制台错误：${errs.join(" | ")}`);

  return { ok: domOk && ok === cases.length, shotPath, cases };
}

(async () => {
  const swept = sweepOrphans();
  if (swept) console.log(`[清理] 已删除上次中断遗留的 ${swept} 张临时截图（系统临时目录）`);

  const engines = engArg === "both" ? [["chromium", chromium], ["webkit", webkit]] : [[engArg, engArg === "webkit" ? webkit : chromium]];
  const summary = [];

  for (const [name, engine] of engines) {
    console.log(`\n===== ${name} =====`);
    let r;
    try { r = await renderEngine(name, engine); }
    catch (e) { console.log(`  ✗ 渲染失败：${e.message.slice(0, 100)}`); summary.push(false); continue; }
    summary.push(!!r.ok);
  }

  console.log(`\n=== 总汇总：${summary.filter(Boolean).length}/${summary.length} 引擎通过 ===\n`);
  process.exit(summary.every(Boolean) ? 0 : 1);
})();
