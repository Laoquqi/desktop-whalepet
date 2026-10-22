// ============================================================================
// 外壳页面路由
// ============================================================================
// 页面**由本地服务发出**（而不是用 file:// 打开）—— 这样页面与所有
// /dsh-whale/* /dsh-rice/* 接口同源，挂件里那些绝对路径
// （fetch('/dsh-whale/balance.json')、img.src='/dsh-whale/rua.gif'…）
// 不用做任何改写就能命中。
//
// 脚本/样式放在独立文件里（而不是内联），是为了能用严格 CSP：
// script-src 'self'，不需要 'unsafe-inline'。
import fs from 'node:fs'
import path from 'node:path'

const SHELL_FILES = {
  '/': ['renderer/index.html', 'text/html; charset=utf-8'],
  '/shell.js': ['renderer/shell.js', 'application/javascript; charset=utf-8'],
  '/shell.css': ['renderer/shell.css', 'text/css; charset=utf-8'],
  // 拖动物理（移植自 dsh-pet 的 pet/physics.py）单独一个文件，别把 shell.js 撑肥
  '/drag-physics.js': ['renderer/drag-physics.js', 'application/javascript; charset=utf-8'],
  // 「偷吃白饭」的菜单入口（把浮动小标签收进 ☰ 菜单）
  '/rice-entry.js': ['renderer/rice-entry.js', 'application/javascript; charset=utf-8'],
  // 挂件自带面板往左让开一级菜单（只改 margin-left，不动 left/transform）
  '/panel-focus.js': ['renderer/panel-focus.js', 'application/javascript; charset=utf-8'],
  // 桌宠菜单扩展（删掉避让滚动条/宽度，加打开 dsh 网页端）
  '/menu-extras.js': ['renderer/menu-extras.js', 'application/javascript; charset=utf-8'],
  // 面板居中（二级/三级面板显示在屏幕正中央且可拖动）
  '/menu-center.js': ['renderer/menu-center.js', 'application/javascript; charset=utf-8'],
  // 米粒唱歌那一行的音乐选择（全在外壳里做，vendor 保持原版）
  '/rice-songs.js': ['renderer/rice-songs.js', 'application/javascript; charset=utf-8'],
  // 米粒面板版面修补（带单位的行永远不换行：滑块可压缩、数字与单位不换行）
  '/rice-layout.js': ['renderer/rice-layout.js', 'application/javascript; charset=utf-8'],
  // 「识别歌曲和作者」：菜单开关 + 识别结果气泡
  '/now-playing.js': ['renderer/now-playing.js', 'application/javascript; charset=utf-8'],
  // 闭眼贴图（放在 vendor/rice/assets 里，但 rice 的素材白名单不认它 ——
  // 那是它自己维护的映射表，我们不动 vendor，改由外壳直接发）
  // ⚠️ 文件名是 **ASCII**（whale_closeeyes.png）—— 这两个文件原先叫
  //    「小鲸鱼闭眼.png」「小鲸鱼笑.png」，后来统一改成了 ASCII 名。
  //    改名的好处很实在：中文文件名在这条链路上要过 URL/打包/文件系统三道编码，
  //    一旦哪一环没按 UTF-8 走，就会变成"读不到文件 → 外壳回 500 → 图默默不显示"
  //    （这次就是因为只改了文件名、没同步改这里的路由，两张图一起 500）。
  '/whale-sprite-closeeye.png': ['vendor/rice/assets/whale_closeeyes.png', 'image/png'],
  // 「笑一下」贴图（偷吃成功 / 余额告急时闪 2 秒）。同样放在 vendor/rice/assets 里、
  // 由外壳直接发 —— 理由和上面那张闭眼图完全一样（rice 的白名单是它自己维护的映射表）。
  '/whale-sprite-laugh.png': ['vendor/rice/assets/whale_laugh.png', 'image/png'],
  // 「笑一下」的贴图切换逻辑
  '/laugh-sprite.js': ['renderer/laugh-sprite.js', 'application/javascript; charset=utf-8'],
  // 多状态形象的 9 张图（vendor/whale/assets/expressions/ 下，逐个列出）
  '/whale-exp/main.png': ['vendor/whale/assets/expressions/main.png', 'image/png'],
  '/whale-exp/stroking.png': ['vendor/whale/assets/expressions/stroking.png', 'image/png'],
  '/whale-exp/angry.png': ['vendor/whale/assets/expressions/angry.png', 'image/png'],
  '/whale-exp/disappointed.png': ['vendor/whale/assets/expressions/disappointed.png', 'image/png'],
  '/whale-exp/shy.png': ['vendor/whale/assets/expressions/shy.png', 'image/png'],
  '/whale-exp/exhausted.png': ['vendor/whale/assets/expressions/exhausted.png', 'image/png'],
  '/whale-exp/close_eyes.png': ['vendor/whale/assets/expressions/close_eyes.png', 'image/png'],
  '/whale-exp/half_closed_eyes.png': ['vendor/whale/assets/expressions/half_closed_eyes.png', 'image/png'],
  '/whale-exp/half_open_eyes.png': ['vendor/whale/assets/expressions/half_open_eyes.png', 'image/png'],
  // 米粒面板「角色」那一行 + 抓现行时的闭眼贴图
  '/rice-role.js': ['renderer/rice-role.js', 'application/javascript; charset=utf-8'],
  // 多状态形象（从 For-WinDesktop 版移植）
  '/whale-expression.js': ['renderer/whale-expression.js', 'application/javascript; charset=utf-8'],
  // 多桌宠：位置上报 + 相撞反应
  '/pet-collide.js': ['renderer/pet-collide.js', 'application/javascript; charset=utf-8'],
  // 立绘 transform 合成器（点击Q弹 / 弹弓形变 / 黄金回旋 三路合成）
  '/sprite-xform.js': ['renderer/sprite-xform.js', 'application/javascript; charset=utf-8'],
  // 黄金回旋（移植自 pet/golden_spin.py）
  '/golden-spin.js': ['renderer/golden-spin.js', 'application/javascript; charset=utf-8'],
  // 拖文件吃掉（移植自 pet/file_eater.py）
  '/file-eater.js': ['renderer/file-eater.js', 'application/javascript; charset=utf-8'],
  // 通透模式（菜单开关：循环播背景音乐 + 循环点击动画）
  '/tongtou-mode.js': ['renderer/tongtou-mode.js', 'application/javascript; charset=utf-8'],
  // 菜单太高时顶部会被窗口裁掉 → 自动限高 + 可滚动
  '/menu-fit.js': ['renderer/menu-fit.js', 'application/javascript; charset=utf-8'],
}

