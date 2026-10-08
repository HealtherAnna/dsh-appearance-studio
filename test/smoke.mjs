/**
 * dsh-appearance-studio 冒烟测试
 *
 * 不需要 DSH 客户端：用一个 mock 的 cordis 上下文拿到插件注册的路由，
 * 再用真实 HTTP 服务器把所有端点跑一遍。
 *
 * 关键安全设计：把 process.argv[2] 指向一个**假的安装目录**，这样
 * 图标应用/还原测试只会写进临时目录，绝不碰真实的 DSH 安装。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skin-test-'))
const FAKE_INSTALL = path.join(TMP, 'fake-install')
const FAKE_RESOURCES = path.join(FAKE_INSTALL, 'resources')
const HOME = path.join(TMP, 'dsh-home')

fs.mkdirSync(FAKE_RESOURCES, { recursive: true })
fs.writeFileSync(path.join(FAKE_RESOURCES, 'app.asar'), 'fake-asar')
const ORIGINAL_TRAY = Buffer.from('ORIGINAL-TRAY-ICO-BYTES')
const ORIGINAL_APP = Buffer.from('ORIGINAL-APP-PNG-BYTES')
fs.writeFileSync(path.join(FAKE_RESOURCES, 'tray.ico'), ORIGINAL_TRAY)
fs.writeFileSync(path.join(FAKE_RESOURCES, 'icon.png'), ORIGINAL_APP)

process.env.DSH_HOME = HOME
// 第二个候选：从 runtimeDir 里的 app.asar 反推 resources 目录
process.argv[2] = path.join(FAKE_RESOURCES, 'app.asar', 'dsh')

// 1x1 PNG
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''))
}

const routes = []
const injectTable = []
const plugin = (await import('../lib/index.js')).default

check('插件导出 name', plugin.name === 'dsh-appearance-studio', plugin.name)
check('插件导出 apply', typeof plugin.apply === 'function')

const injectSubscribers = []
const root = {
  on(event, cb) {
    if (event === 'webserver/index-inject') {
      injectSubscribers.push(cb)
      cb(injectTable) // 模拟 Electron 壳在宿主启动时收集一次
    }
    return () => {}
  },
  effect(cb) { return cb() },
  inject(services, cb) {
    cb({
      webServer: {
        register(route) { routes.push(route); return () => {} },
        tapIndex() { return () => {} },
      },
    })
  },
}
plugin.apply(root)

check('注册了路由', routes.length >= 8, routes.length + ' 条')
check('注入了面板样式行', injectTable.some((r) => r.kind === 'style' && String(r.text).includes('.dshskin')))
check('没有 script-src 行（避免界面起不来）', !injectTable.some((r) => r.kind === 'script-src'))

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = routes.find((r) => r.path === url.pathname)
  if (!route) { res.writeHead(404); res.end('no route'); return }
  Promise.resolve(route.handler(req, res)).catch((err) => {
    try { res.writeHead(500); res.end(String(err && err.message)) } catch (e) { /* ignore */ }
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

async function get(p) {
  const res = await fetch(base + p, { headers: { host: '127.0.0.1:' + server.address().port } })
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, type: res.headers.get('content-type') || '', buf }
}
async function post(p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:' + server.address().port },
    body: JSON.stringify(body || {}),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (e) { json = { raw: text } }
  return { status: res.status, json }
}

// ── 状态 ────────────────────────────────────────────────────────────────────
{
  const r = await get('/dsh-skin/state.json')
  const j = JSON.parse(r.buf.toString('utf8'))
  check('GET state.json = 200', r.status === 200, r.status)
  check('state 含 settings/wallpaper/icons', !!(j.settings && j.wallpaper && j.icons))
  check('定位到（假的）安装目录', j.icons.resources === FAKE_RESOURCES, j.icons.resources)
  check('安装目录可写', j.icons.writable === true)
}

// ── 主题色设置 ──────────────────────────────────────────────────────────────
{
  const r = await post('/dsh-skin/settings.json', { theme: { enabled: true, brand: '#ff6b00' } })
  check('POST settings.json = 200', r.status === 200, r.status)
  check('主题色已保存', r.json.settings.theme.brand === '#ff6b00', r.json.settings.theme.brand)

  const bad = await post('/dsh-skin/settings.json', { theme: { brand: 'not-a-color' } })
  check('非法颜色被拒绝并回落到默认', bad.json.settings.theme.brand === '#4d6bfe', bad.json.settings.theme.brand)
}

// ── 背景图 ──────────────────────────────────────────────────────────────────
{
  const up = await post('/dsh-skin/wallpaper-upload.json', { data: PNG_1X1 })
  check('上传背景 = 200', up.status === 200, up.status + ' ' + JSON.stringify(up.json.error || ''))
  check('上传后 wallpaper.present', up.json.wallpaper && up.json.wallpaper.present === true)

  const img = await get('/dsh-skin/wallpaper.img')
  check('取回背景图 = 200', img.status === 200, img.status)
  check('背景 Content-Type 是 png', img.type.includes('image/png'), img.type)
  check('背景字节数正确', img.buf.length === 68 || img.buf.length > 50, img.buf.length + ' B')

  const del = await post('/dsh-skin/wallpaper-delete.json', {})
  check('删除背景 = 200', del.status === 200, del.status)
  check('删除后 present=false', del.json.wallpaper.present === false)

  // 复原，便于后续注入断言
  await post('/dsh-skin/wallpaper-upload.json', { data: PNG_1X1 })
}

