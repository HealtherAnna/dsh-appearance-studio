/**
 * dsh-skin-studio —— 客户端插件（设置页里的「外观工作室」）
 *
 * 由 DSH 的客户端模块加载器加载，所以必须是 __ModuleLoader__ factory 格式，
 * 而不是普通 ESM：react / react-dom 由 loader 的模块表提供（见 dshmarket 的约定）。
 *
 * 注册一个 `settings.section`，面板本体返回 React 元素。
 *
 * 两条必须守住的约定：
 *  1) apply() 里任何异常都会让**整个设置对话框空白**，所以全部包 try/catch，
 *     并且渲染外面套一层类组件错误边界。
 *  2) render 回调必须返回 React 元素（不是 DOM 元素）——dshmarket 也是
 *     react.createElement(...)。
 *
 * 面板样式不在这里写：宿主会把 assets/panel.css 作为 index-inject 的 style 行
 * 注入页面（与 DSH 官方主题包 bootThemeStyle 同一机制），类名统一 .dshskin- 前缀。
 */
window.__ModuleLoader__.load({
  id: 'dsh-skin-studio',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    var API = '/dsh-skin'
    var LIVE_ID = 'dsh-skin-live'

    /**
     * 诊断信标：把客户端插件的关键节点写进宿主日志（$DSH_HOME/dsh-skin/debug.log）。
     * 用 <img> 而不是 fetch，避免凭据 / 跨源问题掩盖真实原因。
     */
    function beacon(stage, extra) {
      try {
        var img = new Image()
        img.src = API + '/debug.json?stage=' + encodeURIComponent(stage)
          + '&extra=' + encodeURIComponent(String(extra == null ? '' : extra).slice(0, 400))
      } catch (err) { /* ignore */ }
    }

    beacon('client-load', 'module factory executed')

    /**
     * 拉一次服务端设置并**立即**应用样式。
     *
     * 必须在 apply() 里调用，而不能只放在设置面板组件里：面板组件只在用户打开
     * 「外观工作室」时才挂载，所以早先的写法要等打开面板之后主题色/背景才生效。
     */
    function applyFromServer(tag) {
      return request('/state.json').then(function (res) {
        if (!res || !res.ok) {
          beacon('apply-fail', tag + ' ' + JSON.stringify(res).slice(0, 150))
          return
        }
        var s = deepMerge(DEFAULTS, res.settings)
        liveSheet().textContent = buildLiveCss(s, !!(res.wallpaper && res.wallpaper.present))
        beacon('apply-ok', tag + ' theme=' + s.theme.enabled + '/' + s.theme.brand
          + ' wp=' + s.wallpaper.enabled + ' present=' + !!(res.wallpaper && res.wallpaper.present))
      }).catch(function (err) {
        beacon('apply-error', tag + ' ' + String((err && err.message) || err))
      })
    }

    /**
     * 上报视口中心那条 DOM 链各自的背景色。
     * 用来定位"到底是谁把背景图挡住了"——比反复猜遮罩数值可靠得多。
     */
    function probeCenter() {
      try {
        var el = document.elementFromPoint(
          Math.round(window.innerWidth / 2),
          Math.round(window.innerHeight * 0.62))
        var out = []
        var node = el
        for (var i = 0; i < 10 && node; i += 1) {
          var cs = getComputedStyle(node)
          var cls = node.className && typeof node.className === 'string'
            ? '.' + node.className.split(' ')[0].slice(0, 26) : ''
          out.push((node.tagName || '?') + (node.id ? '#' + node.id : '') + cls + '|' + cs.backgroundColor)
          node = node.parentElement
        }
        beacon('dom-chain', out.join(' > '))
      } catch (err) { /* ignore */ }
    }

    var PRESETS = [
      '#4d6bfe', '#3b82f6', '#0ea5e9', '#06b6d4', '#14b8a6', '#22c55e', '#84cc16', '#eab308', '#f59e0b',
      '#f97316', '#ef4444', '#ec4899', '#d946ef', '#a855f7', '#8b5cf6', '#6366f1', '#64748b', '#e11d48',
    ]

    var DEFAULTS = {
      version: 1,
      theme: { enabled: false, brand: '#4d6bfe', recolorStatics: false },
      wallpaper: { enabled: false, opacity: 1, blur: 0, dim: 0, mask: 0.8, fit: 'cover', layer: 'below', position: 'center' },
      icons: { tray: false, app: false, appliedAt: null },
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────
    function request(path, options) {
      var opts = options || {}
      var init = { method: opts.method || 'GET', credentials: 'same-origin', cache: 'no-store' }
      if (opts.body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' }
        init.body = JSON.stringify(opts.body)
      }
      return fetch(API + path, init).then(function (res) {
        return res.text().then(function (text) {
          try { return JSON.parse(text) } catch (err) { return { ok: false, error: String(text).slice(0, 300) } }
        })
      })
    }

    function deepMerge(base, patch) {
      var out = {}
      Object.keys(base || {}).forEach(function (k) { out[k] = base[k] })
      Object.keys(patch || {}).forEach(function (k) {
        var v = patch[k]
        if (v && typeof v === 'object' && !Array.isArray(v) && base && base[k] && typeof base[k] === 'object') {
          out[k] = deepMerge(base[k], v)
        } else out[k] = v
      })
      return out
    }

    function hexToRgb(hex) {
      var s = String(hex || '').replace('#', '')
      if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
      var n = parseInt(s, 16)
      if (!isFinite(n)) return { r: 77, g: 107, b: 254 }
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
    }
    function rgba(hex, alpha) {
      var c = hexToRgb(hex)
      return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')'
    }

    // ── 实时预览 ────────────────────────────────────────────────────────────
    // 主题色 / 背景的即时反馈。宿主注入的样式行只在宿主启动时被收集一次并缓存，
    // 所以「面板里改一下马上看到效果」必须由客户端自己写一个 style 完成。
    function liveSheet() {
      var node = document.getElementById(LIVE_ID)
      if (!node) {
        node = document.createElement('style')
        node.id = LIVE_ID
        ;(document.head || document.documentElement).appendChild(node)
      }
      return node
    }

    /**
     * 与宿主 lib/index.js 的 buildThemeCss / buildWallpaperCss 保持一致。
     * 主题色改的是 --dsw-static-deepseek-* 色阶（界面上的品牌蓝），
     * 不是 --dsw-alias-brand-primary（那是前景色）；并且必须带 !important，
     * 否则会被 body[data-ds-dark-theme] 以及 DSH 运行时注入的上百个 style 压掉。
     */
    function buildLiveCss(settings, wallpaperPresent) {
      var css = ''
      var sel = ':root,body,body[data-ds-dark-theme]'
      if (settings.theme.enabled) {
        var b = settings.theme.brand
        var scale = [
          [50, 8, '#ffffff'], [100, 13, '#ffffff'], [200, 22, '#ffffff'],
          [300, 38, '#ffffff'], [400, 64, '#ffffff'], [450, 84, '#ffffff'],
          [600, 84, '#000000'], [800, 66, '#000000'], [900, 54, '#000000'],
        ]
        var decls = ['--dsw-static-deepseek-500:' + b + ' !important']
        scale.forEach(function (row) {
          decls.push('--dsw-static-deepseek-' + row[0] + ':color-mix(in srgb, ' + b + ' ' + row[1] + '%, ' + row[2] + ') !important')
        })
        decls.push('--dsw-alias-state-business-primary:' + b + ' !important')
        decls.push('--dsw-alias-link:' + b + ' !important')
        decls.push('--dsw-focus-ring-color:color-mix(in srgb, ' + b + ' 62%, transparent) !important')
        decls.push('--dsw-alias-interactive-bg-hover-accent:' + rgba(b, 0.18) + ' !important')
        css += sel + '{' + decls.join(';') + '}'
        if (settings.theme.recolorStatics) {
          css += sel + '{' +
            '--dsw-alias-brand-primary:' + b + ' !important;' +
            '--dsw-alias-button-primary-fill:' + b + ' !important;' +
            '--dsw-alias-button-primary-hover:color-mix(in srgb, ' + b + ' 86%, #ffffff) !important;' +
            '--dsw-alias-button-primary-dimmed:' + rgba(b, 0.52) + ' !important;' +
            '--dsw-specific-sidebar-nav-item-active-accent:' + b + ' !important}'
        }
      }

      var wp = settings.wallpaper
      var on = wp.enabled && wallpaperPresent
      var root = document.documentElement
      if (root) root.classList.toggle('dshskin-wallpaper-on', !!on)
      if (document.body) document.body.classList.toggle('dshskin-wallpaper-on', !!on)
      if (on) {
        var sizeMap = { cover: 'cover', contain: 'contain', auto: 'auto', repeat: 'auto' }
        var repeat = wp.fit === 'repeat' ? 'repeat' : 'no-repeat'
        // 「图片浓度」实际控制的是**界面底色有多通透**，而不是图片自身的透明度：
        //   100% → 底色全透，背景图原样呈现（深色图就是深色）
        //   越低 → 底色越实，背景越淡、文字越清晰
        // 为什么不能拿它直接设图片的 opacity：图片底下还压着界面底色，图片调多实都没用，
        // 那层白色会照样把它冲淡 —— 这正是"浓度拉满仍是浅色、看不到原图深蓝"的原因。
        var mask = Math.max(0, Math.min(1, 1 - Number(wp.opacity)))
        css += 'html.dshskin-wallpaper-on,body.dshskin-wallpaper-on{background-color:transparent !important;background-image:none !important}'
        css += 'body.dshskin-wallpaper-on::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;' +
          'background-image:url("' + API + '/wallpaper.img?v=' + Date.now() + '");' +
          'background-size:' + (sizeMap[wp.fit] || 'cover') + ';background-repeat:' + repeat + ';' +
          'background-position:' + wp.position + ';' +
          'filter:' + (wp.blur > 0 ? 'blur(' + wp.blur + 'px)' : 'none') + ';opacity:1}'
        // 让主界面的大面积背景按这个通透度打折，背景图才透得出来
        // （否则面板用纯白 / 纯暗把图整个挡住）。
        var layers = [
          '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
          '--dsw-alias-bg-layer-3', '--dsw-specific-sidebar-fill',
        ]
        var lightDecls = layers.map(function (v) { return v + ':rgba(255,255,255,' + mask + ') !important' })
        var darkDecls = layers.map(function (v) { return v + ':rgba(21,21,23,' + mask + ') !important' })
        css += 'body.dshskin-wallpaper-on{' + lightDecls.join(';') + '}'
        css += 'body.dshskin-wallpaper-on[data-ds-dark-theme]{' + darkDecls.join(';') + '}'
        // 但**弹窗必须实心**：设置、确认框这类浮层若也半透明，内容会互相穿透。
        // DSH 的对话框带 role="dialog" / role="alertdialog"（其 CSS 里确有这两个选择器），
        // 在这里把变量重新设回不透明，作用域只覆盖对话框内部。
        var solid = layers.map(function (v) { return v + ':rgb(255,255,255) !important' }).join(';')
        var solidDark = layers.map(function (v) { return v + ':rgb(21,21,23) !important' }).join(';')
        css += '[role="dialog"],[role="alertdialog"]{' + solid + '}'
        css += 'body[data-ds-dark-theme] [role="dialog"],body[data-ds-dark-theme] [role="alertdialog"]{' + solidDark + '}'
        if (wp.dim > 0) {
          css += 'body.dshskin-wallpaper-on::after{content:"";position:fixed;inset:0;pointer-events:none;' +
            'background:rgba(0,0,0,' + wp.dim + ');z-index:-1}'
        }
      }
      return css
    }

    // ── 错误边界（类组件才有 componentDidCatch）────────────────────────────
    var Boundary = (function () {
      function B(props) {
        react.Component.call(this, props)
        this.state = { err: null }
      }
      B.prototype = Object.create(react.Component.prototype)
      B.prototype.constructor = B
      B.prototype.componentDidCatch = function (err) { this.setState({ err: err }) }
      B.prototype.render = function () {
        if (this.state && this.state.err) {
          var msg = String((this.state.err && this.state.err.message) || this.state.err)
          return h('div', { className: 'dshskin' },
            h('div', { className: 'dshskin-card' },
              h('h4', null, '外观工作室加载出错'),
              h('div', { className: 'dshskin-mono dshskin-err' }, msg),
              h('div', { className: 'dshskin-hint' }, '其它设置项不受影响。可以在控制台查看完整堆栈，或重启客户端再试。')))
        }
        return this.props.children
      }
      return B
    })()

    // ── 小组件 ──────────────────────────────────────────────────────────────
    function Row(props) {
      return h('div', { className: 'dshskin-row' + (props.between ? ' between' : '') }, props.children)
    }

    function Slider(props) {
      return h(Row, null,
        h('span', { className: 'dshskin-label', style: { width: 56 } }, props.label),
        h('input', {
          className: 'dshskin-range', type: 'range',
          min: props.min, max: props.max, step: props.step || 1,
          value: props.value,
          onChange: function (e) { props.onChange(Number(e.target.value)) },
        }),
        h('span', { className: 'dshskin-value' }, props.display))
    }

    function Select(props) {
      return h('select', {
        className: 'dshskin-select', value: props.value,
        onChange: function (e) { props.onChange(e.target.value) },
      }, props.options.map(function (o) {
        return h('option', { key: o[0], value: o[0] }, o[1])
      }))
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────
    function Section() {
      var st = react.useState(null); var view = st[0]; var setView = st[1]
      var tb = react.useState('theme'); var tab = tb[0]; var setTab = tb[1]
      var df = react.useState(null); var draft = df[0]; var setDraft = df[1]
      var bs = react.useState(''); var busy = bs[0]; var setBusy = bs[1]
      var nt = react.useState(null); var note = nt[0]; var setNote = nt[1]
      var ov = react.useState(false); var dragOver = ov[0]; var setDragOver = ov[1]

      var fileRef = react.useRef(null)
      var pendingKind = react.useRef('wallpaper')

      function load() {
        return request('/state.json').then(function (res) {
          if (res && res.ok) {
            setView(res)
            setDraft(deepMerge(DEFAULTS, res.settings))
          } else {
            setNote({ bad: true, text: '读取外观设置失败' })
          }
        }).catch(function (err) {
          setNote({ bad: true, text: '读取外观设置失败：' + String(err && err.message || err) })
        })
      }

      react.useEffect(function () { load() }, [])

      // 草稿一变就刷新实时预览
      react.useEffect(function () {
        if (!draft) return
        try {
          liveSheet().textContent = buildLiveCss(draft, !!(view && view.wallpaper && view.wallpaper.present))
        } catch (err) { /* 预览失败不影响功能 */ }
      }, [draft, view])

      function patch(section, key, value) {
        setDraft(function (d) {
          var next = deepMerge(d, {})
          next[section][key] = value
          return next
        })
      }

      function save() {
        setBusy('save'); setNote(null)
        request('/settings.json', { method: 'POST', body: draft }).then(function (res) {
          setBusy('')
          if (res && res.ok) {
            setView(function (v) { return Object.assign({}, v, { settings: res.settings }) })
            setDraft(deepMerge(DEFAULTS, res.settings))
            setNote({ text: '已保存。界面已即时更新（若个别区域没跟上，刷新页面即可）。' })
          } else {
            setNote({ bad: true, text: '保存失败：' + ((res && res.error) || '未知错误') })
          }
        }).catch(function (err) {
          setBusy(''); setNote({ bad: true, text: '保存失败：' + String(err && err.message || err) })
        })
      }

      function resetDraft() {
        setDraft(deepMerge(DEFAULTS, { icons: (view && view.settings && view.settings.icons) || DEFAULTS.icons }))
        setNote({ text: '已恢复默认值，还需要点「应用并保存」才会落盘。' })
      }

      function readFile(file, cb) {
        if (!file) return
        if (file.size > 16 * 1024 * 1024) { setNote({ bad: true, text: '图片太大（上限 16 MB）' }); return }
        var reader = new FileReader()
        reader.onload = function () { cb(reader.result) }
        reader.onerror = function () { setNote({ bad: true, text: '读取文件失败' }) }
        reader.readAsDataURL(file)
      }

      function uploadWallpaper(file) {
        readFile(file, function (dataUrl) {
          setBusy('wp'); setNote(null)
          request('/wallpaper-upload.json', { method: 'POST', body: { data: dataUrl } }).then(function (res) {
            setBusy('')
            if (res && res.ok) {
              setView(function (v) { return Object.assign({}, v, { settings: res.settings, wallpaper: res.wallpaper }) })
              setDraft(deepMerge(DEFAULTS, res.settings))
              setNote({ text: '背景已上传' })
            } else setNote({ bad: true, text: (res && res.error) || '上传失败' })
          }).catch(function (err) { setBusy(''); setNote({ bad: true, text: '上传失败：' + String(err && err.message || err) }) })
        })
      }

      function deleteWallpaper() {
        setBusy('wp'); setNote(null)
        request('/wallpaper-delete.json', { method: 'POST', body: {} }).then(function (res) {
          setBusy('')
          if (res && res.ok) {
            setView(function (v) { return Object.assign({}, v, { settings: res.settings, wallpaper: res.wallpaper }) })
            setDraft(deepMerge(DEFAULTS, res.settings))
            setNote({ text: '背景已删除' })
          }
        }).catch(function () { setBusy('') })
      }

      function uploadIcon(kind, file) {
        readFile(file, function (dataUrl) {
          setBusy('icon-' + kind); setNote(null)
          request('/icon-upload.json', { method: 'POST', body: { kind: kind, data: dataUrl } }).then(function (res) {
            setBusy('')
            if (res && res.ok) {
              setView(function (v) { return Object.assign({}, v, { icons: res.icons }) })
              setNote({ text: res.note || '图标已上传' })
            } else setNote({ bad: true, text: (res && res.error) || '上传失败' })
          }).catch(function (err) { setBusy(''); setNote({ bad: true, text: '上传失败：' + String(err && err.message || err) }) })
        })
      }

      function iconAction(action) {
        setBusy(action); setNote(null)
        request(action === 'icon-apply' ? '/icon-apply.json' : '/icon-restore.json', { method: 'POST', body: { kind: 'all' } })
          .then(function (res) {
            setBusy('')
            if (res) {
              setView(function (v) { return Object.assign({}, v, { icons: res.icons }) })
              var detail = Object.keys(res.results || {}).map(function (k) {
                var r = res.results[k]
                return k + '：' + (r.ok ? (action === 'icon-apply' ? ('已写入 ' + r.bytes + ' B') : ('已还原 ' + r.bytes + ' B')) : ('失败 ' + r.error))
              }).join('\n')
              setNote({ bad: !res.ok, text: (res.note || '') + (detail ? '\n' + detail : '') })
            }
          }).catch(function (err) { setBusy(''); setNote({ bad: true, text: '操作失败：' + String(err && err.message || err) }) })
      }

      if (!draft || !view) {
        return h('div', { className: 'dshskin' },
          h('h3', { className: 'dshskin-h1' }, '外观工作室'),
          h('div', { className: 'dshskin-hint' }, '正在读取外观设置…'))
      }

      var icons = view.icons || {}
      var trayInfo = icons.tray || {}
      var appInfo = icons.app || {}
      var wpInfo = view.wallpaper || {}

      // ── 主题色 ──
      var themePane = h('div', { className: 'dshskin-pane' },
        h(Row, { between: true },
          h('span', { className: 'dshskin-label' }, '启用自定义主题色'),
          h('input', {
            className: 'dshskin-check', type: 'checkbox', checked: !!draft.theme.enabled,
            onChange: function (e) { patch('theme', 'enabled', e.target.checked) },
          })),
        h(Row, null,
          h('input', {
            className: 'dshskin-color', type: 'color', value: draft.theme.brand,
            onChange: function (e) { patch('theme', 'brand', e.target.value) },
          }),
          h('input', {
            className: 'dshskin-hex', type: 'text', maxLength: 7, value: draft.theme.brand,
            onChange: function (e) {
              var v = e.target.value.trim()
              if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) patch('theme', 'brand', v)
            },
          })),
        h('div', { className: 'dshskin-swatches' }, PRESETS.map(function (c) {
          return h('button', {
            key: c, type: 'button', title: c,
            className: 'dshskin-sw', style: { background: c },
            'data-on': String(draft.theme.brand).toLowerCase() === c.toLowerCase() ? '1' : '0',
            onClick: function () { patch('theme', 'brand', c) },
          })
        })),
        h(Row, { between: true },
          h('span', { className: 'dshskin-label' }, '同时改按钮底色与前景色（激进模式）'),
          h('input', {
            className: 'dshskin-check', type: 'checkbox', checked: !!draft.theme.recolorStatics,
            onChange: function (e) { patch('theme', 'recolorStatics', e.target.checked) },
          })),
        h('div', { className: 'dshskin-hint' },
          '改的是 DSH 官方的品牌蓝色阶 ', h('code', null, '--dsw-static-deepseek-*'),
          '，链接 / 高亮 / 焦点环都会跟着派生。拖动色盘即时预览，点「应用并保存」才落盘。',
          '激进模式会连按钮的黑白底色一起改，可能影响可读性。'))

      // ── 背景图 ──
      var wallpaperPane = h('div', { className: 'dshskin-pane' },
        wpInfo.present
          ? h('img', { className: 'dshskin-thumb', alt: '', src: API + '/wallpaper.img?v=' + (wpInfo.mtime || 0) })
          : null,
        h('div', {
          className: 'dshskin-drop',
          'data-over': dragOver ? '1' : '0',
          onClick: function () { pendingKind.current = 'wallpaper'; if (fileRef.current) fileRef.current.click() },
          onDragOver: function (e) { e.preventDefault(); setDragOver(true) },
          onDragLeave: function () { setDragOver(false) },
          onDrop: function (e) {
            e.preventDefault(); setDragOver(false)
            var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
            if (f) uploadWallpaper(f)
          },
        }, wpInfo.present ? '点击或拖入图片以替换当前背景' : '点击选择图片，或把图片拖到这里',
          h('br'), '支持 png / jpg / webp / gif / bmp'),
        h(Row, { between: true },
          h('span', { className: 'dshskin-label' }, '启用背景图'),
          h('input', {
            className: 'dshskin-check', type: 'checkbox', checked: !!draft.wallpaper.enabled,
            onChange: function (e) { patch('wallpaper', 'enabled', e.target.checked) },
          })),
        h(Slider, {
          label: '背景可见度', min: 2, max: 100, value: Math.round(draft.wallpaper.opacity * 100),
          display: Math.round(draft.wallpaper.opacity * 100) + '%',
          onChange: function (v) { patch('wallpaper', 'opacity', v / 100) },
        }),
        h(Slider, {
          label: '模糊', min: 0, max: 40, value: Math.round(draft.wallpaper.blur),
          display: Math.round(draft.wallpaper.blur) + 'px',
          onChange: function (v) { patch('wallpaper', 'blur', v) },
        }),
        h(Slider, {
          label: '压暗', min: 0, max: 90, value: Math.round(draft.wallpaper.dim * 100),
          display: Math.round(draft.wallpaper.dim * 100) + '%',
          onChange: function (v) { patch('wallpaper', 'dim', v / 100) },
        }),
        h(Row, null,
          h('span', { className: 'dshskin-label', style: { width: 56 } }, '填充'),
          h(Select, {
            value: draft.wallpaper.fit,
            options: [['cover', '铺满裁切'], ['contain', '完整显示'], ['auto', '原始大小'], ['repeat', '平铺']],
            onChange: function (v) { patch('wallpaper', 'fit', v) },
          }),
          h('span', { className: 'dshskin-label' }, '位置'),
          h(Select, {
            value: draft.wallpaper.position,
            options: [['center', '居中'], ['top', '顶部'], ['bottom', '底部'], ['left', '左侧'], ['right', '右侧']],
            onChange: function (v) { patch('wallpaper', 'position', v) },
          })),
        h('div', { className: 'dshskin-hint' },
          '背景图始终贴在最底层，不会盖住任何文字或窗口；设置、确认框这类弹窗保持实心，不受影响。',
          h('br'),
          '「背景可见度」拉满 = 界面底色全透，看到的就是原图本身的颜色；调低则底色变实、背景更淡、文字更清晰。'),
        h('div', { className: 'dshskin-bar' },
          h('button', {
            className: 'dshskin-btn', type: 'button', disabled: !wpInfo.present || busy === 'wp',
            onClick: deleteWallpaper,
          }, '删除背景')))

      // ── 图标 ──
      function iconSlot(key, title, accept, info, busyKey) {
        var src = info.source || {}
        return h('div', { className: 'dshskin-card' },
          h('h4', null, title),
          h('div', { className: 'dshskin-iconslot' },
            h('div', { className: 'dshskin-iconbox' },
              src.exists
                ? h('img', { alt: '', src: API + '/icon-preview.img?kind=' + key + '&v=' + (src.mtime || 0) })
                : h('span', { className: 'dshskin-empty' }, '未上传')),
            h('div', { className: 'dshskin-iconcol' },
              h('div', { className: 'dshskin-drop', style: { padding: '10px 12px' }, onClick: function () {
                pendingKind.current = key
                if (fileRef.current) {
                  fileRef.current.accept = accept
                  fileRef.current.click()
                }
              } }, busy === busyKey ? '正在处理…' : ('选择 ' + accept.replace(/,/g, ' / '))),
              h('div', { className: 'dshskin-mono' },
                '已上传：' + (src.exists ? src.bytes + ' B' : '无') + '\n' +
                '目标：' + (info.target || '未定位到安装目录') + '\n' +
                '目标文件：' + ((info.targetInfo && info.targetInfo.exists) ? info.targetInfo.bytes + ' B' : '缺失') +
                '　备份：' + ((info.backup && info.backup.exists) ? '有' : '无')))))
      }

      var iconsPane = h('div', { className: 'dshskin-pane' },
        // 一个入口就够了：Electron 主进程里窗口图标与托盘图标读的是同一个
        // resources/tray.ico；uploads PNG 时顺带更新「关于」面板的 icon.png。
        iconSlot('tray', '托盘 / 窗口图标', '.ico,.png', trayInfo, 'icon-tray'),
        h('div', { className: 'dshskin-warn' },
          '⚠ 图标写入的是 DSH 安装目录的 resources/tray.ico 与 resources/icon.png，必须重启客户端才生效。' +
          '原图标会自动备份，可随时「还原原图标」。DSH 升级会覆盖这两个文件，升级后重新点一次「应用到客户端」即可。'),
        h(Row, null,
          h('span', { className: 'dshskin-label' }, '安装目录'),
          h('span', { className: 'dshskin-mono', style: { flex: 1 } },
            (icons.resources || '未定位到') + (icons.writable === false ? '（不可写）' : ''))),
        h('div', { className: 'dshskin-bar' },
          h('button', {
            className: 'dshskin-btn', type: 'button', disabled: busy === 'icon-restore',
            onClick: function () { iconAction('icon-restore') },
          }, '还原原图标'),
          h('button', {
            className: 'dshskin-btn primary', type: 'button', disabled: busy === 'icon-apply',
            onClick: function () { iconAction('icon-apply') },
          }, '应用到客户端')))

      return h('div', { className: 'dshskin' },
        h('input', {
          ref: fileRef, type: 'file', style: { display: 'none' },
          onChange: function (e) {
            var f = e.target.files && e.target.files[0]
            var kind = pendingKind.current
            e.target.value = ''
            if (!f) return
            if (kind === 'wallpaper') uploadWallpaper(f)
            else uploadIcon('both', f)
          },
        }),
        h('h3', { className: 'dshskin-h1' }, '外观工作室'),
        h('p', { className: 'dshskin-sub' }, '换主题色、放背景图、替换桌面与托盘图标。改动即时预览，「应用并保存」后长期生效。'),

        h('div', { className: 'dshskin-tabs' },
          h('button', { type: 'button', className: 'dshskin-tab', 'data-on': tab === 'theme' ? '1' : '0', onClick: function () { setTab('theme') } }, '主题色'),
          h('button', { type: 'button', className: 'dshskin-tab', 'data-on': tab === 'wallpaper' ? '1' : '0', onClick: function () { setTab('wallpaper') } }, '背景图'),
          h('button', { type: 'button', className: 'dshskin-tab', 'data-on': tab === 'icons' ? '1' : '0', onClick: function () { setTab('icons') } }, '图标')),

        h('div', { className: 'dshskin-pane', hidden: tab !== 'theme' }, themePane.props.children),
        h('div', { className: 'dshskin-pane', hidden: tab !== 'wallpaper' }, wallpaperPane.props.children),
        h('div', { className: 'dshskin-pane', hidden: tab !== 'icons' }, iconsPane.props.children),

        // 「恢复默认 / 应用并保存」只属于「主题色 / 背景图」这两个需要落盘设置的页签。
        // 图标页签是即时生效的（应用到客户端 / 还原原图标），再摆一套"保存"只会让人分不清
        // 该点哪个 —— 而且它的改动根本不由这两个按钮承担。
        (tab === 'theme' || tab === 'wallpaper')
          ? h('div', { className: 'dshskin-bar' },
              h('button', { className: 'dshskin-btn', type: 'button', onClick: resetDraft }, '恢复默认'),
              h('button', {
                className: 'dshskin-btn primary', type: 'button', disabled: busy === 'save',
                onClick: save,
              }, busy === 'save' ? '保存中…' : '应用并保存'))
          : null,

        note ? h('div', { className: 'dshskin-note ' + (note.bad ? 'dshskin-err' : 'dshskin-ok') }, note.text) : null)
    }

    // ── 插件导出 ────────────────────────────────────────────────────────────
    var name = 'dsh-skin-studio'
    var inject = ['slots']

    function apply(ctx) {
      beacon('client-apply', 'slots=' + (ctx && ctx.slots ? 'yes' : 'no'))
      // ① 启动即应用：不能只依赖设置面板里的 useEffect —— 那个组件只在用户打开
      //    「外观工作室」时才挂载，所以早先的实现要打开面板主题色/背景才生效。
      applyFromServer('boot')
      // 界面渲染完再探一次视口中心的 DOM 背景，用于定位遮挡来源
      setTimeout(function () { probeCenter() }, 2500)
      try {
        // 必须包在 slots.inject 里：settings.section 这个槽在插件加载时可能还没建好，
        // 直接 register 会静默失效。官方模板与 dshmarket 都是这么包的。
        ctx.slots.inject('settings.section', function () {
          try {
            ctx.slots.register({
              name: 'settings.section',
              id: 'skin-studio',
              order: 45,
              label: function () { return '外观工作室' },
            }, function () {
              return h(Boundary, null, h(Section, null))
            })
            beacon('client-registered', 'ok')
          } catch (err) {
            beacon('client-register-fail', String((err && err.message) || err))
          }
        })
      } catch (err) {
        beacon('client-apply-fail', String((err && err.message) || err))
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
