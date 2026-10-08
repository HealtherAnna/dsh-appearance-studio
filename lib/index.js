/**
 * dsh-skin-studio —— DSH 外观工作室（宿主侧）
 *
 * 三项能力：
 *   1) 主题色盘：覆盖 DSH 官方的 --dsw-* 设计令牌（主品牌色 + 派生色）
 *   2) 界面背景图：上传图片，注入为固定背景层（可调透明度/模糊/压暗/填充）
 *   3) 桌面与托盘图标：上传图片，写入 Electron 安装目录的 resources/tray.ico
 *      与 resources/icon.png（自动备份原图，可一键还原）
 *
 * ── 注入通道（重要，结论来自 dsh-whale-widget issue #152/#153/#154）────────────
 *   · Web 形态（dsh web）：webServer.tapIndex(html => html) 改写 index.html
 *   · 桌面端（Electron）：index.html 由安装包静态 dist 直出，tapIndex 永远不生效；
 *     唯一通道是 `webserver/index-inject` 的结构化行。而且**必须用内联 script 行**
 *     （{kind:'script', text}），绝不能用 {kind:'script-src', src}：后者加载失败会
 *     reject 掉 __DSH_BOOT_READY__，导致整个界面起不来。该表由 Electron 壳在宿主
 *     启动时收集一次并缓存，所以注入行的注册必须发生在 apply() 的最开头。
 *
 * ── 图标为什么改文件而不是调 Electron API ────────────────────────────────────
 *   本插件运行在 dsh-desktop-host 这个**子进程**里（Electron 以 ELECTRON_RUN_AS_NODE
 *   启动它），拿不到 electron 模块，与 Electron 壳之间只有固定的几种 IPC 消息
 *   （shutdown / quit-inspection / update-tasks / platform-session / ready），
 *   没有图标通道。但 Electron 主进程是这样加载图标的：
 *       trayIconPath = join(process.resourcesPath, 'tray.ico')
 *       appIconPath  = join(process.resourcesPath, 'icon.png')
 *       new Tray(nativeImage.createFromPath(trayIconPath))
 *   即**运行时从磁盘文件读取**。所以替换这两个文件 + 重启客户端即可换图标。
 *   （DSH 升级会覆盖这两个文件，届时重新点一次「应用」即可。）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ── 路径 ────────────────────────────────────────────────────────────────────
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'dsh-skin')
const BACKUP_DIR = path.join(DATA_DIR, 'backup')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

/** 用户上传的图标源文件（应用前先落在数据目录）。 */
const ICON_SOURCE = {
  tray: path.join(DATA_DIR, 'tray.ico'),
  app: path.join(DATA_DIR, 'app.png'),
}
/** 落到 DSH 安装目录 resources/ 下的文件名（与 Electron 主进程读取的路径一致）。 */
const ICON_TARGET_NAME = { tray: 'tray.ico', app: 'icon.png' }
/** 背景图支持探测的扩展名。 */
const WALLPAPER_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp']
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
}

const ROUTE_PREFIX = '/dsh-skin'
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// ── 默认设置 ────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  version: 1,
  theme: {
    enabled: false,
    brand: '#4d6bfe',
    recolorStatics: false,
  },
  wallpaper: {
    enabled: false,
    opacity: 1,
    blur: 0,
    dim: 0,
    mask: 0.8,
    fit: 'cover',
    layer: 'below',
    position: 'center',
  },
  icons: {
    tray: false,
    app: false,
    appliedAt: null,
  },
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (err) { /* 只读时静默 */ }
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (err) {
    return fallback
  }
}

/** 原子写：先写临时文件再 rename，避免半截 JSON 把设置写坏。 */
function writeJsonAtomic(file, value) {
  ensureDataDir()
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const theme = src.theme && typeof src.theme === 'object' ? src.theme : {}
  const wallpaper = src.wallpaper && typeof src.wallpaper === 'object' ? src.wallpaper : {}
  const icons = src.icons && typeof src.icons === 'object' ? src.icons : {}
  return {
    version: 1,
    theme: {
      enabled: !!theme.enabled,
      brand: HEX_RE.test(String(theme.brand || '')) ? String(theme.brand) : DEFAULT_SETTINGS.theme.brand,
      recolorStatics: !!theme.recolorStatics,
    },
    wallpaper: {
      enabled: !!wallpaper.enabled,
      opacity: clampNumber(wallpaper.opacity, 0.02, 1, DEFAULT_SETTINGS.wallpaper.opacity),
      blur: clampNumber(wallpaper.blur, 0, 40, DEFAULT_SETTINGS.wallpaper.blur),
      dim: clampNumber(wallpaper.dim, 0, 0.9, DEFAULT_SETTINGS.wallpaper.dim),
      // 「内容遮罩」：页面底色 --dsw-alias-bg-base 的不透明度。它保证内容区
      // 始终有稳定底色（文字清晰可读），背景图从底下透出来。
      mask: clampNumber(wallpaper.mask, 0, 1, DEFAULT_SETTINGS.wallpaper.mask),
      fit: ['cover', 'contain', 'auto', 'repeat'].includes(wallpaper.fit) ? wallpaper.fit : 'cover',
      layer: ['below', 'above'].includes(wallpaper.layer) ? wallpaper.layer : 'below',
      position: ['center', 'top', 'bottom', 'left', 'right'].includes(wallpaper.position) ? wallpaper.position : 'center',
    },
    icons: {
      tray: !!icons.tray,
      app: !!icons.app,
      appliedAt: typeof icons.appliedAt === 'string' ? icons.appliedAt : null,
    },
  }
}

