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

**当前实现（动态绘制）**：图标不再是 8 个静态 `<symbol>`，而是按数据实时生成。

- 数据源：`Data/<城市>/moon_phase.json` → `days[] = { date:"20261010", value:0.98, illumination:0, name:"残月", icon:"807" }`
  - `value` 0–1：`0`=新月、`0.25`=上弦、`0.5`=满月、`0.75`=下弦（**决定图形**）
  - `name` 中文名（**决定文字**，如"残月""蛾眉月"）
  - `illumination` 照度百分比（暂未使用）
- 图形：`moonPhasePath(value)` 生成「外圆弧 + 椭圆弧」闭合路径 → 作为 `<clipPath>` 裁切 `#moonBody`（渐变月亮本体）
- 亮面朝向：`value < 0.5` 亮面在**右**（北半球盈月），`value > 0.5` 在**左**
- 取数优先级：`moon_phase.json` → 缺失时回退 `astro.moonPhase` 的 8 相位映射（`MOON_VALUE_MAP`）

`sprite` 只保留 `<defs>`（4 个渐变 + `<g id="moonBody">`），**没有 `<symbol>` / `<mask>`**
（相位裁切改由 JS 逐实例生成 `clipPath` 完成）。

### ⚠️ 动态绘制的三个注意点

#### 注意 1：`clipPath` 的 id 必须逐实例唯一

`moonSvgByValue()` 用 `moonUid` 自增生成 `mp1 / mp2 / …`。
**同一段字符串被插值两次 = 两个实例共用一个 id**，`url(#id)` 会取文档中**第一个**同名元素，
于是两个图标画出同一个形状。`renderDaily` 里行首与详情行必须**各调一次** `moonSvgByValue()`。

#### 注意 2：极小月牙要有可见下限（否则看着"空月"）

亮面比例 = `(1-cos(2πv))/2`。`value = 0.98` → **0.4%**，17px 图标里月牙宽约 **0.05px**，
肉眼完全看不到，只有一圈暗底 → 用户会报"月相是空的"（10/10 就是这种情况，当天照度本来就是 0%）。

修法：`MOON_MIN_LIT = 0.06` —— 除严格的 `0`/`1`（真新月，应全暗）外，
把 `cos(2πv)` 夹到 `1 - 2×0.06`，保证月牙至少约占半径的 6%（17px 下 ≈ 0.7px 可见细线）。

#### 注意 3：别用 `<symbol>`

早期版本用 8 个 `<symbol id="moon-*">` 做静态相位图标，已废弃。
现在只保留 `<defs>`，避免"改了数据但图标不变"的隐性错误。

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

#### 陷阱 4：本机 `http_proxy` 会让 WebKit 静默失败（重要）

本机装了 Clash，shell 里有 `http_proxy` / `https_proxy` 环境变量。

- **Chromium** 默认忽略这些环境变量 → 访问 `127.0.0.1` 正常；
- **WebKit** 会照用 → 连本地 `127.0.0.1:8770` 也被送进代理，拿回 **HTTP 502**，
  页面脚本**根本没执行**。表现极具误导性：`goView` / `moonSvgByValue` 是 `undefined`、
  实例数 0，看起来像"页面坏了"，其实是测试环境的锅。

解决：脚本开头设置 `NO_PROXY=127.0.0.1,localhost,::1`（`moon-render-check.js` 已内置）。
命令行单独跑时也可显式加：`NO_PROXY=127.0.0.1,localhost,::1 node test/xxx.js ...`。
排查手法：`curl --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:8770/index.html`，
若返回 502/000 而浏览器能打开，就是代理干的。

#### 陷阱 5：Windows 下 Node 收不到 POSIX 信号

中间截图（`moon-render-*.png` 写系统临时目录）靠正常路径的 `unlink` 清理。
但进程被**强杀**（超时终止等）时那行执行不到，会留孤儿文件。

- Windows 没有 POSIX 信号，`process.on("SIGTERM")` **基本不触发** —— 光靠退出钩子不可靠。
- 可靠做法：**下次启动时清扫孤儿**。`moon-render-check.js` 的 `sweepOrphans()`
  在开头删掉临时目录里 `mtime` 早于本次启动的同类截图，并打印清理条数。
- 注意 `os.tmpdir()` 在 Windows 是 `C:\Users\<用户>\AppData\Local\Temp`，
  不是 Git Bash 的 `/tmp` 字面路径（两者通常指向同一处，但脚本内一律用 `os.tmpdir()`）。
- `--png=` 另存必须**赶在删除之前**执行，否则复制不到文件（早期版本有这个 bug）。

### `moon-render-check.js` —— 渲染验证（主力脚本）

覆盖两类判据：

**A. DOM 结构**（真实页面，非探针）

- 22 个 `clipPath` 的 id 必须**两两不同** —— id 重复时 `url(#id)` 会取到文档里第一个同名元素，
  两个图标会画出**同一个形状**。历史上踩过：`renderDaily` 模板把同一段图标字符串插值了两次，
  22 个实例只有 12 个唯一 id。修法是两处各调一次 `moonSvgByValue()`。
- 同一天的行首图标与详情行图标必须**同形**；多天的形状种数须 ≥ 「夹取归并后的期望下界」。
  注意：`path` 里 `rx` 是全精度浮点，理论上相同的值（如 0.92 与 0.08）会因计算路径不同
  产生末位差异而被算作两种，视觉上无差别 —— 故只判下界，真正的退化（所有天同形）必被捕获。

**B. 几何**（探针，8 标准相位 + 边界 + 真实数据值）

在页面内挂载真实 SVG 实例 → 截图 → 用 Chromium 解码 PNG 逐格统计：

- **亮面占比**应匹配 `(1-cos(2πv))/2`：新月 0 → 上弦 0.50 → 满月 1.00
- **亮面重心 x**：月牙看**亮面**重心（盈→右、亏→左）；凸月看**暗面**重心（在对侧）；
  半圆不判。亮/暗面不足约 3%（<1px 宽）时不判朝向 —— 否则会把"极细月牙"误判为朝向错误。
- **冷暖判据**：亮面暖色（`r - b > 25`），暗面冷色（`b - r > 15`）；
  格子底色用**纯黑**（`r ≈ b`，两边都不计入），避免页面深色主题干扰
- 探针容器宽度 = 格数 × 格宽，**必须小于 viewport 宽度**，否则越界格拿到空白像素

```bash
node test/moon-render-check.js http://127.0.0.1:8770/index.html --engine=chromium
node test/moon-render-check.js http://127.0.0.1:8770/index.html --engine=webkit   # 较慢，需放宽超时
node test/moon-render-check.js http://127.0.0.1:8770/index.html --png=check.png   # 另存截图留档
```

中间截图默认写到**系统临时目录**并在分析后自动删除（`--keep` 可改为落在本目录），
脚本**启动时还会清扫上次被中断遗留的孤儿截图**（打印清理条数），
所以运行本脚本**不会在仓库里留下任何文件**，系统临时目录也不会越积越多。

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