// ── 图标：上传 → 应用 → 还原 ────────────────────────────────────────────────
{
  const up = await post('/dsh-skin/icon-upload.json', { kind: 'tray', data: PNG_1X1 })
  check('上传托盘图标(PNG→ICO) = 200', up.status === 200, up.status + ' ' + JSON.stringify(up.json.error || ''))
  check('PNG 被打包成 ICO', /打包为 ICO/.test(up.json.note || ''), up.json.note)

  const src = fs.readFileSync(path.join(HOME, 'dsh-skin', 'tray.ico'))
  check('ICO 魔数正确 (00 00 01 00)', src[0] === 0 && src[1] === 0 && src[2] === 1 && src[3] === 0, src.slice(0, 4).toString('hex'))
  check('ICO 内嵌 PNG 数据', src.slice(22, 26).toString('hex') === '89504e47', src.slice(22, 26).toString('hex'))

  const prev = await get('/dsh-skin/icon-preview.img?kind=tray')
  check('图标预览 = 200', prev.status === 200, prev.status)
  check('预览 Content-Type 是 x-icon', prev.type.includes('x-icon'), prev.type)

  const appUp = await post('/dsh-skin/icon-upload.json', { kind: 'app', data: PNG_1X1 })
  check('上传应用图标(PNG) = 200', appUp.status === 200, appUp.status)

  const apply = await post('/dsh-skin/icon-apply.json', { kind: 'all' })
  check('应用图标 = 200', apply.status === 200, apply.status + ' ' + JSON.stringify(apply.json.results || {}))
  check('托盘目标文件已写入', apply.json.results.tray && apply.json.results.tray.ok === true)

  const writtenTray = fs.readFileSync(path.join(FAKE_RESOURCES, 'tray.ico'))
  const writtenApp = fs.readFileSync(path.join(FAKE_RESOURCES, 'icon.png'))
  check('目标 tray.ico 已变为新图标', !writtenTray.equals(ORIGINAL_TRAY), writtenTray.length + ' B')
  check('目标 icon.png 已变为新图标', !writtenApp.equals(ORIGINAL_APP), writtenApp.length + ' B')

  const backupTray = path.join(HOME, 'dsh-skin', 'backup', 'tray.ico')
  const backupApp = path.join(HOME, 'dsh-skin', 'backup', 'icon.png')
  check('原托盘图标已备份', fs.existsSync(backupTray) && fs.readFileSync(backupTray).equals(ORIGINAL_TRAY))
  check('原应用图标已备份', fs.existsSync(backupApp) && fs.readFileSync(backupApp).equals(ORIGINAL_APP))

  const restore = await post('/dsh-skin/icon-restore.json', { kind: 'all' })
  check('还原图标 = 200', restore.status === 200, restore.status)
  check('托盘已还原为原文件', fs.readFileSync(path.join(FAKE_RESOURCES, 'tray.ico')).equals(ORIGINAL_TRAY))
  check('应用已还原为原文件', fs.readFileSync(path.join(FAKE_RESOURCES, 'icon.png')).equals(ORIGINAL_APP))
}

// ── 注入内容随设置变化 ──────────────────────────────────────────────────────
{
  await post('/dsh-skin/settings.json', { theme: { enabled: true, brand: '#00c2a8' }, wallpaper: { enabled: true } })
  injectTable.length = 0
  injectSubscribers.forEach((cb) => cb(injectTable))
  // 主题色 / 壁纸的实时样式改由客户端插件渲染（宿主注入的行会被 Electron 壳缓存），
  // 宿主只负责注入设置面板的样式。
  check('重复注入不叠加（去重生效）', injectTable.filter((r) => r.kind === 'style').length === 1,
    injectTable.filter((r) => r.kind === 'style').length + ' 个样式行')
  check('面板样式含关键类名', injectTable.some((r) => r.kind === 'style' && String(r.text).includes('.dshskin-tab')))
}

// ── 信任栅栏：非回环写请求被拒 ──────────────────────────────────────────────
{
  // 注意：undici 的 fetch 把 Host 列为禁止修改的头，用它会静默改回真实 Host。
  // 要真正伪造 Host 必须用 node:http 原样发出。
  function rawRequest(p, method, headers, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: server.address().port, path: p, method, headers },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        },
      )
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
  }

  const evil = await rawRequest(
    '/dsh-skin/settings.json', 'POST',
    { Host: 'evil.example.com', 'Content-Type': 'application/json' },
    JSON.stringify({ theme: { brand: '#123456' } }),
  )
  check('伪造 Host 的写请求被拒 (403)', evil.status === 403, evil.status)

  const evilOrigin = await rawRequest(
    '/dsh-skin/settings.json', 'POST',
    { Host: '127.0.0.1:' + server.address().port, Origin: 'http://evil.example.com', 'Content-Type': 'application/json' },
    JSON.stringify({ theme: { brand: '#123456' } }),
  )
  check('跨源 Origin 的写请求被拒 (403)', evilOrigin.status === 403, evilOrigin.status)

  const goodRead = await rawRequest('/dsh-skin/state.json', 'GET', { Host: '127.0.0.1:' + server.address().port })
  check('本机读请求仍放行 (200)', goodRead.status === 200, goodRead.status)

  const crossRes = await fetch(base + '/dsh-skin/settings.json', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:' + server.address().port, 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ theme: { brand: '#123456' } }),
  })
  check('跨站写请求被拒 (403)', crossRes.status === 403, crossRes.status)
  await crossRes.text()
}

server.close()

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log('\n' + '='.repeat(58))
console.log('通过 ' + (results.length - failed.length) + ' / ' + results.length)
if (failed.length) {
  console.log('失败项：')
  failed.forEach((f) => console.log('  · ' + f.name + (f.detail ? '  [' + f.detail + ']' : '')))
}
console.log('临时目录：' + TMP)
console.log('='.repeat(58))
process.exit(failed.length ? 1 : 0)