function readSettings() {
  return normalizeSettings(readJson(SETTINGS_FILE, DEFAULT_SETTINGS))
}

function writeSettings(next) {
  const merged = normalizeSettings(next)
  writeJsonAtomic(SETTINGS_FILE, merged)
  return merged
}

// ── 背景图 ──────────────────────────────────────────────────────────────────
function findWallpaper() {
  for (const ext of WALLPAPER_EXTS) {
    const file = path.join(DATA_DIR, 'wallpaper.' + ext)
    try {
      const st = fs.statSync(file)
      if (st.isFile() && st.size > 0) {
        return { file, ext, mime: MIME_BY_EXT[ext] || 'application/octet-stream', bytes: st.size, mtime: st.mtimeMs }
      }
    } catch (err) { /* 继续找 */ }
  }
  return null
}

function removeWallpaper() {
  const found = findWallpaper()
  if (!found) return false
  try { fs.unlinkSync(found.file); return true } catch (err) { return false }
}

/** 从文件头判断真实图片类型（不信任上传时声明的类型）。 */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png', kind: 'png' }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg', kind: 'jpeg' }
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return { ext: 'gif', mime: 'image/gif', kind: 'gif' }
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp', kind: 'webp' }
  if (buf.slice(0, 4).toString('latin1') === 'BM') return { ext: 'bmp', mime: 'image/bmp', kind: 'bmp' }
  if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) return { ext: 'ico', mime: 'image/x-icon', kind: 'ico' }
  return null
}

/** 读 PNG 的 IHDR 宽高（不解码像素，只读头部 24 字节）。 */
function readPngSize(buf) {
  if (!buf || buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  if (buf.readUInt32BE(4) !== 0x0d0a1a0a) return null
  if (buf.slice(12, 16).toString('latin1') !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// ── PNG 缩放（纯 Node，无第三方依赖）───────────────────────────────────────
// 为什么必须有它：ICO 的宽高字段各只有 **1 字节**（256 用 0 表示），所以嵌进
// ICO 的图标最大只能 256×256。用户上传的图常常更大（实测 550×550），直接塞进去
// 会写出「声明 256、实际 550」的畸形 ICO —— 浏览器不渲染（面板没有回显）、
// Windows 也可能不认（托盘图标不更新）。

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC32 查表（PNG 每个块都要校验）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 解出 8 位 PNG 的 RGBA 像素。
 * 只支持非隔行的 8 位灰度 / RGB / 灰度+alpha / RGBA（覆盖绝大多数图标素材）；
 * 其余（调色板、16 位、隔行）返回 null，调用方回退为「不缩放」。
 */
function decodePngToRgba(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1')
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8 || interlace !== 0) return null
  if (colorType !== 0 && colorType !== 2 && colorType !== 4 && colorType !== 6) return null
  if (!width || !height || idat.length === 0) return null

  let raw
  try { raw = zlib.inflateSync(Buffer.concat(idat)) } catch (err) { return null }

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4
  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null

  const out = Buffer.alloc(width * height * 4)
  const line = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)
  let off = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[off]
    off += 1
    raw.copy(line, 0, off, off + stride)
    off += stride
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)
      }
      line[i] = v & 0xff
    }
    line.copy(prev)
    for (let x = 0; x < width; x += 1) {
      const s = x * channels
      const d = (y * width + x) * 4
      if (colorType === 6) {
        out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3]
      } else if (colorType === 2) {
        out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255
      } else if (colorType === 4) {
        out[d] = line[s]; out[d + 1] = line[s]; out[d + 2] = line[s]; out[d + 3] = line[s + 1]
      } else {
        out[d] = line[s]; out[d + 1] = line[s]; out[d + 2] = line[s]; out[d + 3] = 255
      }
    }
  }
  return { width, height, rgba: out }
}

/** 盒式平均缩放：缩小时比最近邻干净得多，实现也简单。 */
function resizeRgba(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor((y * sh) / dh)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh))
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor((x * sw) / dw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1 && sy < sh; sy += 1) {
        for (let sx = x0; sx < x1 && sx < sw; sx += 1) {
          const i = (sy * sw + sx) * 4
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n += 1
        }
      }
      const d = (y * dw + x) * 4
      out[d] = Math.round(r / n)
      out[d + 1] = Math.round(g / n)
      out[d + 2] = Math.round(b / n)
      out[d + 3] = Math.round(a / n)
    }
  }
  return out
}

/** 把 RGBA 编成 8 位 PNG（每行 filter 0，简单且足够）。 */
function encodeRgbaToPng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0)
    return Buffer.concat([head, data, crcBuf])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // color type: RGBA
  ihdr[10] = 0  // compression
  ihdr[11] = 0  // filter
  ihdr[12] = 0  // interlace
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 把 PNG 缩到不超过 maxSize 的方形图；本来就够小则原样返回。
 * 解不开（非 8 位 / 隔行 / 损坏）返回 null，调用方回退。
 */
