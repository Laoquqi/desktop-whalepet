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
  return mounted
}

export { SHELL_FILES }
