// Balance observations are not a transaction API. Keep them separate from
// token estimates and require explicit credits/debits for reconciliation.
export const ACCOUNTING_VERSION = 1
const SCALE = 100000000

export function moneyUnits(value) {
  const n = Number(value)
  const units = Math.round(n * SCALE)
  if (!Number.isFinite(n) || !Number.isSafeInteger(units)) throw new Error('金额无效或超出可记账范围')
  return units
}

export function preciseMoney(value) { return moneyUnits(value) / SCALE }
export function addMoney(a, b) { return sumMoney([a, b]) }
export function sumMoney(values) {
  let units = 0
  for (const value of values) units += moneyUnits(value)
  if (!Number.isSafeInteger(units)) throw new Error('金额合计超出可记账范围')
  return units / SCALE
}

export function beijingDay(time = Date.now()) {
  const d = new Date(Number(time) + 8 * 3600000)
  if (!Number.isFinite(d.getTime())) throw new Error('无效的观测时间')
  return d.toISOString().slice(0, 10)
}

export function dayOffset(day, offset) {
  return beijingDay(Date.parse(day + 'T00:00:00+08:00') + offset * 86400000)
}

function currentBook(ledger) {
  const a = ledger.accounting
  return a && a.version === ACCOUNTING_VERSION && a.books && a.books[a.active]
}

export function accountingDays(ledger) { return Object.keys(currentBook(ledger)?.days || {}) }

function observedAmount(day) {
  const c = day.correction
  return (c ? c.amountUnits + day.debitUnits - c.debitUnits : day.debitUnits) / SCALE
}

function revisionOf(ledger, day) {
  return [ledger.accounting.active, day.day, day.firstAt, day.lastUnits,
    day.debitUnits, day.creditUnits, day.revision || 0].join(':')
}

export function balanceSummary(ledger, day = beijingDay()) {
  const book = currentBook(ledger)
  const row = book && book.days && book.days[day]
  if (!row) return null
  const correction = row.correction
  const needsReview = row.creditUnits > (correction ? correction.creditUnits : 0)
  const source = needsReview ? 'balance-needs-review' : correction ? 'balance-corrected' : 'balance-observed'
  return {
    day, amount: preciseMoney(observedAmount(row)), currency: book.currency, source,
    label: needsReview ? '已观测消费 · 待核对余额调整' : correction ? '已校正消费' : '已观测消费',
    firstObservedAt: row.firstAt, lastObservedAt: row.lastAt,
    openingBalance: row.openingUnits / SCALE, currentBalance: row.lastUnits / SCALE,
    observedDecrease: row.debitUnits / SCALE, observedIncrease: row.creditUnits / SCALE,
    needsReview, partialDay: true, revision: revisionOf(ledger, row),
    credits: correction ? correction.creditsUnits / SCALE : null,
    otherDebits: correction ? correction.otherDebitsUnits / SCALE : null,
    correctedAt: correction ? correction.at : null,
  }
}

// Mutates the caller-owned ledger; this module itself never reads or writes files.
export function observeBalance(ledger, snapshot) {
  const at = Number(snapshot.at ?? Date.now())
  const day = beijingDay(at)
  const units = moneyUnits(snapshot.balance)
  const currency = String(snapshot.currency || 'CNY').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('余额币种无效')
  const scope = String(snapshot.scope || 'default')
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(scope)) throw new Error('账户标识无效')
  const context = scope + '-' + currency
  let a = ledger.accounting
  if (!a || a.version !== ACCOUNTING_VERSION) {
    // Legacy totals have no trustworthy recharge metadata. Preserve them for
    // reference; begin a new explicitly timed observation window.
    a = ledger.accounting = {
      version: ACCOUNTING_VERSION, active: context, books: {}, migratedAt: at,
      legacyHistory: { ...(ledger.history || {}) },
    }
  }
  a.books ||= {}
  let book = a.books[context]
  if (!book) book = a.books[context] = { currency, days: {} }
  // Ignore duplicate/out-of-order samples, including a late sample from yesterday.
  if (book.lastAt != null && at <= book.lastAt) return balanceSummary(ledger, ledger.date)
  a.active = context
  let row = book.days[day]
  if (!row) {
    row = book.days[day] = {
      day, firstAt: at, lastAt: at, openingUnits: units, lastUnits: units,
      debitUnits: 0, creditUnits: 0, revision: 0, correction: null,
    }
  } else {
    const delta = row.lastUnits - units
    if (delta > 0) row.debitUnits += delta
    if (delta < 0) row.creditUnits -= delta
    row.lastUnits = units
    row.lastAt = at
  }
  book.lastAt = at
  ledger.date = day
  // Compatibility fields for the existing UI and old settings writers.
  ledger.dayStart = row.openingUnits / SCALE
  ledger.lastBalance = row.lastUnits / SCALE
  const summary = balanceSummary(ledger, day)
  ledger.todayUsage = summary.amount
  ledger.history ||= {}
  ledger.history[day] = summary.amount
  return summary
}