function shrinkPngToSquare(buf, maxSize) {
  const size = readPngSize(buf)
  if (!size) return null
  if (size.width <= maxSize && size.height <= maxSize) return buf
  const decoded = decodePngToRgba(buf)
  if (!decoded) return null
  const scale = Math.min(maxSize / decoded.width, maxSize / decoded.height)
  const dw = Math.max(1, Math.round(decoded.width * scale))
  const dh = Math.max(1, Math.round(decoded.height * scale))
  return encodeRgbaToPng(dw, dh, resizeRgba(decoded.rgba, decoded.width, decoded.height, dw, dh))
}

/**
 * 把 PNG 包成 ICO（PNG-in-ICO，Vista+ 支持）。
 * 托盘图标位图尺寸字段：0 表示 256（ICO 规范用 1 字节存宽高）。
 */
function pngToIco(png) {
  const size = readPngSize(png)
  if (!size) throw new Error('不是有效的 PNG 数据')
  const w = size.width >= 256 ? 0 : size.width
  const h = size.height >= 256 ? 0 : size.height
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(1, 4) // image count
  const entry = Buffer.alloc(16)
  entry.writeUInt8(w, 0)
  entry.writeUInt8(h, 1)
  entry.writeUInt8(0, 2)  // 调色板数
  entry.writeUInt8(0, 3)  // reserved
  entry.writeUInt16LE(1, 4)  // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(png.length, 8)  // 数据长度
  entry.writeUInt32LE(22, 12)         // 数据偏移（6 + 16）
  return Buffer.concat([header, entry, png])
}

/** 按原图尺寸挑出要放进 ICO 的档位（只缩不放，避免放大发虚）。 */
function icoSizesFor(width, height) {
  const maxDim = Math.max(width, height)
  const wanted = [16, 24, 32, 48, 64, 128, 256]
  const sizes = wanted.filter((s) => s <= maxDim)
  if (sizes.length === 0) sizes.push(Math.max(1, Math.min(256, maxDim)))
  return sizes
}

/**
 * 生成**多尺寸** ICO。
 *
 * 为什么必须多尺寸：Windows 在不同位置取不同档位——小图标 16、任务栏 32、
 * 桌面 48、大图标 256。只塞一张 256 的图，系统会自己拉伸，桌面快捷方式看起来就发虚。
 * 解不开原图（非 8 位 / 隔行 / 损坏）返回 null，调用方回退到单尺寸路径。
 */
function pngToIcoMulti(png, sizes) {
  const decoded = decodePngToRgba(png)
  if (!decoded) return null
  const entries = []
  const blobs = []
  let offset = 6 + 16 * sizes.length
  for (const size of sizes) {
    const blob = encodeRgbaToPng(size, size, resizeRgba(decoded.rgba, decoded.width, decoded.height, size, size))
    const dim = size >= 256 ? 0 : size
    const entry = Buffer.alloc(16)
    entry.writeUInt8(dim, 0)
    entry.writeUInt8(dim, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(blob.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += blob.length
    entries.push(entry)
    blobs.push(blob)
  }
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(sizes.length, 4)
  return Buffer.concat([header, ...entries, ...blobs])
}

/** 把 PNG 打包成可用的 ICO：优先多尺寸，失败再退回单尺寸。 */
function buildIco(png) {
  const size = readPngSize(png)
  if (size) {
    const multi = pngToIcoMulti(png, icoSizesFor(size.width, size.height))
    if (multi) return multi
  }
  return pngToIco(shrinkPngToSquare(png, 256) || png)
}

// ── 桌面 / 开始菜单快捷方式图标 ─────────────────────────────────────────────
// 快捷方式的图标**不是** resources/ 里的文件，而是 .lnk 自己的 IconLocation
// （实测指向 "...\DeepSeek Harness.exe,0"，即 exe 内嵌图标）。Node 写不了 .lnk，
// 所以借 PowerShell 的 WScript.Shell COM 把它改指向我们生成的 .ico。
// 纯增量步骤：快捷方式不存在、COM 被禁、超时，都不影响主流程。
function applyShortcutIcons(icoPath) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, paths: [], error: '仅 Windows 支持' })
  const ps = [
    '$ErrorActionPreference = "Continue"',
    '$target = ' + JSON.stringify(icoPath),
    '$candidates = @(',
    '  (Join-Path ([Environment]::GetFolderPath("Desktop")) "DeepSeek Harness.lnk"),',
    '  (Join-Path ([Environment]::GetFolderPath("CommonDesktopDirectory")) "DeepSeek Harness.lnk"),',
    '  (Join-Path ([Environment]::GetFolderPath("Programs")) "DeepSeek Harness.lnk")',
    ')',
    '$sh = New-Object -ComObject WScript.Shell',
    '$done = @()',
    'foreach ($p in $candidates) {',
    '  try {',
    '    if ($p -and (Test-Path -LiteralPath $p)) {',
    '      $lnk = $sh.CreateShortcut($p)',
    '      $lnk.IconLocation = "$target,0"',
    '      $lnk.Save()',
    '      $done += $p',
    '    }',
    '  } catch { }',
    '}',
    'Write-Output ($done -join "|")',
  ].join('\n')
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 25000 },
      (err, stdout) => resolve({
        ok: !err,
        paths: String(stdout || '').trim().split('|').map((s) => s.trim()).filter(Boolean),
        error: err ? String(err.message).slice(0, 200) : null,
      }))
  })
}

