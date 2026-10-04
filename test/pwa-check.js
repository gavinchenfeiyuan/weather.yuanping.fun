#!/usr/bin/env node
/*
 * PWA 自动化验证 —— 覆盖 Service Worker 注册、缓存键、离线可用性、图标与 manifest
 *
 * 依赖：Playwright（本机已装在 managed node workspace）
 * 运行（先起一个静态服务器，建议用 case-sensitive-server.js）：
 *   NODE_PATH="C:/Users/admin/.workbuddy/binaries/node/workspace/node_modules" \
 *     node test/pwa-check.js http://127.0.0.1:8770/ [--offline-test]
 *
 * 参数：
 *   第 1 个：站点基址（必须以 / 结尾）
 *   --offline-test：额外做「首访后断网冷启动」验证（耗时更长，但最贴近真实场景）
 *
 * 校验点：
 *   1. SW 注册成功且作用域限定在站点目录内（子目录部署时不能被提升到域名根）
 *   2. 缓存键全部落在站点目录下（不出现根路径污染）
 *   3. 页面导航与 Data/*.json 在断网时可从缓存返回
 *   4. manifest / favicon / apple-touch-icon 全部可访问（HTTP 200）
 *   5. 业务功能未被 PWA 代码破坏（预览卡、切页、月相 svg 等）
 */
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8765/";
const DO_OFFLINE = process.argv.includes("--offline-test");
const SITE_PATH = new URL(BASE).pathname;      // 例如 /weather/

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const httpErrors = [];
  page.on("response", r => { if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`); });
  const pageErrors = [];
  page.on("pageerror", e => { if (!/503|offline/.test(e.message)) pageErrors.push(e.message.slice(0, 120)); });

  console.log(`\n=== PWA 验证 @ ${BASE} ===\n`);

  console.log("[1] 加载页面并等待 SW 接管");
  await page.goto(BASE + "index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(DO_OFFLINE ? 10000 : 6000);   // 首访需等数据预热

  console.log("\n[2] Service Worker");
  const sw = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.ready;
    return { supported: true, scope: reg.scope, scriptURL: reg.active ? reg.active.scriptURL : null,
      state: reg.active ? reg.active.state : null, controlled: !!navigator.serviceWorker.controller };
  });
  if (!sw.supported) {
    check("浏览器支持 Service Worker", false, "当前环境不支持");
  } else {
    check("SW 已激活", sw.state === "activated", `state=${sw.state}`);
    check("SW 作用域限定在站点目录", sw.scope.endsWith(SITE_PATH), sw.scope);
    check("SW 脚本路径正确", /\/sw\.js$/.test(sw.scriptURL || ""), sw.scriptURL);
    check("当前页已被 SW 接管", sw.controlled);
  }

  console.log("\n[3] 缓存内容");
  const cachesInfo = await page.evaluate(async () => {
    const out = {};
    for (const n of await caches.keys()) {
      const c = await caches.open(n);
      out[n] = (await c.keys()).map(r => new URL(r.url).pathname);
    }
    return out;
  });
  const allKeys = Object.values(cachesInfo).flat();
  console.log(`      缓存桶：${Object.keys(cachesInfo).join(", ") || "(空)"}`);
  Object.entries(cachesInfo).forEach(([n, ks]) => console.log(`        ${n}: ${ks.length} 条`));
  const polluted = allKeys.filter(k => !k.startsWith(SITE_PATH));
  check("缓存键无根路径污染", polluted.length === 0, polluted.length ? polluted.slice(0, 3).join(", ") : `${allKeys.length} 条全部在 ${SITE_PATH} 下`);
  const staticKeys = allKeys.filter(k => !/\/data\//i.test(k));
  const dataKeys = allKeys.filter(k => /\/data\//i.test(k));
  check("静态资源已缓存", staticKeys.length >= 7, `${staticKeys.length} 条`);
  check("天气数据已预热（保证首访后断网可用）", dataKeys.length >= 24,
    `${dataKeys.length} 条${dataKeys.length < 24 ? "（若删除 sw.js 中的预热逻辑，此项会失败）" : ""}`);

  console.log("\n[4] manifest 与图标");
  const assets = await page.evaluate(async () => {
    const hrefs = [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')]
      .map(l => l.getAttribute("href"));
    hrefs.push("./manifest.json");
    const out = [];
    for (const h of hrefs) {
      try { const r = await fetch(h); out.push({ h, status: r.status }); }
      catch (e) { out.push({ h, status: "ERR" }); }
    }
    const mf = await fetch("./manifest.json").then(r => r.json());
    return { files: out, manifest: {
      start_url: mf.start_url, scope: mf.scope,
      icons: mf.icons.length,
      hasMaskable: mf.icons.some(i => (i.purpose || "").includes("maskable")),
      shortcuts: mf.shortcuts.length } };
  });
  assets.files.forEach(f => console.log(`        ${f.status === 200 ? "✓" : "✗"} ${String(f.h).padEnd(30)} ${f.status}`));
  check("全部图标与 manifest 可访问", assets.files.every(f => f.status === 200));
  check("manifest 使用相对路径", assets.manifest.start_url === "./" && assets.manifest.scope === "./",
    `start_url=${assets.manifest.start_url} scope=${assets.manifest.scope}`);
  // icons 至少 3 个且含 maskable；允许后续追加其它尺寸
  check("manifest 图标与快捷方式齐全",
    assets.manifest.icons >= 3 && assets.manifest.shortcuts === 3 && assets.manifest.hasMaskable,
    `icons=${assets.manifest.icons}（含 maskable=${assets.manifest.hasMaskable}） shortcuts=${assets.manifest.shortcuts}`);

  console.log("\n[5] 业务功能未被破坏");
  const biz = await page.evaluate(() => ({
    cards: document.querySelectorAll(".cmp-card").length,
    pager: document.querySelectorAll("#pager i").length,
    sprite: document.querySelectorAll('body > svg symbol[id^="moon-"]').length,
    fn: ["goView", "redrawCharts", "moonSvg", "memLoad", "drawFX"].every(n => typeof window[n] === "function"),
  }));
  check("对比首页预览卡渲染", biz.cards === 3, `${biz.cards} 张`);
  check("翻页指示点存在", biz.pager === 4, `${biz.pager} 个`);
  check("月相 sprite 完整", biz.sprite === 8, `${biz.sprite} 个 symbol`);
  check("核心函数齐全", biz.fn);
  await page.evaluate(() => goView(1));
  await page.waitForTimeout(3000);
  // 月相只在城市页渲染（对比首页没有），故切页后再统计实例
  const nav = await page.evaluate(() => ({
    cur: curCity, temp: document.getElementById("nowTemp")?.textContent,
    idx: document.querySelectorAll("#idxGrid .idx").length,
    moon: document.querySelectorAll("svg.moon-svg").length,
  }));
  check("城市详情页可正常切换并渲染", nav.cur === "上海" && !!nav.temp && nav.idx > 0,
    `${nav.cur} ${nav.temp}° 指数=${nav.idx} 月相=${nav.moon}`);
  check("月相图标已在城市页渲染", nav.moon > 0, `${nav.moon} 个实例`);

  if (DO_OFFLINE) {
    console.log("\n[6] 离线冷启动（首访后断网 + 整页刷新）");
    await ctx.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(8000);
    const off = await page.evaluate(() => ({
      title: document.title,
      cards: document.querySelectorAll(".cmp-card").length,
      temps: [...document.querySelectorAll(".cv-temp")].map(e => e.textContent.trim()),
      decoy: /ROOT-DECOY/.test(document.body.textContent || ""),
    }));
    check("离线可加载页面（未误取上层/根目录页面）", !off.decoy, `title="${off.title}"`);
    check("离线可见真实天气数据", off.cards === 3 && off.temps.every(t => /°/.test(t)),
      `${off.cards} 张卡 ${JSON.stringify(off.temps)}`);
    await ctx.setOffline(false);
  }

  console.log("\n[7] 控制台");
  const fatal = pageErrors.filter(e => !/sw\.js|404|Failed to load resource/i.test(e));
  check("无未捕获异常", fatal.length === 0, fatal.slice(0, 3).join(" | ") || "无");
  const realHttpErrors = httpErrors.filter(e => !/RegisteredLogo|sw\.js/.test(e));
  check("无非预期 HTTP 错误", realHttpErrors.length === 0, realHttpErrors.slice(0, 3).join(" | ") || "无");

  const passed = results.filter(r => r.ok).length;
  console.log(`\n=== 汇总：${passed}/${results.length} 通过 ${passed === results.length ? "✓" : "✗"} ===\n`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
})();