function adjustmentUnits(value, required = false) {
  if (value === '' || value === null || value === undefined) {
    if (required) throw new Error('请填写本统计区间的累计到账金额，未充值请填 0')
    return 0
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(value))) {
    throw new Error('金额须为非负数，最多保留 8 位小数')
  }
  const units = moneyUnits(value)
  if (units < 0) throw new Error('金额不能为负数')
  return units
}

export function reconcileBalance(ledger, input, now = Date.now()) {
  const day = String(input.day || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('请选择有效的记账日期')
  const book = currentBook(ledger)
  const row = book && book.days && book.days[day]
  if (!row) throw new Error('这一天没有余额观测记录，无法校正')
  if (input.revision !== revisionOf(ledger, row)) {
    const err = new Error('余额或校正记录已更新，请重新打开校正窗口后核对金额')
    err.status = 409
    throw err
  }
  if (input.action !== 'reset' && input.confirmed !== true) throw new Error('请先确认已核对本统计区间的全部余额调整')
  let correction = null
  if (input.action !== 'reset') {
    const creditsUnits = adjustmentUnits(input.credits, true)
    const otherDebitsUnits = adjustmentUnits(input.otherDebits)
    const amountUnits = row.openingUnits + creditsUnits - otherDebitsUnits - row.lastUnits
    if (!Number.isSafeInteger(amountUnits) || amountUnits < 0) {
      throw new Error('校正后消费为负或超出范围，请核对统计起点与累计到账金额')
    }
    correction = {
      at: Number(now), creditsUnits, otherDebitsUnits, amountUnits,
      debitUnits: row.debitUnits, creditUnits: row.creditUnits,
    }
  }
  row.correctionLog ||= []
  row.correctionLog.push({ at: Number(now), previous: row.correction, next: correction })
  if (row.correctionLog.length > 50) row.correctionLog.splice(0, row.correctionLog.length - 50)
  row.correction = correction
  row.revision = (row.revision || 0) + 1
  const summary = balanceSummary(ledger, day)
  ledger.history ||= {}
  ledger.history[day] = summary.amount
  if (ledger.date === day) ledger.todayUsage = summary.amount
  return summary
}

export function eventEstimate(ledger, day) {
  return sumMoney((Array.isArray(ledger.events) ? ledger.events : [])
    .filter(e => e.day === day).map(e => Number(e.cost) || 0))
}

export function daySummary(ledger, day) {
  const observed = balanceSummary(ledger, day)
  const estimate = eventEstimate(ledger, day)
  if (observed) return { ...observed, eventEstimate: estimate, eventCurrency: 'CNY' }
  // An explicit historical total (even zero) wins over a conflicting estimate.
  const history = ledger.accounting ? ledger.accounting.legacyHistory : ledger.history
  const h = history && history[day]
  const hasHistory = typeof h === 'number' && Number.isFinite(h)
  return {
    day, amount: hasHistory ? preciseMoney(h) : estimate, currency: 'CNY',
    source: hasHistory ? 'legacy' : 'events', label: hasHistory ? '旧版记录 · 未校正' : '本地估算',
    eventEstimate: estimate, eventCurrency: 'CNY', partialDay: true,
  }
}