// ── 请求体 ──────────────────────────────────────────────────────────────────
function readBodyMax(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > max) {
        reject(new Error('请求体过大'))
        try { req.destroy() } catch (err) { /* ignore */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif|bmp|x-icon|vnd\.microsoft\.icon);base64,([A-Za-z0-9+/=\s]+)$/i

function decodeDataUrl(value) {
  const m = DATA_URL_RE.exec(String(value || ''))
  if (!m) return null
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64')
  if (buf.length === 0) return null
  return buf
}

// ── 图标：定位安装目录、备份、应用、还原 ────────────────────────────────────
/**
 * 定位 DSH 安装目录下的 resources/。
 * 子进程里 process.execPath 就是 Electron 可执行文件本身
 * （以 ELECTRON_RUN_AS_NODE 模式运行的同一个二进制），所以与之同级。
 */
function resolveResourcesDir() {
  const candidates = []
  try { candidates.push(path.join(path.dirname(process.execPath), 'resources')) } catch (err) { /* ignore */ }
  const runtimeDir = process.argv[2]
  if (typeof runtimeDir === 'string' && runtimeDir) {
    // <install>\resources\app.asar\dsh  →  <install>\resources
    const marker = 'app.asar'
    const idx = runtimeDir.indexOf(marker)
    if (idx > 0) candidates.push(runtimeDir.slice(0, idx + marker.length).replace(/[\\/][^\\/]*$/, ''))
  }
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, 'app.asar'))) return dir
    } catch (err) { /* 下一个 */ }
  }
  return candidates[0] || null
}

function iconTargetPath(kind) {
  const name = ICON_TARGET_NAME[kind]
  if (!name) throw new Error('未知的图标类型：' + String(kind))
  const resources = resolveResourcesDir()
  if (!resources) throw new Error('无法定位 DSH 安装目录（resources）')
  return { resources, target: path.join(resources, name) }
}

function backupPathFor(kind) {
  return path.join(BACKUP_DIR, ICON_TARGET_NAME[kind])
}

function fileInfo(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return null
    return { exists: true, bytes: st.size, mtime: st.mtimeMs }
  } catch (err) {
    return { exists: false, bytes: 0, mtime: null }
  }
}

function installWritable(resources) {
  try {
    const probe = path.join(resources, '.dsh-skin-write-probe')
    fs.writeFileSync(probe, 'probe')
    fs.unlinkSync(probe)
    return true
  } catch (err) {
    return false
  }
}

/**
 * 托盘源文件如果不是多尺寸，就从保留的 app.png（原始大图）按当前逻辑重建一次。
 *
 * 为什么需要：多尺寸打包只在**上传那一刻**发生。插件升级后用户如果只是点
 * 「应用到客户端」，复制过去的仍是升级前生成的旧 ICO（比如只有 256 单档），
 * 桌面/任务栏看着发虚。这里让 apply 自己把它补齐，用户不必重新上传。
 */
function refreshTraySourceFromAppPng() {
  const appInfo = fileInfo(ICON_SOURCE.app)
  const trayInfo = fileInfo(ICON_SOURCE.tray)
  if (!appInfo.exists) return false
  if (trayInfo.exists) {
    try {
      const current = fs.readFileSync(ICON_SOURCE.tray)
      // 已经是多档，且不比 app.png 旧 → 不必动
      if (current.readUInt16LE(4) > 1 && trayInfo.mtime >= appInfo.mtime) return false
    } catch (err) { /* 读不出来就重建 */ }
  }
  let origin
  try { origin = fs.readFileSync(ICON_SOURCE.app) } catch (err) { return false }
  if (!readPngSize(origin)) return false
  fs.writeFileSync(ICON_SOURCE.tray, buildIco(origin))
  return true
}

/** 把上传的源图标写进 DSH 安装目录；覆盖前先备份原文件（只备份一次）。 */
function applyIcon(kind) {
  if (kind === 'tray') {
    try { refreshTraySourceFromAppPng() } catch (err) { /* 重建失败不该挡住应用 */ }
  }
  const source = ICON_SOURCE[kind]
  if (!source || !fs.existsSync(source)) throw new Error('还没有上传该图标')
  const { resources, target } = iconTargetPath(kind)
  ensureDataDir()
  fs.mkdirSync(BACKUP_DIR, { recursive: true })

  const backup = backupPathFor(kind)
  if (!fs.existsSync(backup)) {
    if (fs.existsSync(target)) fs.copyFileSync(target, backup)
  }

  const bytes = fs.readFileSync(source)
  fs.writeFileSync(target, bytes)

  // 写后校验：长度与源一致，避免半截写入把图标文件弄坏
  const check = fs.readFileSync(target)
  if (check.length !== bytes.length) throw new Error('写入后校验失败（长度不一致）')

  return { target, backup, bytes: check.length, resources }
}

