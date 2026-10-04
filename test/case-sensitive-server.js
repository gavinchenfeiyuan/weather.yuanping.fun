#!/usr/bin/env node
/*
 * 区分大小写的静态服务器 —— 用于本地复现「部署平台 / 仓库路径大小写」问题
 *
 * 背景：weather.yuanping.fun 的天气数据目录在磁盘上是 Data/（大写），
 *       但 git 索引里是小写 data/，Linux 类托管（EdgeOne 等）检出后即为小写。
 *       Windows / macOS 的文件系统不区分大小写，普通 http.server 无法暴露这个差异，
 *       导致「本地正常、线上 404」这类问题极难定位。
 *
 * 本脚本逐级用 readdirSync 比对请求路径与磁盘真实条目名，
 * 大小写不一致即返回 404，从而精确模拟 Linux 类托管的真实行为。
 *
 * 用法：
 *   node test/case-sensitive-server.js <站点根目录> [端口]
 * 示例（验证子目录部署）：
 *   node test/case-sensitive-server.js . 8770
 *   访问 http://127.0.0.1:8770/weather/index.html
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.argv[2] || ".");
const PORT = Number(process.argv[3] || 8768);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

// 逐级做大小写敏感解析：任何一级的名字大小写不匹配都视为不存在
function resolveCaseSensitive(root, urlPath) {
  const parts = decodeURIComponent(urlPath).split("/").filter(Boolean);
  let cur = root;
  for (const part of parts) {
    if (part === "." || part === "..") return null;        // 拒绝路径穿越
    let entries;
    try { entries = fs.readdirSync(cur); } catch (e) { return null; }
    if (!entries.includes(part)) return null;
    cur = path.join(cur, part);
  }
  return cur;
}

http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  let target = resolveCaseSensitive(ROOT, urlPath);

  // 目录请求 → 找目录下的 index.html（同样大小写敏感）
  if (target && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = resolveCaseSensitive(ROOT, urlPath.replace(/\/?$/, "/") + "index.html");
  }

  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 NOT FOUND (case-sensitive): " + urlPath);
    return;
  }

  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(target).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[case-sensitive server] http://127.0.0.1:${PORT}/  root=${ROOT}`);
  console.log(`提示：大小写不匹配的路径会返回 404（模拟 EdgeOne 等托管）`);
});
