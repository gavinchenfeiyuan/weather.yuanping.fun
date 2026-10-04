# test/ —— 本地验证脚本

部署相关改动（PWA、路径、缓存、图标）在本地验证用。**不参与站点构建**，但随仓库一起部署，
若希望产物干净可在托管侧忽略本目录。

先起一个静态服务器，再运行各检查脚本：

```bash
# 推荐用区分大小写的服务器（见下方说明）
node test/case-sensitive-server.js . 8770

# 统一入口：PWA 全项检查（加 --offline-test 做离线验证）
NODE_PATH="C:/Users/admin/.workbuddy/binaries/node/workspace/node_modules" \
  node test/pwa-check.js http://127.0.0.1:8770/
```

---

## 一、PWA 相关

### `case-sensitive-server.js` —— 区分大小写的静态服务器

**为什么需要**：Windows / macOS 文件系统不区分大小写，普通 `python -m http.server` 无法暴露路径大小写差异。
而 EdgeOne 等静态托管跑在 Linux 上（区分大小写）。本仓库里：

- 磁盘上是 `Data/`（大写）
- git 索引里是 `data/`（小写）→ **线上检出的就是小写**

代码里 `PREFIXES` 与 `sw.js` 的 `resolveDataDir()` 都做了双前缀探测来兼容两种情形。
本脚本逐级比对磁盘真实条目名，可在本地精确复现线上的大小写行为。

```bash
node test/case-sensitive-server.js . 8770
curl -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8770/data/%E4%B8%8A%E6%B5%B7/realtime_weather.json"   # → 404（磁盘是 Data/）
curl -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8770/Data/%E4%B8%8A%E6%B5%B7/realtime_weather.json"  # → 200
```

**验证子目录部署**：把站点复制到 `<临时目录>/weather/`，用该服务器指向临时目录，
并在临时目录根放一个内容明显不同的 `index.html` 作诱饵（标题含 `ROOT-DECOY`）——
若页面在断网或异常时取到诱饵，说明代码里还残留绝对路径 `/`。

### `pwa-check.js` —— PWA 自动化验证

| 组 | 检查内容 |
|----|---------|
| 2 | SW 注册 / 激活状态 / **作用域是否被限制在站点目录** / 脚本路径 / 是否接管页面 |
| 3 | 缓存桶内容、**缓存键有无根路径污染**、静态资源条数、天气数据预热条数 |
| 4 | 全部图标与 manifest 的 HTTP 状态、manifest 是否相对路径、icons/shortcuts 数量 |
| 5 | 业务功能回归：预览卡 / 翻页指示点 / 月相 sprite / 核心函数 / 城市详情页渲染 |
| 6 | `--offline-test`：断网冷启动能加载页面且显示真实天气数据 |
| 7 | 无未捕获异常、无非预期 HTTP 错误 |

退出码：全部通过 `0`，有失败项 `1`（可用于 CI 或 pre-deploy 钩子）。

---

## 二、月相图标相关

月相使用**渐变 + 月海纹理 + mask 裁切**的 SVG sprite（8 个 `<symbol>`，`viewBox 0 0 32 32`）。

### ⚠️ 两个必须知道的陷阱

#### 陷阱 1：sprite 容器不能用 `display:none`

`display:none` 的 `<svg>` 会让其中的 **`<radialGradient>` 与 `<mask>` 全部失效**，
表现为图标整体不显示或显示为完整圆（mask 未裁切）。

正确做法——**视觉隐藏但保持参与渲染**：

```html
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"
     style="position:absolute;overflow:hidden" aria-hidden="true" focusable="false">
```

#### 陷阱 2：mask 必须显式指定区域

`<mask>` 的默认区域是 `-10% / 120%`（**相对被遮罩元素的 bbox 百分比**）。
跨 SVG 引用（sprite → `<use>`）时 bbox 解析失效，mask 区域塌缩为空，
**图形被完全裁掉 → 全黑**。

必须显式给定绝对矩形：

```html
<mask x="0" y="0" width="32" height="32" id="mCrescent" maskUnits="userSpaceOnUse">
```

> 这两个坑在 Chromium 与 WebKit 下都会出现，且**不报任何错误**，只能靠像素级验证发现。