/** 从备份还原原图标。 */
function restoreIcon(kind) {
  const { target } = iconTargetPath(kind)
  const backup = backupPathFor(kind)
  if (!fs.existsSync(backup)) throw new Error('没有可还原的备份')
  const bytes = fs.readFileSync(backup)
  fs.writeFileSync(target, bytes)
  return { target, bytes: bytes.length }
}

function iconsStatus() {
  let resources = null
  let writable = false
  try {
    resources = resolveResourcesDir()
    if (resources) writable = installWritable(resources)
  } catch (err) { /* 保持默认 */ }
  const per = {}
  for (const kind of ['tray', 'app']) {
    let target = null
    try { target = iconTargetPath(kind).target } catch (err) { target = null }
    per[kind] = {
      source: fileInfo(ICON_SOURCE[kind]),
      target,
      targetInfo: target ? fileInfo(target) : { exists: false, bytes: 0, mtime: null },
      backup: fileInfo(backupPathFor(kind)),
    }
  }
  return { resources, writable, tray: per.tray, app: per.app }
}

// ── CSS 生成 ────────────────────────────────────────────────────────────────
/**
 * 主题色 CSS。
 *
 * ⚠ 三个实测结论，别改回去：
 *  1) DSH 界面上的「品牌蓝」来自 `--dsw-static-deepseek-*` 这条**色阶**。
 *     语义变量只是引用它：`--dsw-alias-state-business-primary: var(--dsw-static-deepseek-500)`
 *     （亮色）/ `-400`（暗色），`--dsw-alias-link` 同理。所以改色阶 → 全站跟着变。
 *  2) `--dsw-alias-brand-primary` **不是**主色，它是品牌**前景色**
 *     （亮色 = neutral-bluish-1000 近黑，暗色 = neutral-bluish-50 近白），
 *     按钮本来就是黑底白字的单色设计。改它等于改文字色，所以默认不动它。
 *  3) 这些变量都定义在 `body` 与 `body[data-ds-dark-theme]` 上。后者的属性选择器
 *     优先级是 (0,1,1)，压过普通 `body` 的 (0,0,1)，所以**必须带 !important**——
 *     否则暗色主题下必输。第一版完全没生效就是这个原因。
 */
function buildThemeCss(theme) {
  const b = theme.brand
  const selector = ':root, body, body[data-ds-dark-theme]'
  // 用户只给一个颜色，这里派生出整条色阶（档位对齐 DSH 官方 deepseek 色阶）
  const scale = [
    [50, 8, '#ffffff'], [100, 13, '#ffffff'], [200, 22, '#ffffff'],
    [300, 38, '#ffffff'], [400, 64, '#ffffff'], [450, 84, '#ffffff'],
    [500, null, null],
    [600, 84, '#000000'], [800, 66, '#000000'], [900, 54, '#000000'],
  ]
  const lines = scale.map((row) => {
    const step = row[0]
    const pct = row[1]
    const other = row[2]
    return pct === null
      ? `--dsw-static-deepseek-${step}: ${b} !important;`
      : `--dsw-static-deepseek-${step}: color-mix(in srgb, ${b} ${pct}%, ${other}) !important;`
  })
  // 少数硬编码的语义变量补一刀（其余都是 var() 引用色阶，会自动跟着变）
  lines.push(`--dsw-alias-state-business-primary: ${b} !important;`)
  lines.push(`--dsw-alias-link: ${b} !important;`)
  lines.push(`--dsw-focus-ring-color: color-mix(in srgb, ${b} 62%, transparent) !important;`)
  lines.push(`--dsw-alias-interactive-bg-hover-accent: color-mix(in srgb, ${b} 18%, transparent) !important;`)

  let css = `${selector} { ${lines.join(' ')} }`
  if (theme.recolorStatics) {
    // 激进模式：连按钮底色与前景色一起改（会打破原本的黑白单色设计）
    css += ` ${selector} {`
      + ` --dsw-alias-brand-primary: ${b} !important;`
      + ` --dsw-alias-button-primary-fill: ${b} !important;`
      + ` --dsw-alias-button-primary-hover: color-mix(in srgb, ${b} 86%, #ffffff) !important;`
      + ` --dsw-alias-button-primary-dimmed: color-mix(in srgb, ${b} 52%, transparent) !important;`
      + ` --dsw-alias-button-info-fill: ${b} !important;`
      + ` --dsw-alias-label-primary-bluish: color-mix(in srgb, ${b} 78%, #ffffff) !important;`
      + ` --dsw-specific-sidebar-nav-item-active-accent: ${b} !important;`
      + ' }'
  }
  return css
}

