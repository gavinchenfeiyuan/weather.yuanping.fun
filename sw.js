const VERSION = "v1-20261004";
const STATIC_CACHE = `weather-static-${VERSION}`;
const DATA_CACHE = `weather-data-${VERSION}`;
const STATIC_ASSETS = ["./", "./index.html", "./manifest.json", "./Pic/favicon.svg",
  "./Pic/favicon-32.png", "./Pic/icon-192x192.png", "./Pic/icon-512x512.png"];
// 离线时的兜底首页（相对 Service Worker 自身位置解析，兼容子目录部署）
const OFFLINE_PAGE = "./index.html";

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== STATIC_CACHE && k !== DATA_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => warmDataCache())   // 接管页面后再预热，不拖慢接管速度
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // 跨域请求（jsdelivr / zeoseven 等 CDN）不拦截，直接放行
  if (url.origin !== self.location.origin) return;
  // 天气数据（Data/*.json）→ network-first，断网回退缓存
  if (url.pathname.endsWith(".json") && /\/data\//i.test(url.pathname)) {
    event.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }
  // 页面导航 → network-first，断网回退缓存首页
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then(c => c.put(OFFLINE_PAGE, clone));
        }
        return res;
      }).catch(() => caches.match(OFFLINE_PAGE).then(r => r || caches.match("./")))
    );
    return;
  }
  // 其余静态资源（HTML/图标/CSS/JS）→ cache-first
  event.respondWith(cacheFirst(req, STATIC_CACHE));
});

/* ---- 天气数据预热 ----
   页面的数据请求发生在 Service Worker 接管之前，若不预热，用户「首次访问后断网」
   会看不到任何数据——而离线查看恰恰是天气应用的核心场景。
   24 个 JSON 合计约 400KB，仅在未缓存时下载，失败不影响任何功能。
   注意：城市目录在部分静态托管上会被小写化（Data → data），故先探测可用前缀。 */
const WARM_CITIES = ["上海", "莆田", "厦门"];
const WARM_FILES = ["realtime_weather", "realtime_aqi", "hourly_forecast", "daily_forecast",
  "daily_aqi_forecast", "minutely_precip", "weather_index", "weather_alert"];
const DATA_DIRS = ["./Data/", "./data/"];
let DATA_DIR = null;

async function resolveDataDir() {
  if (DATA_DIR) return DATA_DIR;
  for (const dir of DATA_DIRS) {
    try {
      const res = await fetch(dir + encodeURIComponent(WARM_CITIES[0]) + "/" + WARM_FILES[0] + ".json");
      if (res && res.ok) { DATA_DIR = dir; return dir; }
    } catch (e) { /* 换下一个候选前缀 */ }
  }
  return null;
}

async function warmDataCache() {
  try {
    const dir = await resolveDataDir();
    if (!dir) return;
    const cache = await caches.open(DATA_CACHE);
    await Promise.allSettled(WARM_CITIES.flatMap(city =>
      WARM_FILES.map(async file => {
        const url = dir + encodeURIComponent(city) + "/" + file + ".json";
        if (await cache.match(url)) return;               // 已缓存则不重复下载
        const res = await fetch(url);
        if (res && res.ok) await cache.put(url, res.clone());
      })
    ));
  } catch (e) { /* 预热失败不影响任何功能 */ }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503, headers: { "Content-Type": "application/json" }
    });
  }
}

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    return new Response("", { status: 504 });
  }
}
