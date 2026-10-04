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
 *   node test/moon-render-check.js <页面URL> [--engine=chromium|webkit|both] [--png=输出路径]
 * 退出码：0 全部符合预期；1 有异常
 */
const { chromium, webkit } = require("playwright");
const fs = require("fs");
const path = require("path");

const PAGE = process.argv[2] || "http://127.0.0.1:8770/index.html";
const engArg = (process.argv.find(a => a.startsWith("--engine=")) || "").split("=")[1] || "both";
const pngArg = (process.argv.find(a => a.startsWith("--png=")) || "").split("=")[1] || null;

const CELL = 96;   // 每个相位的截图格尺寸
const PHASES = [
  ["moon-new", "新月", 0.00, 0],
  ["moon-waxing-crescent", "蛾眉月", 0.40, +1],
  ["moon-first-quarter", "上弦月", 0.50, +1],
  ["moon-waxing-gibbous", "盈凸月", 0.90, +1],
  ["moon-full", "满月", 1.00, 0],
  ["moon-waning-gibbous", "亏凸月", 0.90, -1],
  ["moon-last-quarter", "下弦月", 0.50, -1],
  ["moon-waning-crescent", "残月", 0.40, -1],
];

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
      let lit = 0, dark = 0, any = 0, sumx = 0;
      for (let y = 0; y < H; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * W + x) * 4;
          const r = d[o], g = d[o + 1], bb = d[o + 2], a = d[o + 3];
          if (a < 40) continue;                       // 透明背景（截图已 omitBackground）
          any++;
          // 亮面 = 暖色（月色渐变 #FBF3DD→#B99A5C，r 明显大于 b）
          // 暗面 = 冷色（#3A4A63 叠透明，b 明显大于 r）
          // 用冷暖对比而非绝对亮度，避免受渐变明暗影响
          if (r - bb > 25) { lit++; sumx += (x - x0); }
          else if (bb - r > 15) dark++;
        }
      }
      out.push({ lit, dark, any, cx: lit ? sumx / lit / cell : null });
    }
    return { out, W, H };
  }, { b64, cell: CELL, n: cells });
  await b.close();
  return stats;
}

async function renderEngine(engineName, engine) {
  const b = await engine.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  p.on("pageerror", e => errs.push(e.message.slice(0, 80)));
  // WebKit 加载本页偶发较慢（外部字体/图标 CDN），放宽超时
  await p.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 90000 });
  await p.waitForTimeout(2600);

  // 在页面内插入真实 SVG 实例（用页面自己的渲染函数，保证与生产一致）
  const mounted = await p.evaluate(({ phases, cell }) => {
    const host = document.createElement("div");
    host.id = "__moon_probe";
    // 放在视口内，每格用纯黑底：黑色 r≈b，既不算暖色也不算冷色，不会干扰判据；
    // （不能依赖 omitBackground —— 对 fixed 元素无效，页面内容仍会透出）
    host.style.cssText = `position:fixed;left:0;top:0;z-index:99999;display:flex;background:#000;`;
    phases.forEach(([id, , , ]) => {
      const wrap = document.createElement("div");
      wrap.style.cssText = `width:${cell}px;height:${cell}px;display:flex;align-items:center;justify-content:center;background:#000`;
      // 用页面真实渲染函数（phase → symbol id）
      const phaseKey = Object.keys(window.MOON_ID || {}).find(k => window.MOON_ID[k] === id);
      wrap.innerHTML = typeof window.moonSvg === "function" && phaseKey
        ? window.moonSvg(phaseKey).replace('class="moon-svg"', `class="moon-svg" style="width:${cell - 20}px;height:${cell - 20}px"`)
        : `<svg class="moon-svg" viewBox="0 0 32 32" style="width:${cell - 20}px;height:${cell - 20}px"><use href="#${id}"/></svg>`;
      host.appendChild(wrap);
    });
    document.body.appendChild(host);
    const n = host.querySelectorAll("svg").length;
    const r = host.getBoundingClientRect();
    return { n, w: Math.round(r.width), h: Math.round(r.height) };
  }, { phases: PHASES, cell: CELL });

  const shotPath = path.join(__dirname, `_render-${engineName}.png`);
  // 用 page.screenshot + 坐标裁剪，而非 locator.screenshot：
  // WebKit 下对动态挂载的元素做 locator.screenshot 会长时间等待"元素稳定"直至超时。
  const box = await p.evaluate(({ cell, n }) => {
    const h = document.getElementById("__moon_probe");
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(cell * n), height: Math.round(cell) };
  }, { cell: CELL, n: PHASES.length });
  await p.screenshot({ path: shotPath, clip: box });
  await p.evaluate(() => { const h = document.getElementById("__moon_probe"); if (h) h.remove(); });
  await b.close();
  return { mounted, shotPath, errs };
}

(async () => {
  const engines = engArg === "both" ? [["chromium", chromium], ["webkit", webkit]] : [[engArg, engArg === "webkit" ? webkit : chromium]];
  const summary = [];

  for (const [name, engine] of engines) {
    console.log(`\n===== ${name} =====`);
    let r;
    try { r = await renderEngine(name, engine); }
    catch (e) { console.log(`  ✗ 渲染失败：${e.message.slice(0, 100)}`); summary.push(false); continue; }
    console.log(`  挂载实例 ${r.mounted.n} 个，截图 ${r.mounted.w}×${r.mounted.h} → ${path.basename(r.shotPath)}`);
    if (r.errs.length) console.log(`  控制台错误：${r.errs.join(" | ")}`);

    const res = await analyzePng(r.shotPath, PHASES.length);
    if (res.error) { console.log(`  ✗ ${res.error}`); summary.push(false); continue; }
    const stats = res.out;
    const full = stats[4].lit || 1;
    console.log("\n  相位        期望占比  实测占比  亮度px  暗度px  重心x  朝向  结果");
    let ok = 0;
    PHASES.forEach(([id, zh, expCover, expSide], i) => {
      const s = stats[i];
      const cover = s.lit / full;
      const cx = s.cx;
      // 朝向判据：以 0.5 为界，但留 ±0.008 死区（抗锯齿噪声）；
      // 凸月重心仅偏离 0.017 左右，故不能用大死区，否则会被误判为居中
      const side = cx === null ? 0 : (Math.abs(cx - 0.5) < 0.008 ? 0 : (cx > 0.5 ? 1 : -1));
      const coverOk = Math.abs(cover - expCover) <= 0.08;
      const sideOk = expSide === 0 ? true : side === expSide;
      const pass = coverOk && sideOk;
      if (pass) ok++;
      console.log(`  ${zh.padEnd(6)} ${expCover.toFixed(2).padStart(8)} ${cover.toFixed(3).padStart(8)} ${String(s.lit).padStart(7)} ${String(s.dark).padStart(7)}  ${cx === null ? "  -  " : cx.toFixed(3)}  ${(side === 0 ? "中" : side > 0 ? "右" : "左").padEnd(4)} ${pass ? "✓" : "✗" + (!coverOk ? " 占比" : "") + (!sideOk ? " 朝向" : "")}`);
    });
    console.log(`  → ${ok}/${PHASES.length} 通过 ${ok === PHASES.length ? "✓" : "✗"}`);
    summary.push(ok === PHASES.length);

    if (pngArg && name === "chromium") fs.copyFileSync(r.shotPath, pngArg);
  }

  console.log(`\n=== 总汇总：${summary.filter(Boolean).length}/${summary.length} 引擎通过 ===\n`);
  process.exit(summary.every(Boolean) ? 0 : 1);
})();