/** 背景图层：below 走底层伪元素，above 走覆盖层（低透明度水印）。 */
function buildWallpaperCss(wallpaper, url) {
  const fitMap = { cover: 'cover', contain: 'contain', auto: 'auto', repeat: 'auto' }
  const size = fitMap[wallpaper.fit] || 'cover'
  const repeat = wallpaper.fit === 'repeat' ? 'repeat' : 'no-repeat'
  const opacity = wallpaper.opacity
  const blur = wallpaper.blur > 0 ? `blur(${wallpaper.blur}px)` : 'none'
  const dimLayer = wallpaper.dim > 0
    ? `body.dsh-skin-has-wallpaper::after{content:'';position:fixed;inset:0;pointer-events:none;background:rgba(0,0,0,${wallpaper.dim});z-index:${wallpaper.layer === 'above' ? 2147483645 : -1};}`
    : ''
  if (wallpaper.layer === 'above') {
    return `
body.dsh-skin-has-wallpaper::before{
  content:'';position:fixed;inset:0;pointer-events:none;z-index:2147483646;
  background-image:url("${url}");background-size:${size};background-repeat:${repeat};
  background-position:${wallpaper.position};filter:${blur};opacity:${opacity};
}
${dimLayer}`
  }
  return `
html.dsh-skin-has-wallpaper,body.dsh-skin-has-wallpaper{background-color:transparent !important;background-image:none !important;}
body.dsh-skin-has-wallpaper::before{
  content:'';position:fixed;inset:0;pointer-events:none;z-index:-1;
  background-image:url("${url}");background-size:${size};background-repeat:${repeat};
  background-position:${wallpaper.position};filter:${blur};opacity:${opacity};
}
body.dsh-skin-has-wallpaper #root,body.dsh-skin-has-wallpaper #app{background-color:transparent !important;}
${dimLayer}`
}

/**
 * 面板样式：作为 index-inject 的 style 行注入页面。
 *
 * 样式为什么放在这里而不是客户端插件里：设置面板需要一整套 .dshskin-* 全局类，
 * 而 style 行正是 DSH 官方主题包（dsh-client-ui-theme 的 bootThemeStyle）用的
 * 同一条机制，最稳。客户端插件只负责按最新设置生成主题色/壁纸的实时样式
 * （宿主注入的行只在宿主启动时被壳收集一次并缓存，拿不到之后的改动）。
 */
function panelCss() {
  try {
    return '/* dsh-skin-studio */\n' + fs.readFileSync(path.join(PACKAGE_ROOT, 'assets', 'panel.css'), 'utf8')
  } catch (err) {
    return ''
  }
}

// ── 信任栅栏 ────────────────────────────────────────────────────────────────
function isLoopbackHostname(hn) {
  const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * 外观改动只允许来自本机：任何拿到 Web 会话的人若能改设置，就等于能改这台机器上
 * 客户端的图标文件。只读接口不受影响。
 */
function denyRequest(req) {
  const headers = (req && req.headers) || {}
  let hostUrl = null
  try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 }
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (WRITE_METHODS.has(method) && !isLoopbackHostname(hostUrl.hostname)) return 403
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
  const origin = headers.origin
  if (origin) {
    try {
      const o = new URL(String(origin))
      if (o.host !== hostUrl.host) return 403
    } catch (err) { return 403 }
  }
  return null
}

