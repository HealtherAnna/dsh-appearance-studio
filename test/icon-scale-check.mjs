/**
 * 用真实大图验证 ICO 打包。
 *
 * 要证的不变量（逐条目）：
 *   ICO 目录项里的宽高字段（各 1 字节，256 用 0 表示）必须与该项内嵌 PNG 的
 *   实际尺寸一致，且存在多个尺寸档位（Windows 按位置取 16/32/48/256）。
 *   声明与实际不符的 ICO，浏览器不渲染、Windows 也可能不认。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-icon-scale-'))
const FAKE_RESOURCES = path.join(TMP, 'fake-install', 'resources')
fs.mkdirSync(FAKE_RESOURCES, { recursive: true })
fs.writeFileSync(path.join(FAKE_RESOURCES, 'app.asar'), 'x')
fs.writeFileSync(path.join(FAKE_RESOURCES, 'tray.ico'), 'ORIG')
fs.writeFileSync(path.join(FAKE_RESOURCES, 'icon.png'), 'ORIG')

process.env.DSH_HOME = path.join(TMP, 'home')
process.argv[2] = path.join(FAKE_RESOURCES, 'app.asar', 'dsh')

const realPath = path.join(os.homedir(), '.dsh', 'dsh-skin', 'app.png')
if (!fs.existsSync(realPath)) {
  console.log('找不到真实大图（' + realPath + '），跳过')
  process.exit(0)
}
const src = fs.readFileSync(realPath)
console.log('源图:', src.readUInt32BE(16) + 'x' + src.readUInt32BE(20), src.length + ' B')

const routes = []
const plugin = (await import('../lib/index.js')).default
plugin.apply({
  on() { return () => {} },
  effect(cb) { return cb() },
  inject(_services, cb) {
    cb({ webServer: { register(r) { routes.push(r); return () => {} }, tapIndex() { return () => {} } } })
  },
})

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const route = routes.find((r) => r.path === u.pathname)
  if (!route) { res.writeHead(404); res.end(); return }
  Promise.resolve(route.handler(req, res)).catch((err) => {
    try { res.writeHead(500); res.end(String(err)) } catch (e) { /* ignore */ }
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const res = await fetch('http://127.0.0.1:' + port + '/dsh-skin/icon-upload.json', {
  method: 'POST',
  headers: { 'content-type': 'application/json', host: '127.0.0.1:' + port },
  body: JSON.stringify({ kind: 'both', data: 'data:image/png;base64,' + src.toString('base64') }),
})
const json = await res.json()
console.log('HTTP', res.status, '|', json.note || json.error)

const ico = fs.readFileSync(path.join(process.env.DSH_HOME, 'dsh-skin', 'tray.ico'))
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const count = ico.readUInt16LE(4)
console.log('\nICO 总字节:', ico.length, ' 条目数:', count)

let allOk = count > 1
for (let i = 0; i < count; i += 1) {
  const base = 6 + i * 16
  const declW = ico[base] === 0 ? 256 : ico[base]
  const declH = ico[base + 1] === 0 ? 256 : ico[base + 1]
  const bytes = ico.readUInt32LE(base + 8)
  const off = ico.readUInt32LE(base + 12)
  const isPng = ico.subarray(off, off + 8).equals(PNG_SIG)
  const embW = isPng ? ico.readUInt32BE(off + 16) : -1
  const embH = isPng ? ico.readUInt32BE(off + 20) : -1
  const ok = isPng && embW === declW && embH === declH
  if (!ok) allOk = false
  console.log(`  [${i}] 声明 ${declW}x${declH}  实际 ${embW}x${embH}  ${bytes} B  ${ok ? 'OK' : 'MISMATCH'}`)
}

console.log(allOk ? '\nPASS: 多档尺寸齐全，且每档声明与实际一致' : '\nFAIL: 尺寸不一致或只有单档')

const appOut = fs.readFileSync(path.join(process.env.DSH_HOME, 'dsh-skin', 'app.png'))
console.log('app.png 保留原始尺寸:', appOut.readUInt32BE(16) + 'x' + appOut.readUInt32BE(20), '（关于面板用大图）')

server.close()
process.exit(allOk ? 0 : 1)
