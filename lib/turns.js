// ============================================================================
// 「每轮消耗」合成器 —— 桌宠环境里没有 DSH 会话事件，用它顶上
// ============================================================================
// 背景：
//   原版鲸鱼宿主靠 DSH 的 session/event（assistant/message + turn/end）算出
//   「这一轮对话花了多少钱」，下发给 /dsh-whale/last-turn.json。
//   rice 的「偷吃白饭」正是读这个接口来决定吃几口 —— 没有它，
//   随机偷吃的骰子永远不会掷（骰子绑在"结算一轮"上），功能等于废一半。
//
// 做法：
//   桌宠里改从**账号级今日用量**（/dsh-whale/balance.json 的 todayUsage）取信号：
//   它每涨一次，就当作"又消耗了一轮"，增量就是这一轮的钱。
//   这条链路完全在本机，不额外请求任何外部接口 —— balance.json 本身有缓存。
//
//   然后把合成结果**拦截 /dsh-whale/last-turn.json 下发**（见 dsh-shim 的 override），
//   于是 rice 一行都不用改就能拿到每轮金额。
//
// 为什么不是"余额下降"：
//   余额下降分不清「消费」和「充值失败/退款/换币种」，todayUsage 已经把口径理好了，
//   直接用它更准（也顺带继承了上游的跨天归档与币种处理）。
import { EventEmitter } from 'node:events'

const DEFAULT_POLL_MS = 10000
const MIN_DELTA = 0.0001        // 增量小于这个数就不算一轮（滤掉浮点噪声）

export function createTurnSynthesizer({ port = 0, log = () => {}, pollMs = DEFAULT_POLL_MS, enabled = true }) {
  const bus = new EventEmitter()
  let timer = null
  let curPort = port
  let baseline = null          // 上次看到的 todayUsage
  let seq = 0
  let lastTurn = null
  let lastError = null
  let running = false
  let stopped = false

  function emitTurn(amount, at) {
    seq += 1
    lastTurn = { seq, turn: seq, amount, tokens: 0, ts: at }
    log(`合成一轮消耗：${amount.toFixed(4)}（seq=${seq}）`)
    bus.emit('turn', lastTurn)
  }

  async function tick() {
    if (running || stopped) return
    if (!curPort) return                       // 服务还没起来
    running = true
    try {
      const res = await fetch(`http://127.0.0.1:${curPort}/dsh-whale/balance.json`, {
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const j = await res.json()
      lastError = null
      const n = j && typeof j.todayUsage === 'number' && isFinite(j.todayUsage) ? j.todayUsage : null
      if (n === null) return                       // 还没算出今日用量：这轮不算
      if (baseline === null) { baseline = n; return }   // 第一轮只建基线，不吃
      if (n < baseline) {                          // 跨天归零 / 账本重置：重建基线，不算一轮
        baseline = n
        return
      }
      const delta = n - baseline
      baseline = n
      if (delta > MIN_DELTA) emitTurn(delta, Date.now())
    } catch (err) {
      // 拿不到就安静跳过 —— 下一轮再来。绝不因为一次失败就让桌宠出问题。
      lastError = String((err && err.message) || err)
    } finally {
      running = false
    }
  }

  function start() {
    if (timer || !enabled) return
    timer = setInterval(tick, pollMs)
    if (timer.unref) timer.unref()
    // 首次稍等一会儿再取，给鲸鱼宿主留出启动和第一次余额拉取的时间
    setTimeout(tick, 3000)
  }

  function stop() {
    stopped = true
    if (timer) { clearInterval(timer); timer = null }
  }

  /**
   * 拦截 /dsh-whale/last-turn.json。
   * 有合成数据就用合成数据；没有就原样交给原版处理器（保持原行为）。
   */
  function handleLastTurn(req, res, originalHandler) {
    try {
      if (!lastTurn) return originalHandler(req, res)
      const payload = { ok: true, seq: lastTurn.seq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, ts: lastTurn.ts }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(payload))
    } catch (err) {
      log('last-turn 拦截出错', err && err.message)
      try { return originalHandler(req, res) } catch (e2) {}
    }
  }

  return {
    start, stop, bus, handleLastTurn,
    /** 服务起来之后再告诉它端口（构造时还不知道） */
    setPort(p) { curPort = Number(p) || 0 },
    get lastTurn() { return lastTurn },
    get seq() { return seq },
    get lastError() { return lastError },
    get baseline() { return baseline },
    setEnabled(v) {
      enabled = !!v
      if (enabled) { stopped = false; start() } else stop()
    },
  }
}
