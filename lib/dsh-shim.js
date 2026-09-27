// ============================================================================
// DSH 运行时 shim —— 让原版插件的 apply(root) 在桌宠里原样跑起来
// ============================================================================
// 原版 dsh-whale-widget / dsh-rice-widget 都是 DSH 插件，入口是
//     export default { name, inject, apply(root) }
// 它们用到的 root/ctx 触点：
//     root.effect(fn) / root.on('webserver/index-inject' | 'session/event' | ...)
//     root.inject(['webServer','credentials','connection'], cb)   ← 0.3.11+ 的入口形态：
//       主逻辑整个放进这个回调。桌宠里三个服务**当场就有**，所以同步调 cb 即可。
//     ctx.webServer.register / ctx.webServer.tapIndex
//     ctx.get('connection') / ctx.get('deepseekAccount')（可选服务，取不到会自动回退）
//     ctx.connection.requestRejection
//     ctx.credentials.resolve / ctx.credentials.set
// 本文件把这些补齐，于是 **vendor/ 下的原版源码一行都不用改**。
//
// 唯一的数据源缺口：「每轮消耗」原本来自 DSH 的会话事件。桌宠里没有 DSH，
// 由 lib/turns.js 用余额差值合成，并在服务层拦截 /dsh-whale/last-turn.json 下发。
import path from 'node:path'

export function createCtx({ server, dataDir, credentials, log = () => {} }) {
  const disposers = []
  const listeners = new Map()          // event -> Set<fn>
  const tapIndexFns = []
  const overrides = new Map()          // routePath -> handler（优先于原插件注册的）

  // —— 事件总线（替代 DSH 的会话事件流）——
  function on(event, fn) {
    if (typeof fn !== 'function') return () => {}
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(fn)
    const dispose = () => { try { listeners.get(event).delete(fn) } catch (err) {} }
    disposers.push(dispose)
    return dispose
  }
  function emit(event, ...args) {
    const set = listeners.get(event)
    if (!set) return
    for (const fn of Array.from(set)) {
      try { fn(...args) } catch (err) { log('事件处理出错', event, err && err.message) }
    }
  }

  // —— 信任栅栏：与 DSH 的 requestRejection 同形 ——
  // 返回 403 表示拒绝；返回 false / undefined 表示放行。
  function requestRejection(req) {
    try {
      if (server.hostAllowed(req)) return false
      return 403
    } catch (err) {
      return false
    }
  }
  const connection = { requestRejection }

  const ctx = {
    // 让原插件能按 DSH 的习惯拿到服务
    get(name) {
      if (name === 'connection') return connection
      return undefined
    },
    connection,

    webServer: {
      // 原插件的统一注册入口。若该路径已被 overrides 登记，就下发给覆盖处理器 ——
      // 这是「每轮消耗」在桌宠环境里的替代数据源，见 lib/turns.js。
      register(route) {
        const p = route && route.path
        if (p && overrides.has(p)) {
          const ov = overrides.get(p)
          return server.mount({ ...route, handler: (req, res) => ov(req, res, route.handler) })
        }
        return server.mount(route)
      },
      // 原插件用它往 DSH 的 index 页面注入 <script>。
      // 桌宠的页面是我们自己生成的，不需要注入；但把它记下来，
      // 这样"插件到底想注入什么"是可查的（也便于将来对齐）。
      tapIndex(fn) {
        if (typeof fn === 'function') tapIndexFns.push(fn)
        return () => {
          const i = tapIndexFns.indexOf(fn)
          if (i >= 0) tapIndexFns.splice(i, 1)
        }
      },
    },

    credentials,

    on,
    emit,

    effect(fn) {
      if (typeof fn !== 'function') return () => {}
      let inner = null
      try { inner = fn() } catch (err) { log('effect 执行出错', err && err.message) }
      const dispose = () => { try { if (typeof inner === 'function') inner() } catch (err) {} }
      disposers.push(dispose)
      return dispose
    },

    // DSH 的 root.inject(deps, cb)：等 deps 里的服务就绪后再调 cb（cb 收到带这些服务的 ctx）。
    // 桌宠里 webServer / credentials / connection 在 createCtx 时就已就绪，所以**同步**调 cb，
    // 语义与 DSH 的"等齐后调"一致（只是不用等）。cb 抛错就地拦下，不能让它炸掉宿主启动流程。
    // deps 参数仅作签名兼容，不校验（桌宠没有"服务未就绪"这个状态）。
    inject(_deps, cb) {
      if (typeof cb !== 'function') return () => {}
      try { cb(ctx) } catch (err) { log('inject 回调执行出错', err && err.message) }
      return () => {}
    },

    log: (...a) => log('[plugin]', ...a),
  }

  return {
    ctx,
    emit,
    tapIndexFns,
    /** 登记一条路由覆盖；必须在插件 apply() 之前调用 */
    override(pathname, handler) { overrides.set(pathname, handler) },
    disposeAll() {
      for (const d of disposers.splice(0)) {
        try { d() } catch (err) {}
      }
      listeners.clear()
    },
  }
}

/** 让插件把运行时数据写在桌宠自己的目录里，不去动用户真实的 ~/.dsh */
export function setDataHome(dir) {
  process.env.DSH_HOME = dir
  return path.resolve(dir)
}
