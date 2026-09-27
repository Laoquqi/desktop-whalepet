// ============================================================================
// 本地 HTTP 服务 —— 把原插件注册的路由挂上来
// ============================================================================
// 只绑定 127.0.0.1，端口由系统分配（0），避免和别的程序撞端口。
//
// 为什么还要做「信任栅栏」：
//   服务虽然只监听回环地址，但**本机上任何一个网页**都能向 127.0.0.1:<port> 发请求。
//   攻击手法是 DNS 重绑定：恶意页面把自己的域名解析到 127.0.0.1，
//   于是浏览器认为"同源"，就能读到本服务的响应（里面有余额、账目）。
//   判据：请求的 Host 头必须是我们自己的 host:port —— 被重绑定时 Host 会是攻击者的域名。
//   这正是 DSH 官方 requestRejection 做的事，这里按同一思路实现。
import http from 'node:http'

const MAX_BODY = 8 * 1024 * 1024

export function createServer({ log = () => {} } = {}) {
  const routes = []          // { kind, path, handler }
  let server = null
  let port = 0

  function mount(route) {
    routes.push(route)
    return () => {
      const i = routes.indexOf(route)
      if (i >= 0) routes.splice(i, 1)
    }
  }

  function hostAllowed(req) {
    const host = String(req.headers.host || '')
    // 允许的形态：127.0.0.1:port / localhost:port / [::1]:port
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
  }

  function findRoute(pathname) {
    for (const r of routes) {
      if (r.kind === 'exact' && r.path === pathname) return r
      if (r.kind === 'prefix' && pathname.startsWith(r.path)) return r
    }
    return null
  }

  function handle(req, res) {
    // ① 信任栅栏
    if (!hostAllowed(req)) {
      res.statusCode = 403
      res.end()
      return
    }
    // ② 解析路径（base 用固定的假 host，避免 Host 头影响解析）
    let pathname = '/'
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
    } catch (err) {
      res.statusCode = 400
      res.end()
      return
    }
    const route = findRoute(pathname)
    if (!route || typeof route.handler !== 'function') {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('not found: ' + pathname)
      return
    }
    // ③ 单条路由出错不许把整个服务弄挂
    Promise.resolve()
      .then(() => route.handler(req, res))
      .catch((err) => {
        log('route error', pathname, err && err.message)
        try {
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
          } else {
            res.end()
          }
        } catch (e2) {}
      })
  }

  async function listenOn(p) {
    return new Promise((resolve, reject) => {
      const onErr = (err) => { server.removeListener('listening', onOk); reject(err) }
      const onOk = () => { server.removeListener('error', onErr); resolve() }
      server.once('error', onErr)
      server.once('listening', onOk)
      server.listen(p, '127.0.0.1')
    })
  }

  /**
   * 启动服务。
   *
   * ⚠️ 为什么支持指定端口，而不是永远用随机端口：
   *    浏览器（含 Electron）的 **localStorage 是按「协议+主机+端口」隔离的** ——
   *    端口一变，origin 就变，localStorage 就是全新的一份。
   *    挂件把位置、缩放、当前角色、以及大量设置都存在 localStorage 里，
   *    所以随机端口会导致**每次启动她都会回到右下角、角色和设置全部复位**。
   *    （实测确认：随机端口跑十几次后，Local Storage 里躺着 18 个不同 origin。）
   *
   *    做法：调用方把一个上次用过的端口传进来，先试它；被占用才退回随机端口。
   *    退回去的那一次会丢一次 localStorage，但下次会把新端口记下来，之后就稳定了。
   */
  async function start(preferredPort = 0) {
    let used = 0
    if (preferredPort) {
      server = http.createServer(handle)
      server.on('clientError', onClientError)
      try {
        await listenOn(preferredPort)
        used = preferredPort
      } catch (err) {
        log(`首选端口 ${preferredPort} 不可用（${err && err.code}），改用随机端口`)
        try { server.close() } catch (e) {}
        server = null
      }
    }
    if (!server) {
      server = http.createServer(handle)
      server.on('clientError', onClientError)
      await listenOn(0)
    }
    port = server.address().port
    log('本地服务已启动 http://127.0.0.1:' + port)
    return port
  }

  function onClientError(err, socket) {
    try { socket.destroy() } catch (e) {}
  }

  function stop() {
    try { if (server) server.close() } catch (err) {}
    server = null
  }

  return { mount, start, stop, get port() { return port }, hostAllowed, routes }
}

export { MAX_BODY }
