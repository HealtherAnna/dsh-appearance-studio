# 开发说明

面向要改这个插件的人。**用户文档见 [README.md](../README.md)**。

---

## 项目结构

```
dsh-skin-studio/
├── package.json          # dsh.bundle.patch + dsh.client 两个声明
├── cordis.patch.yml      # 宿主侧挂载行
├── lib/index.js          # 宿主：设置持久化、图片与 ICO 处理、图标落地、HTTP 路由
├── client/client.js      # 客户端：设置页里的「外观工作室」面板（React）
├── assets/panel.css      # 面板样式，由宿主作为 index-inject 的 style 行注入
└── test/
    ├── smoke.mjs         # 41 项：mock cordis 上下文 + 真实 HTTP 服务器
    └── icon-scale-check.mjs  # 用真实大图验证多尺寸 ICO 的声明/实际尺寸一致
```

没有构建步骤：全部是可直接运行的 JS，改完即生效（客户端改动需重启客户端）。

---

## 两个半边

| | 宿主侧 `lib/index.js` | 客户端侧 `client/client.js` |
|---|---|---|
| 运行环境 | DSH 宿主（Node，cordis 插件） | 浏览器 / 渲染进程 |
| 载体 | `dsh.bundle.patch` → `cordis.patch.yml` | `dsh.client` + `exports["./client"]` |
| 职责 | 读写设置、处理图片、落地图标、暴露 HTTP 路由 | 设置页 UI、实时预览样式 |
| 生效方式 | 重启客户端 | 重启客户端（改样式可只刷新页面） |

客户端插件必须是 **`__ModuleLoader__` factory** 格式（不是普通 ESM），`react` 由 loader 的模块表提供：

```js
window.__ModuleLoader__.load({
  id: 'dsh-appearance-studio',            // 必须等于 package.json 的 name
  factory(require) {
    const react = require('react')
    function apply(ctx) { /* ... */ }
    return { inject: ['slots'], apply }
  },
})
```

`package.json` 的 `dsh.client` 有三个字段都不能少：

```json
"client": {
  "platform": "web",
  "immediately": true,                                   // 缺了会导致注册不生效
  "inject": ["@deepseek-ai/dsh-client-ui-settings"]
}
```

注册设置分区必须**包在 `slots.inject` 里**（等槽就绪再注册），直接 `ctx.slots.register` 会静默失效：

```js
ctx.slots.inject('settings.section', () => {
  ctx.slots.register({ name: 'settings.section', id: 'skin-studio', order: 45, label: () => '外观工作室' },
    () => react.createElement(Panel))
})
```

`settings.section` 的渲染回调必须返回 **React 元素**，不是 DOM 元素。

---

## 实现要点（踩过的坑，别改回去）

### 1. 桌面端注入只能用内联 script 行

桌面壳的 `index.html` 从安装包静态 dist 直出，`tapIndex` 永远不生效；唯一通道是 `webserver/index-inject` 的结构化行。

而且必须推 `{kind:'script', text}`，**不能用 `{kind:'script-src', src}`** —— 后者一旦加载失败会 reject 掉 `__DSH_BOOT_READY__`，整个界面起不来。

### 2. 注入表会被 Electron 壳缓存

壳在宿主启动时收集一次并缓存，之后没有刷新路径。所以「改设置 → 刷新页面」拿不到新值。客户端插件因此在加载后**自己拉一次 `/dsh-skin/state.json` 并应用样式**。

### 3. 样式应用必须在 `apply()` 里，不能只放面板组件

面板组件只在用户打开「外观工作室」时才挂载。早先把它写在组件的 `useEffect` 里，结果就是"必须打开设置面板主题色/背景才生效"。

### 4. 面板样式不要用 Shadow DOM + `innerHTML`

`shadow.appendChild(styleNode)` 之后再 `shadow.innerHTML = ...` 会把刚插入的 `<style>` 一起清空，面板变成裸 HTML。现在改成宿主注入全局 CSS（`.dshskin-*` 前缀隔离）。

### 5. 主题色改的是 deepseek 色阶，不是 `brand-primary`

- DSH 界面上的**蓝色**来自 `--dsw-static-deepseek-*` 色阶；语义变量只是引用它：
  `--dsw-alias-state-business-primary: var(--dsw-static-deepseek-500)`（亮色）/ `-400`（暗色）。
- `--dsw-alias-brand-primary` **不是主色**，它是品牌**前景色**（亮色 `neutral-bluish-1000` 近黑、暗色 `neutral-bluish-50` 近白），按钮本来就是黑底白字的单色设计。改它等于改文字色。
- 这些变量定义在 `body` 与 `body[data-ds-dark-theme]` 上，后者属性选择器优先级 (0,1,1)，压过 `body` 的 (0,0,1)，所以**必须带 `!important`**；另外 DSH 前端有上百个运行时注入的 `<style>`，同优先级下插件必输。

### 6. DSH 界面是多层背景叠加

页面底色 `bg-base` + 面板层 `bg-layer-1/2/3` + 侧栏 `sidebar-fill`。要让背景图透出来，这些层都得跟着变通透；只改 `bg-base` 会被面板层整个挡住。