// ----------------------------------------------------------------------------
// 背景音乐（通透模式用）
// ----------------------------------------------------------------------------
// ⚠️ 路由名是 **ASCII**（/pet-music.mp3），实际文件在 vendor/whale/assets/music/ 下，
//    文件名带中文、空格、括号。**不能**把那个文件名直接当 URL：
//    中文名要过 URL 编码 / asar 打包 / 文件系统三道，哪一环没按 UTF-8 走
//    就是"读不到 → 500 → 图/声音默默不出现"（本项目闭眼贴图那次就是这么坏的）。
//
// ⚠️ 必须支持 **Range**：<audio loop> 循环、以及浏览器预读时都会发
//    `Range: bytes=...`。只会回 200 全量的话，循环处会有可闻的断点
//    （每次都要把 7MB 从头读一遍）。
//
// ⚠️⚠️ **不用 fs.createReadStream** —— 打包后文件在 asar 里，
//    而 asar 对 `createReadStream(path, {start,end})` 的区间支持并不可靠
//    （dev 模式跑得好好的，装成 exe 就变成"有声音但循环/拖动进度是坏的"，
//      这种只在打包后才暴露的坑最难查）。
//    改成 readFileSync + 切片：asar 下 readFileSync 是官方保证可用的，
//    7.6MB 读一次缓存在内存里，后面每个 Range 请求都是内存切片。
function mountMusic(server, rootDir) {
  const dir = path.join(rootDir, 'vendor/whale/assets/music')
  const pick = () => {
    try {
      const f = fs.readdirSync(dir)
        .filter((n) => /\.(mp3|m4a|aac|ogg|wav|flac)$/i.test(n))
        .sort()[0]
      return f ? path.join(dir, f) : null
    } catch (err) {
      return null
    }
  }
  // 缓存一份（换歌/换文件时按 mtime+size 自动失效）
  let cache = null
  const load = (abs) => {
    const st = fs.statSync(abs)
    if (cache && cache.abs === abs && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache
    const buf = fs.readFileSync(abs)
    cache = { abs, mtimeMs: st.mtimeMs, size: buf.length, buf }
    return cache
  }
  server.mount({
    kind: 'exact',
    path: '/pet-music.mp3',
    handler: (req, res) => {
      const abs = pick()
      if (!abs) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('no audio file in vendor/whale/assets/music/')
        return
      }
      let file
      try {
        file = load(abs)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('music read failed: ' + String((err && err.message) || err))
        return
      }
      const buf = file.buf
      const size = file.size
      res.setHeader('Content-Type', 'audio/mpeg')
      res.setHeader('Accept-Ranges', 'bytes')
      // 本地文件，缓存住：循环时不再反复读盘
      res.setHeader('Cache-Control', 'public, max-age=3600')

      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim())
      if (m && (m[1] || m[2])) {
        let start
        let end
        if (!m[1]) {
          // 后缀式 `bytes=-N`（要最后 N 字节）—— 浏览器预读/循环时会发这种
          const n = parseInt(m[2], 10)
          start = Math.max(0, size - (Number.isFinite(n) ? n : 0))
          end = size - 1
        } else {
          start = parseInt(m[1], 10)
          end = m[2] ? parseInt(m[2], 10) : size - 1
        }
        if (!Number.isFinite(start) || start < 0) start = 0
        if (!Number.isFinite(end) || end >= size) end = size - 1
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` })
          res.end()
          return
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        })
        res.end(buf.subarray(start, end + 1))
        return
      }
      res.writeHead(200, { 'Content-Length': String(size) })
      res.end(buf)
    },
  })
  return '/pet-music.mp3'
}

export function mountShell(server, rootDir) {
  const mounted = []
  for (const [route, [rel, mime]] of Object.entries(SHELL_FILES)) {
    const abs = path.join(rootDir, rel)
    server.mount({
      kind: 'exact',
      path: route,
      handler: (req, res) => {
        let body
        try {
          body = fs.readFileSync(abs)
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('shell file missing: ' + rel)
          return
        }
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'no-store',
          'Content-Length': String(body.length),
        })
        res.end(body)
      },
    })
    mounted.push(route)
  }
  // 通透模式的背景音乐（单独挂：要支持 Range，不能走上面那套 readFileSync 全量返回）
  try {
    mounted.push(mountMusic(server, rootDir))
  } catch (err) {
    // 音乐挂不上不该影响整个外壳
  }
  return mounted
}

export { SHELL_FILES }