// ── 插件本体 ────────────────────────────────────────────────────────────────
export default {
  name: 'dsh-skin-studio',

  apply(root) {
    ensureDataDir()
    const disposers = []
    try {
      root.effect(() => () => {
        for (const dispose of disposers) {
          try { dispose() } catch (err) { /* ignore */ }
        }
      })
    } catch (err) { /* 老宿主没有 effect 也不该崩 */ }

    // ① 注入行：不依赖任何服务，必须最早注册（壳只在启动时收集一次）
    try {
      disposers.push(root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          // 这张表可能被 Electron 壳缓存复用：先撤掉自己上一次注入的行再推最新的。
          // 识别标记必须足够独特，避免误删别的插件。
          const OURS = ['dsh-skin-studio', 'dshskin-']
          for (let i = table.length - 1; i >= 0; i -= 1) {
            const row = table[i]
            if (!row || typeof row.text !== 'string') continue
            if (OURS.some((mark) => row.text.includes(mark))) table.splice(i, 1)
          }
          const css = panelCss()
          if (css) table.push({ kind: 'style', text: css })
        } catch (err) {
          console.warn('[dsh-skin-studio] 注入失败：' + String((err && err.message) || err))
        }
      }))
    } catch (err) {
      console.warn('[dsh-skin-studio] 无法订阅 webserver/index-inject：' + String((err && err.message) || err))
    }

    // ② 服务就绪后注册路由
    root.inject(['webServer'], (ctx) => {
      const register = (route) => {
        const inner = route.handler
        return ctx.webServer.register({
          ...route,
          handler: async (req, res) => {
            const deny = denyRequest(req)
            if (deny !== null) {
              try { res.writeHead(deny); res.end() } catch (err) { /* ignore */ }
              return
            }
            try {
              await inner(req, res)
            } catch (err) {
              try {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 300) }))
              } catch (err2) { /* ignore */ }
            }
          },
        })
      }
      const sendJson = (res, code, payload) => {
        res.writeHead(code, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      }

      // — 诊断信标（只写本地日志；用来排查"样式为什么不生效"这类只能在浏览器里看到的问题）—
      disposers.push(register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/debug.json`,
        handler: (req, res) => {
          try {
            const u = new URL(String(req.url || '/'), 'http://127.0.0.1')
            ensureDataDir()
            fs.appendFileSync(path.join(DATA_DIR, 'debug.log'), JSON.stringify({
              t: new Date().toISOString(),
              stage: u.searchParams.get('stage') || '',
              extra: String(u.searchParams.get('extra') || '').slice(0, 600),
            }) + '\n', 'utf8')
          } catch (err) { /* 诊断失败不能影响主流程 */ }
          res.writeHead(204)
          res.end()
        },
      }))

      // — 状态 —
      disposers.push(register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state.json`,
        handler: (req, res) => {
          const settings = readSettings()
          const wp = findWallpaper()
          sendJson(res, 200, {
            ok: true,
            settings,
            wallpaper: wp ? { present: true, ext: wp.ext, bytes: wp.bytes, mtime: wp.mtime } : { present: false },
            icons: iconsStatus(),
            platform: process.platform,
          })
        },
      }))

      // — 保存设置 —
      disposers.push(register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/settings.json`,
        handler: async (req, res) => {
          if (String(req.method || '').toUpperCase() !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readBodyMax(req, 256 * 1024)
          const parsed = JSON.parse(body || '{}')
          const current = readSettings()
          const next = normalizeSettings({
            ...current,
            ...parsed,
            theme: { ...current.theme, ...(parsed.theme || {}) },
            wallpaper: { ...current.wallpaper, ...(parsed.wallpaper || {}) },
            icons: { ...current.icons, ...(parsed.icons || {}) },
          })
          const saved = writeSettings(next)
          sendJson(res, 200, { ok: true, settings: saved })
        },
      }))

      // — 背景图上传 —
      disposers.push(register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/wallpaper-upload.json`,
        handler: async (req, res) => {
          const body = await readBodyMax(req, 24 * 1024 * 1024)
          const parsed = JSON.parse(body || '{}')
          const buf = decodeDataUrl(parsed.data)
          if (!buf) {
            sendJson(res, 400, { ok: false, error: '图片数据无法解析（需要 base64 data URL）' })
            return
          }
          if (buf.length > 16 * 1024 * 1024) {
            sendJson(res, 400, { ok: false, error: '图片过大（上限 16 MB）' })
            return
          }
          const kind = sniffImage(buf)
          if (!kind) {
            sendJson(res, 400, { ok: false, error: '不是受支持的图片格式（png/jpg/webp/gif/bmp）' })
            return
          }
          ensureDataDir()
          removeWallpaper()
          const file = path.join(DATA_DIR, 'wallpaper.' + kind.ext)
          fs.writeFileSync(file, buf)
          const settings = readSettings()
          settings.wallpaper.enabled = true
          const saved = writeSettings(settings)
          sendJson(res, 200, { ok: true, settings: saved, wallpaper: { present: true, ext: kind.ext, bytes: buf.length } })
        },
      }))

      // — 背景图删除 —
      disposers.push(register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/wallpaper-delete.json`,
        handler: (req, res) => {
          removeWallpaper()
          const settings = readSettings()
          settings.wallpaper.enabled = false
          const saved = writeSettings(settings)
          sendJson(res, 200, { ok: true, settings: saved, wallpaper: { present: false } })
        },
      }))

      // — 背景图伺服 —
      disposers.push(register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/wallpaper.img`,
        handler: (req, res) => {
          const wp = findWallpaper()
          if (!wp) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('no wallpaper')
            return
          }
          const bytes = fs.readFileSync(wp.file)
          res.writeHead(200, {
            'Content-Type': wp.mime,
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        },
      }))

      // — 图标上传（一个入口：托盘与窗口图标共用 resources/tray.ico）—
      disposers.push(register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/icon-upload.json`,
        handler: async (req, res) => {
          const body = await readBodyMax(req, 24 * 1024 * 1024)
          const parsed = JSON.parse(body || '{}')
          const kind = String(parsed.kind || 'tray')
          if (kind !== 'tray' && kind !== 'app' && kind !== 'both') {
            sendJson(res, 400, { ok: false, error: 'kind 必须是 tray / app / both' })
            return
          }
          const buf = decodeDataUrl(parsed.data)
          if (!buf) {
            sendJson(res, 400, { ok: false, error: '图片数据无法解析' })
            return
          }
          if (buf.length > 16 * 1024 * 1024) {
            sendJson(res, 400, { ok: false, error: '图片过大（上限 16 MB）' })
            return
          }
          const sniffed = sniffImage(buf)
          if (!sniffed) {
            sendJson(res, 400, { ok: false, error: '不是受支持的图片格式' })
            return
          }
          ensureDataDir()
          // Electron 主进程里**窗口图标与托盘图标读的是同一个文件**：
          //   tray = nativeImage.createFromPath(join(process.resourcesPath, 'tray.ico'))
          //   窗口 = nativeImage.createFromPath(同一个 trayIconPath)
          // 而 resources/icon.png 只给「关于」面板用。所以一次上传要同时喂两个目标。
          let note = ''
          let bytes = 0
          if (sniffed.kind === 'ico') {
            fs.writeFileSync(ICON_SOURCE.tray, buf)
            bytes = buf.length
            note = '已按 ICO 保存 —— 托盘与窗口图标都用它'
          } else if (sniffed.kind === 'png') {
            // 打包成**多尺寸** ICO：Windows 在小图标 16 / 任务栏 32 / 桌面 48 /
            // 大图标 256 各取一档，只塞一张 256 的图会被拉伸，桌面快捷方式看着发虚。
            // 同时这一步也解决了单尺寸超过 256 时 ICO 目录项（1 字节）放不下的问题。
            const ico = buildIco(buf)
            fs.writeFileSync(ICON_SOURCE.tray, ico) // 托盘 + 窗口 + 快捷方式
            fs.writeFileSync(ICON_SOURCE.app, buf) // 关于面板（保留原始大图）
            bytes = ico.length
            const size = readPngSize(buf)
            const sizes = size ? icoSizesFor(size.width, size.height) : []
            note = (size ? `已把 ${size.width}×${size.height} 的 PNG 打包为 ICO` : '已把 PNG 打包为 ICO')
              + (sizes.length ? `（含 ${sizes.join('/')} 多档尺寸）` : '')
              + '，并同时更新「关于」面板图标'
          } else {
            sendJson(res, 400, {
              ok: false,
              error: '图标需要 ICO 或 PNG（' + sniffed.kind + ' 无法转换，请另存为 PNG 后重试）',
            })
            return
          }
          sendJson(res, 200, { ok: true, kind, bytes, note, icons: iconsStatus() })
        },
      }))

      // — 图标预览（把上传的源图标回显给面板）—
      disposers.push(register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/icon-preview.img`,
        handler: (req, res) => {
          const url = String(req.url || '')
          const kind = /[?&]kind=app\b/.test(url) ? 'app' : 'tray'
          const source = ICON_SOURCE[kind]
          if (!source || !fs.existsSync(source)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('no icon')
            return
          }
          const bytes = fs.readFileSync(source)
          const sniffed = sniffImage(bytes)
          res.writeHead(200, {
            'Content-Type': sniffed ? sniffed.mime : 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        },
      }))

      // — 应用图标到安装目录 —
      disposers.push(register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/icon-apply.json`,
        handler: async (req, res) => {
          const body = await readBodyMax(req, 64 * 1024)
          const parsed = JSON.parse(body || '{}')
          const kind = String(parsed.kind || '')
          const kinds = kind === 'all' ? ['tray', 'app'] : [kind]
          const results = {}
          for (const k of kinds) {
            if (k !== 'tray' && k !== 'app') {
              sendJson(res, 400, { ok: false, error: 'kind 必须是 tray / app / all' })
              return
            }
            try {
              results[k] = { ok: true, ...applyIcon(k) }
            } catch (err) {
              results[k] = { ok: false, error: String((err && err.message) || err) }
            }
          }
          const settings = readSettings()
          settings.icons.tray = !!fileInfo(ICON_SOURCE.tray).exists
          settings.icons.app = !!fileInfo(ICON_SOURCE.app).exists
          settings.icons.appliedAt = new Date().toISOString()
          writeSettings(settings)
          const allOk = Object.values(results).every((r) => r.ok)
          // 桌面 / 开始菜单快捷方式的图标是 .lnk 自己的 IconLocation，与 resources/ 无关，
          // 要单独改一次。失败不影响主流程（快捷方式不存在、COM 被禁都属正常情况）。
          let shortcuts = { ok: false, paths: [], error: null }
          if (results.tray && results.tray.ok) {
            try {
              shortcuts = await applyShortcutIcons(ICON_SOURCE.tray)
            } catch (err) {
              shortcuts = { ok: false, paths: [], error: String((err && err.message) || err) }
            }
          }
          const shortcutNote = shortcuts.paths.length
            ? `；同时更新了 ${shortcuts.paths.length} 个快捷方式图标`
            : ''
          sendJson(res, allOk ? 200 : 400, {
            ok: allOk,
            results,
            shortcuts,
            icons: iconsStatus(),
            note: (allOk ? '已写入安装目录，重启客户端后生效' : '部分图标未应用成功') + shortcutNote,
          })
        },
      }))

      // — 还原原图标 —
      disposers.push(register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/icon-restore.json`,
        handler: async (req, res) => {
          const body = await readBodyMax(req, 64 * 1024)
          const parsed = JSON.parse(body || '{}')
          const kind = String(parsed.kind || 'all')
          const kinds = kind === 'all' ? ['tray', 'app'] : [kind]
          const results = {}
          for (const k of kinds) {
            if (k !== 'tray' && k !== 'app') {
              sendJson(res, 400, { ok: false, error: 'kind 必须是 tray / app / all' })
              return
            }
            try {
              results[k] = { ok: true, ...restoreIcon(k) }
            } catch (err) {
              results[k] = { ok: false, error: String((err && err.message) || err) }
            }
          }
          const allOk = Object.values(results).every((r) => r.ok)
          sendJson(res, allOk ? 200 : 400, {
            ok: allOk,
            results,
            icons: iconsStatus(),
            note: allOk ? '已还原为原图标，重启客户端后生效' : '部分图标未能还原（可能没有备份）',
          })
        },
      }))
    })
  },
}