弹窗（`[role="dialog"]` / `[role="alertdialog"]`）要**单独恢复实心**，否则浮层内容会和背景互相穿透。

### 7. 「背景可见度」控制的是界面底色，不是图片自身透明度

图片底下压着界面底色，把图片 `opacity` 调多实都没用 —— 白色底色会照样把它冲淡（表现是"调到 100% 仍是浅色、看不到原图颜色"）。

正确做法：遮罩 alpha = `1 - 背景可见度`，作用在那些背景层变量上；图片本身恒为 `opacity: 1`。

### 8. ICO 的宽高字段各只有 1 字节

超过 256 的图必须先缩小，否则会写出「声明 256、实际 550」的畸形 ICO —— 浏览器不渲染（面板没回显）、Windows 也可能不认（托盘不更新）。

因此 `lib/index.js` 里有一份**纯 Node 的 PNG 解码 / 盒式缩放 / 重编码**（只用 `node:zlib`，无第三方依赖），并生成 16/24/32/48/64/128/256 多档，避免系统拉伸导致发虚。

### 9. 桌面 / 开始菜单快捷方式的图标是独立字段

快捷方式的图标不是 `resources/` 里的文件，而是 `.lnk` 自己的 `IconLocation`（默认指向 exe 内嵌图标）。Node 写不了 `.lnk`，所以借 PowerShell 的 `WScript.Shell` COM 改指向我们生成的 `.ico`。这一步是纯增量的：快捷方式不存在、COM 被禁、超时都不影响主流程。

### 10. 图标与 Electron 主进程的关系

插件跑在 `dsh-desktop-host` 子进程里（Electron 以 `ELECTRON_RUN_AS_NODE` 启动它），拿不到 `electron` 模块，与 Electron 壳之间只有固定的几种 IPC 消息，**没有图标通道**。

但主进程是按磁盘路径读图的，所以"替换文件 + 重启"就是最干净的可行路径：

```js
const trayIconPath = join(process.resourcesPath, 'tray.ico')
tray = new DesktopTray({ iconPath: trayIconPath })        // 托盘
... { icon: nativeImage.createFromPath(trayIconPath) }    // 窗口图标（同一文件）
// process.resourcesPath/icon.png 只用于「关于」面板
```

---

## 诊断

客户端插件会把关键节点写进 `$DSH_HOME/dsh-skin/debug.log`（`<img>` 信标打到 `/dsh-skin/debug.json`，避免凭据/跨源问题掩盖真实原因）：

| stage | 含义 |
|---|---|
| `client-load` | 模块 factory 执行了 |
| `client-apply` | `apply()` 被调用 |
| `client-registered` | 设置分区注册成功 |
| `apply-ok` / `apply-error` | 启动时应用样式的结果 |
| `dom-chain` | 视口中心那条 DOM 链的背景色，用来定位"谁挡住了背景图" |

## 测试

```bash
node test/smoke.mjs            # 41 项：路由、上传、备份还原、信任栅栏
node test/icon-scale-check.mjs # 用真实大图验证多尺寸 ICO
```

冒烟测试把 `process.argv[2]` 指向一个**假的安装目录**，所以图标应用/还原的测试绝不会碰真实的 DSH 安装。

## HTTP 路由

全部挂在 `/dsh-skin/` 下：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `state.json` | 设置 + 背景 + 图标状态 |
| POST | `settings.json` | 保存设置 |
| POST | `wallpaper-upload.json` | 上传背景（base64 data URL） |
| POST | `wallpaper-delete.json` | 删除背景 |
| GET | `wallpaper.img` | 背景图本体 |
| POST | `icon-upload.json` | 上传图标（`kind=tray\|app\|both`） |
| GET | `icon-preview.img` | 图标预览 |
| POST | `icon-apply.json` | 写入安装目录并更新快捷方式 |
| POST | `icon-restore.json` | 还原原图标 |
| GET | `debug.json` | 诊断信标接收端 |

**写请求只接受本机（回环）来源**，并拒绝跨站标记与跨源 Origin —— 否则任何拿到 Web 会话的人都能改这台机器上客户端的图标文件。只读接口不受影响。

## 本地开发

```bash
node --check lib/index.js
node --check client/client.js
node test/smoke.mjs
```

改动生效方式：

- `assets/panel.css`、`assets/*`：重启宿主（或按需刷新页面）
- `lib/index.js`：重启客户端
- `client/client.js`：重启客户端（客户端插件在启动时装配）

## 数据文件

| 路径 | 用途 |
|---|---|
| `$DSH_HOME/dsh-skin/settings.json` | 全部设置 |
| `$DSH_HOME/dsh-skin/wallpaper.<ext>` | 当前背景图 |
| `$DSH_HOME/dsh-skin/tray.ico` / `app.png` | 上传的图标源文件 |
| `$DSH_HOME/dsh-skin/backup/` | 被覆盖前的原图标 |
| `$DSH_HOME/dsh-skin/debug.log` | 诊断日志 |

`$DSH_HOME` 默认 `~/.dsh`。
