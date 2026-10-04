const { chromium } = require("playwright");
const BASE = process.argv[2] || "http://127.0.0.1:8770/index.html";

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  p.on("console", m => { if (m.type() === "error") errs.push(m.text().slice(0, 90)); });
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  await p.evaluate(() => goView(1));
  await p.waitForTimeout(2500);
  await p.evaluate(() => { document.querySelectorAll(".d-row")[0].click(); document.querySelectorAll(".d-row")[1].click(); });
  await p.waitForTimeout(700);

  // 1. 各展示位实例统计
  const info = await p.evaluate(() => {
    const pick = (sel) => [...document.querySelectorAll(sel)].map(el => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height),
        href: el.querySelector("use")?.getAttribute("href"),
        vb: el.getAttribute("viewBox"), aria: el.getAttribute("aria-label"), vis: r.width > 0 };
    });
    return {
      heroMini: pick(".sun-row .moon-svg"),
      dailyRow: pick(".d-row .dw .moon-svg").slice(0, 4),
      detail: pick(".de-l .moon-svg"),
      astroBig: pick(".moon-big .moon-svg"),
      total: document.querySelectorAll("svg.moon-svg").length,
    };
  });
  console.log("=== 各展示位实例 ===");
  for (const [k, v] of Object.entries(info)) {
    if (k === "total") continue;
    if (!v.length) { console.log(`  ${k.padEnd(9)} (无)`); continue; }
    const s = v[0];
    console.log(`  ${k.padEnd(9)} ${String(v.length).padStart(2)} 个 · ${s.w}×${s.h}px · vb=${s.vb} · ${s.href} · ${s.aria} · 可见=${s.vis}`);
  }
  console.log(`  合计 ${info.total} 个实例`);

  // 2. 天文区大月相截图
  await p.locator("#moonBig").scrollIntoViewIfNeeded();
  await p.waitForTimeout(500);
  await p.locator(".astro-grid").screenshot({ path: "test/_shot-astro.png" });
  console.log("  已截图 test/_shot-astro.png");

  // 3. 多日预报（含展开详情）
  await p.locator(".d-row").first().scrollIntoViewIfNeeded();
  await p.waitForTimeout(500);
  const box = await p.evaluate(() => {
    const rs = [...document.querySelectorAll(".d-row")].slice(0, 3);
    const a = rs[0].getBoundingClientRect(), c = rs[2].getBoundingClientRect();
    return { x: Math.max(0, a.left - 10), y: Math.max(0, a.top - 10),
      width: Math.min(a.width + 20, innerWidth), height: c.bottom - a.top + 20 };
  });
  await p.screenshot({ path: "test/_shot-daily.png", clip: box });
  console.log("  已截图 test/_shot-daily.png");

  // 4. 放大对比图
  //    注意：不能用 page.setContent 重建文档 —— 那样 defs 里的渐变/mask 会因 id 作用域变化而失效
  //    （实测会渲染成空白）。改为在原页面内临时插入放大容器，截图后再移除。
  const Z = 2.2, sizes = [14, 17, 22, 54];
  const mounted = await p.evaluate(({ Z, sizes }) => {
    const phases = ["new", "waxing-crescent", "first-quarter", "waxing-gibbous",
      "full", "waning-gibbous", "last-quarter", "waning-crescent"];
    // 横向排布：每个相位一行，仅 54px 一列，便于一次看完 8 相
    const zh = { "new": "新月", "waxing-crescent": "蛾眉月", "first-quarter": "上弦月", "waxing-gibbous": "盈凸月",
      "full": "满月", "waning-gibbous": "亏凸月", "last-quarter": "下弦月", "waning-crescent": "残月" };
    const host = document.createElement("div");
    host.id = "__moon_zoom";
    host.style.cssText = "position:fixed;left:0;top:0;z-index:99999;background:#1d2637;padding:16px;font-family:'PingFang SC',sans-serif";
    const Z2 = 3.2;                    // 单列放大倍数（比多列版更大，便于看清细节）
    const SZ = 24;                     // 单列统一用 24px（介于实际 14~54px 之间）
    const big = SZ * Z2;
    let html = `<div style="font-size:14px;font-weight:600;color:#eef2ff;margin-bottom:4px">月相图标 · 全部 8 相（×${Z2} 放大）</div>
      <div style="font-size:11px;color:#9aa7c7;margin-bottom:12px">按 24px 渲染后放大 ${Z2} 倍，一次看全；背景为站点主题色。</div>
      <div style="display:flex;gap:14px;flex-wrap:wrap">`;
    phases.forEach(ph => {
      const id = "moon-" + ph;
      html += `<div style="text-align:center">
        <div style="width:${big}px;height:${big}px;position:relative;background:#1d2637">
          <svg viewBox="0 0 32 32" style="position:absolute;left:0;top:0;width:${SZ}px;height:${SZ}px;transform:scale(${Z2});transform-origin:0 0"><use href="#${id}"/></svg>
        </div>
        <div style="color:#9aa7c7;font-size:11px;margin-top:6px">${zh[ph]}</div>
      </div>`;
    });
    html += `</div>`;
    host.innerHTML = html;
    document.body.appendChild(host);
    const r = host.getBoundingClientRect();
    // 统计各格实际渲染出的非透明内容（用 getBBox 无法穿透 mask，改用像素密度近似：
    // 这里只报告容器就绪，像素判定交给截图后的人工核对）
    return { n: host.querySelectorAll("svg").length, w: Math.ceil(r.width), h: Math.ceil(r.height) };
  }, { Z, sizes });
  await p.waitForTimeout(700);
  const zbox = await p.evaluate(() => {
    const r = document.getElementById("__moon_zoom").getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });
  await p.screenshot({ path: "test/moon-zoom.png", clip: zbox });
  await p.evaluate(() => { const h = document.getElementById("__moon_zoom"); if (h) h.remove(); });
  console.log(`  已截图 test/moon-zoom.png（${mounted.n} 个放大图标，${mounted.w}×${mounted.h}）`);

  console.log(`\nERRORS: ${errs.length ? errs.join(" | ") : "none"}`);
  await b.close();
})();