#### 陷阱 3：验证手法本身的限制

- **不能用** `data:` / `blob:` URL 把 SVG 交给 `<img>` 再 `drawImage` 到 canvas ——
  **WebKit 下会渲染成空白**（`getImageData` 全 0），测不出真实效果。
- **不能用** `use.getBBox()` 判断 mask 是否生效 —— 它返回的是**遮罩前**的几何，恒为完整圆。
- **正确做法**：在页面内插入真实 SVG 实例 → **截图** → 逐格分析像素（本目录脚本已实现）。
- 生成放大对比图时**不能用 `page.setContent()` 重建文档** ——
  `defs` 里的 id 作用域变化会导致渐变/mask 失效、整图空白；
  应在**原页面内**临时插入放大容器，截完再移除。
- WebKit 下 `locator.screenshot()` / `element.screenshot()` 会长时间等待"元素稳定"直至超时，
  应改用 `page.screenshot({ clip })`。

### `moon-render-check.js` —— 渲染验证（主力脚本）

在页面内挂载 8 个真实 SVG 实例 → 截图 → 用 Chromium 解码 PNG 逐格统计：

- **亮面占比**（相对满月）应匹配各相位：新月 0 → 蛾眉月 0.40 → 上弦 0.50 → 盈凸 0.90
  → 满月 1.00 → 亏凸 0.90 → 下弦 0.50 → 残月 0.40
- **亮面重心 x**：蛾眉月/上弦/盈凸 应偏右，亏凸/下弦/残月 应偏左（北半球约定）
- **冷暖判据**：亮面暖色（`r - b > 25`），暗面冷色（`b - r > 15`）；
  格子底色用**纯黑**（`r ≈ b`，两边都不计入），避免页面深色主题干扰

```bash
node test/moon-render-check.js http://127.0.0.1:8770/index.html --engine=chromium
node test/moon-render-check.js http://127.0.0.1:8770/index.html --engine=webkit   # 较慢，需放宽超时
node test/moon-render-check.js http://127.0.0.1:8770/index.html --png=check.png   # 另存截图留档
```

中间截图默认写到**系统临时目录**并在分析后自动删除（`--keep` 可改为落在本目录），
所以运行本脚本**不会在仓库里留下任何文件**。

退出码：`0` 全部通过；`1` 有异常或引擎运行失败。

> 若日后更换图标几何，**务必保留"占比"与"朝向"两项断言**——
> 历史上曾因用圆弧连接圆的两个对径极点（半径被 SVG 规范静默放大到 9）导致
> 月牙**面积退化为 0**、凸月退化成接近满月；这类退化在视觉上极难察觉。

### `moon-page-shot.js` —— 真实页面核对 + 截图

在真实页面中检查四处展示位的实例（尺寸 / `viewBox` / `aria-label`），并截图供人工看外观：

- `shot-astro.png`：天文区大月相（54px）
- `shot-daily.png`：多日预报行（17px）+ 展开的昼夜详情
- `shot-zoom.png`：全部 8 相 ×3.2 倍放大的对照图（用于肉眼核对形态）

```bash
node test/moon-page-shot.js http://127.0.0.1:8770/index.html
node test/moon-page-shot.js http://127.0.0.1:8770/index.html --out=./screenshots   # 指定输出目录留档
```

> **截图默认写入系统临时目录**（运行结束会打印具体路径），因此本脚本**不会在仓库里留下任何文件**。
> 需要留档时用 `--out=目录` 显式指定。

**月相展示位与尺寸**（改动时保持这些不变）：

| 位置 | 尺寸 |
|------|------|
| hero 副卡 `.sun-row` | 22px |
| 多日预报行首 `.d-row .dw` | 17px |
| 昼夜详情标签 `.de-l` | 14px |
| 天文区大月相 `.moon-big` | 54px |

---

## 注意

- 这些脚本只读站点文件，不会修改站点内容。
- 浏览器由 Playwright 启动（独立 profile，不影响本机浏览器）。
- **改了图标 / 缓存策略后建议各跑一遍**：
  `moon-render-check.js`（渲染）+ `moon-page-shot.js`（尺寸与外观）+ `pwa-check.js --offline-test`（离线）。
