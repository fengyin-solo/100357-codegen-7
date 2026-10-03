import { listRows, readExtra, saveRows, writeExtra } from '@/data/local-store'
import type {
  BatchActionResult,
  BatchConclusion,
  BatchDifferenceRow,
  BatchSectionGroup,
  CompilationTodo,
  CrossCheckBatch,
  EntryRow,
  SubmitBatchInput,
} from '@/data/types'

// 断面批量校核批次：归组、整体提交、版本重跑与差异表都在这里，页面不做业务判断。

const MODULE_KEY = 'crosssection'
const PENDING_STATUS = '待校核'
const BATCHES_KEY = 'crosscheck-batches'
const TODOS_KEY = 'compilation-todos'
const MIGRATION_KEY = 'crosscheck-legacy-backfill-v1'

// 同断面多次测量的河底高程最大允许较差（米）：超过即判该断面超差，批次整体失败回退。
const ELEVATION_TOLERANCE = 0.5
// 一个断面进入批次至少需要的测次（单次测量无法做差异校核）。
const MIN_MEASURES_PER_SECTION = 2

const CONCLUSION_STATUS: Record<BatchConclusion, CrossCheckBatch['status']> = {
  通过: '已通过',
  需重测: '需重测',
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

function nowText(): string {
  // ISO 时间截掉毫秒与时区尾巴，落库可读性更好。
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

function uniq(values: string[]): string[] {
  return [...new Set(values)]
}

// ---- 归组：把多次测量按「断面名称」归到一起 ----

export function buildGroups(records: EntryRow[]): BatchSectionGroup[] {
  const bySection = new Map<string, EntryRow[]>()
  for (const row of records) {
    const section = String(row['断面名称'] ?? '').trim()
    if (!section) {
      continue
    }
    const list = bySection.get(section) ?? []
    list.push(row)
    bySection.set(section, list)
  }
  const groups: BatchSectionGroup[] = []
  for (const [section, list] of bySection) {
    const sorted = [...list].sort((a, b) =>
      String(a['测量日期'] ?? '').localeCompare(String(b['测量日期'] ?? '')),
    )
    const elevations = sorted.map((row) => parseNumber(row['河底高程']))
    const validElevations = elevations.filter((v): v is number => v !== null)
    let spread: number | null = null
    if (validElevations.length >= 2) {
      spread = Math.max(...validElevations) - Math.min(...validElevations)
    }
    groups.push({
      section,
      stationCode: String(sorted[0]['站点编号'] ?? ''),
      measureDates: sorted.map((row) => String(row['测量日期'] ?? '')),
      recordIds: sorted.map((row) => Number(row.id)),
      recordCodes: sorted.map((row) => String(row['记录编号'] ?? row.id)),
      elevations,
      startDistances: sorted.map((row) => parseNumber(row['起点距'])),
      elevationSpread: spread,
    })
  }
  // 断面名称排序，批次内顺序稳定。
  return groups.sort((a, b) => a.section.localeCompare(b.section, 'zh-Hans-CN'))
}

/** 全部待校核记录按断面归组（建批次页直接用；只有待校核记录能进入批次）。 */
export function pendingGroups(): BatchSectionGroup[] {
  const pending = listRows(MODULE_KEY).filter((row) => String(row.status) === PENDING_STATUS)
  return buildGroups(pending)
}

// ---- 差异校核：逐断面校验，返回第一个断面的问题描述 ----

function validateGroup(group: BatchSectionGroup): string | null {
  if (group.recordIds.length < MIN_MEASURES_PER_SECTION) {
    return `断面「${group.section}」只有 ${group.recordIds.length} 个测次，至少需 ${MIN_MEASURES_PER_SECTION} 个测次才能做差异校核`
  }
  if (group.elevations.some((v) => v === null)) {
    return `断面「${group.section}」存在无法解析的河底高程，无法计算测量差异`
  }
  if (group.startDistances.some((v) => v === null)) {
    return `断面「${group.section}」存在无法解析的起点距，无法定位测点差异`
  }
  if (group.elevationSpread !== null && group.elevationSpread > ELEVATION_TOLERANCE) {
    return `断面「${group.section}」多次测量河底高程较差 ${group.elevationSpread.toFixed(2)}m，超过限差 ±${ELEVATION_TOLERANCE}m`
  }
  return null
}

// ---- 差异表 ----

function toDifferenceRow(group: BatchSectionGroup): BatchDifferenceRow {
  const overTolerance =
    group.elevationSpread !== null && group.elevationSpread > ELEVATION_TOLERANCE
  return {
    section: group.section,
    stationCode: group.stationCode,
    measureCount: group.recordIds.length,
    measureDates: group.measureDates.join(' / '),
    elevations: group.elevations
      .map((v) => (v === null ? '不可解析' : v.toFixed(2)))
      .join(' / '),
    startDistances: group.startDistances
      .map((v) => (v === null ? '不可解析' : v.toFixed(2)))
      .join(' / '),
    elevationSpread: group.elevationSpread === null ? '—' : group.elevationSpread.toFixed(2),
    result: overTolerance ? '超差' : '符合限差',
  }
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildDifferenceCsv(batch: CrossCheckBatch): string {
  const header = ['批次号', '版本', '断面名称', '站点编号', '测次数', '测量日期', '河底高程(m)', '起点距(m)', '高程较差(m)', '限差判定', '校核结论', '校核人']
  const lines = [header.join(',')]
  for (const row of batch.differenceRows) {
    lines.push(
      [
        displayBatchNo(batch),
        `V${batch.version}`,
        row.section,
        row.stationCode,
        row.measureCount,
        row.measureDates,
        row.elevations,
        row.startDistances,
        row.elevationSpread,
        row.result,
        batch.conclusion,
        batch.checker,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `﻿${lines.join('\n')}`
}

export function downloadDifference(batch: CrossCheckBatch): void {
  const content = buildDifferenceCsv(batch)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `断面校核差异表-${displayBatchNo(batch)}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// ---- 批次号 ----

/** 对外展示的批次号：首版即批次号，重跑版追加 Vn。 */
export function displayBatchNo(batch: CrossCheckBatch): string {
  return batch.version > 1 ? `${batch.batchNo}-V${batch.version}` : batch.batchNo
}

function listBatchesRaw(): CrossCheckBatch[] {
  return readExtra<CrossCheckBatch[]>(BATCHES_KEY, [])
}

function nextBatchNo(batches: CrossCheckBatch[]): string {
  const prefix = `XH-${todayText().slice(0, 7).replace('-', '')}`
  const seq = batches
    .filter((b) => b.batchNo.startsWith(`${prefix}-`))
    .reduce((max, b) => {
      const n = Number(b.batchNo.slice(prefix.length + 1))
      return Number.isFinite(n) ? Math.max(max, n) : max
    }, 0)
  return `${prefix}-${String(seq + 1).padStart(3, '0')}`
}

export function listBatches(): CrossCheckBatch[] {
  // 新提交在前，同批次号按版本倒序，方便看到最新版本。
  return listBatchesRaw().sort((a, b) => {
    const byTime = b.createdAt.localeCompare(a.createdAt)
    if (byTime !== 0) {
      return byTime
    }
    return b.version - a.version
  })
}

export function getBatch(batchNo: string, version: number): CrossCheckBatch | undefined {
  return listBatchesRaw().find((b) => b.batchNo === batchNo && b.version === version)
}

// ---- 水位整编待办（核对项） ----

export function listCompilationTodos(): CompilationTodo[] {
  return readExtra<CompilationTodo[]>(TODOS_KEY, []).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )
}

function todoId(batchNo: string, section: string): string {
  return `${batchNo}::${section}`
}

/**
 * 批次通过后按断面立项核对项。
 * 幂等：以「批次号-版本 + 断面」为键，重复提交/重复通过同一批次不会重复立项。
 */
function createTodosForBatch(batch: CrossCheckBatch): CompilationTodo[] {
  const existing = readExtra<CompilationTodo[]>(TODOS_KEY, [])
  const known = new Set(existing.map((t) => t.id))
  const created: CompilationTodo[] = []
  for (const group of batch.groups) {
    const id = `${todoId(displayBatchNo(batch), group.section)}`
    if (known.has(id)) {
      continue
    }
    known.add(id)
    created.push({
      id,
      sourceBatchNo: displayBatchNo(batch),
      stationCode: group.stationCode,
      section: group.section,
      measureCount: group.recordIds.length,
      measureDates: group.measureDates.join(' / '),
      title: `核对断面「${group.section}」校核成果（${group.recordIds.length} 测次）`,
      status: '待核对',
      createdAt: batch.submittedAt,
      checkedAt: '',
    })
  }
  return [...existing, ...created]
}

export function checkCompilationTodo(id: string): void {
  const todos = readExtra<CompilationTodo[]>(TODOS_KEY, [])
  const next = todos.map((todo) =>
    todo.id === id ? { ...todo, status: '已核对' as const, checkedAt: nowText() } : todo,
  )
  writeExtra(TODOS_KEY, next)
}

// ---- 整体提交：任一断面失败全部回退 ----

export function submitBatch(input: SubmitBatchInput): BatchActionResult {
  if (input.recordIds.length === 0) {
    return { ok: false, message: '请至少勾选一条待校核记录再组建批次' }
  }
  if (!input.checker.trim()) {
    return { ok: false, message: '请填写校核人' }
  }
  if (input.conclusion !== '通过' && input.conclusion !== '需重测') {
    return { ok: false, message: '请给出整体校核结论（通过 / 需重测）' }
  }

  // 快照：提交前把两份存储都留存，任何一步失败都还原，保证批次整体落库。
  const rowsSnapshot = listRows(MODULE_KEY).map((row) => ({ ...row }))
  const batchesSnapshot = listBatchesRaw()
  const todosSnapshot = readExtra<CompilationTodo[]>(TODOS_KEY, [])

  try {
    const idSet = new Set(input.recordIds)
    const selected = rowsSnapshot.filter((row) => idSet.has(Number(row.id)))
    if (selected.length !== input.recordIds.length) {
      return { ok: false, message: '勾选记录中有不存在的数据，请刷新后重试' }
    }
    // 只有「待校核」记录能进入批次：已校核 / 需重测 / 已测量一律拦截。
    const illegal = selected.filter((row) => String(row.status) !== PENDING_STATUS)
    if (illegal.length > 0) {
      const codes = illegal.map((row) => String(row['记录编号'] ?? row.id)).join('、')
      return { ok: false, message: `只有待校核记录能进入批次，以下记录不符合：${codes}` }
    }

    const groups = buildGroups(selected)
    const failedSections: string[] = []
    for (const group of groups) {
      if (validateGroup(group)) {
        failedSections.push(group.section)
      }
    }
    if (failedSections.length > 0) {
      return {
        ok: false,
        failedSections,
        message: groups
          .map(validateGroup)
          .filter((m): m is string => m !== null)
          .join('；'),
      }
    }

    const batches = listBatchesRaw()
    const batchNo = nextBatchNo(batches)
    const targetStatus = CONCLUSION_STATUS[input.conclusion]
    const recordTarget = input.conclusion === '通过' ? '已校核' : '需重测'
    const timestamp = nowText()

    const batch: CrossCheckBatch = {
      batchNo,
      version: 1,
      status: targetStatus,
      sectionNames: uniq(groups.map((g) => g.section)),
      recordIds: groups.flatMap((g) => g.recordIds),
      groups,
      checker: input.checker.trim(),
      conclusion: input.conclusion,
      remark: input.remark.trim(),
      createdAt: timestamp,
      submittedAt: timestamp,
      differenceRows: groups.map(toDifferenceRow),
      rerunOf: '',
    }

    // 记录整体更新：统一带上班次号并流转状态。
    const nextRows = rowsSnapshot.map((row) =>
      idSet.has(Number(row.id))
        ? {
            ...row,
            status: recordTarget,
            pending: recordTarget !== '已校核',
            abnormal: recordTarget === '需重测',
            批次号: displayBatchNo(batch),
          }
        : row,
    )

    const nextBatches = [...batches, batch]

    // 通过后才给其他页面（水位整编待办）增加核对项；需重测不立项。
    const nextTodos =
      input.conclusion === '通过' ? createTodosForBatch(batch) : todosSnapshot

    // 原子提交：三份写入连续完成；任一写入抛错都会被捕获并整体回退。
    saveRows(MODULE_KEY, nextRows)
    writeExtra(BATCHES_KEY, nextBatches)
    writeExtra(TODOS_KEY, nextTodos)

    return {
      ok: true,
      batch,
      message:
        input.conclusion === '通过'
          ? `批次 ${displayBatchNo(batch)} 整体校核通过，${groups.length} 个断面已入库，并生成 ${batch.sectionNames.length} 项水位整编核对待办`
          : `批次 ${displayBatchNo(batch)} 已给出「需重测」，${groups.length} 个断面记录整体转为需重测`,
    }
  } catch (error) {
    // 落库异常：恢复快照，本次提交什么都不留。
    saveRows(MODULE_KEY, rowsSnapshot)
    writeExtra(BATCHES_KEY, batchesSnapshot)
    writeExtra(TODOS_KEY, todosSnapshot)
    return {
      ok: false,
      message: error instanceof Error ? `批次落库失败已整体回退：${error.message}` : '批次落库失败已整体回退',
    }
  }
}

// ---- 批次重跑：生成新版本（不覆盖历史结论） ----

export function rerunBatch(batchNo: string, version: number): BatchActionResult {
  const source = getBatch(batchNo, version)
  if (!source) {
    return { ok: false, message: '没有找到要重跑的批次版本' }
  }
  if (source.status === '已被新版本替代') {
    return { ok: false, message: '该版本已被更新版本替代，请重跑最新版本' }
  }
  if (source.status === '待校核') {
    return { ok: false, message: '批次尚未给出结论，无需重跑' }
  }

  // 收集原批次断面下当前仍处于「待校核」的记录（重测后的新测次）。
  const sections = new Set(source.sectionNames)
  const reusable = listRows(MODULE_KEY).filter(
    (row) =>
      sections.has(String(row['断面名称'] ?? '').trim()) &&
      String(row.status) === PENDING_STATUS,
  )
  if (reusable.length === 0) {
    return { ok: false, message: '原批次断面下暂无待校核记录，无法组建新版本（请先完成重测并提交校核）' }
  }

  const rowsSnapshot = listRows(MODULE_KEY).map((row) => ({ ...row }))
  const batchesSnapshot = listBatchesRaw()
  const todosSnapshot = readExtra<CompilationTodo[]>(TODOS_KEY, [])

  try {
    const groups = buildGroups(reusable)
    const newVersion =
      batchesSnapshot
        .filter((b) => b.batchNo === batchNo)
        .reduce((max, b) => Math.max(max, b.version), source.version) + 1
    const timestamp = nowText()

    const draft: CrossCheckBatch = {
      batchNo,
      version: newVersion,
      status: '待校核',
      sectionNames: uniq(groups.map((g) => g.section)),
      recordIds: groups.flatMap((g) => g.recordIds),
      groups,
      checker: source.checker,
      conclusion: '',
      remark: '',
      createdAt: timestamp,
      submittedAt: '',
      differenceRows: groups.map(toDifferenceRow),
      rerunOf: displayBatchNo(source),
    }

    const superseded = batchesSnapshot.map((b) =>
      b.batchNo === batchNo && b.status !== '已被新版本替代'
        ? { ...b, status: '已被新版本替代' as const }
        : b,
    )
    writeExtra(BATCHES_KEY, [...superseded, draft])
    return {
      ok: true,
      batch: draft,
      message: `已基于原批次断面组建新版本 ${displayBatchNo(draft)}（含 ${groups.length} 个断面、${reusable.length} 条待校核记录），历史版本已保留，请在批次列表中提交结论`,
    }
  } catch (error) {
    saveRows(MODULE_KEY, rowsSnapshot)
    writeExtra(BATCHES_KEY, batchesSnapshot)
    writeExtra(TODOS_KEY, todosSnapshot)
    return {
      ok: false,
      message: error instanceof Error ? `组建新版本失败已回退：${error.message}` : '组建新版本失败已回退',
    }
  }
}

/** 提交重跑产生的新版本草稿：同样逐断面校验、整体落库。 */
export function submitBatchDraft(draftId: { batchNo: string; version: number }, input: Omit<SubmitBatchInput, 'recordIds'>): BatchActionResult {
  const draft = getBatch(draftId.batchNo, draftId.version)
  if (!draft || draft.status !== '待校核') {
    return { ok: false, message: '该批次版本不是待校核草稿，不能提交' }
  }

  const rowsSnapshot = listRows(MODULE_KEY).map((row) => ({ ...row }))
  const batchesSnapshot = listBatchesRaw()
  const todosSnapshot = readExtra<CompilationTodo[]>(TODOS_KEY, [])

  try {
    const idSet = new Set(draft.recordIds)
    const current = rowsSnapshot.filter((row) => idSet.has(Number(row.id)))
    if (current.length !== draft.recordIds.length) {
      return { ok: false, message: '草稿包含的记录已缺失，请放弃该版本后重新组建' }
    }
    const illegal = current.filter((row) => String(row.status) !== PENDING_STATUS)
    if (illegal.length > 0) {
      const codes = illegal.map((row) => String(row['记录编号'] ?? row.id)).join('、')
      return { ok: false, message: `草稿中存在已非待校核的记录：${codes}，请重新组建版本` }
    }

    const groups = buildGroups(current)
    const failedSections: string[] = []
    for (const group of groups) {
      if (validateGroup(group)) {
        failedSections.push(group.section)
      }
    }
    if (failedSections.length > 0) {
      return {
        ok: false,
        failedSections,
        message: groups
          .map(validateGroup)
          .filter((m): m is string => m !== null)
          .join('；'),
      }
    }

    const targetStatus = CONCLUSION_STATUS[input.conclusion]
    const recordTarget = input.conclusion === '通过' ? '已校核' : '需重测'
    const timestamp = nowText()

    const finalized: CrossCheckBatch = {
      ...draft,
      status: targetStatus,
      groups,
      sectionNames: uniq(groups.map((g) => g.section)),
      recordIds: groups.flatMap((g) => g.recordIds),
      checker: input.checker.trim() || draft.checker,
      conclusion: input.conclusion,
      remark: input.remark.trim(),
      submittedAt: timestamp,
      differenceRows: groups.map(toDifferenceRow),
    }

    const nextRows = rowsSnapshot.map((row) =>
      idSet.has(Number(row.id))
        ? {
            ...row,
            status: recordTarget,
            pending: recordTarget !== '已校核',
            abnormal: recordTarget === '需重测',
            批次号: displayBatchNo(finalized),
          }
        : row,
    )
    const nextBatches = batchesSnapshot.map((b) =>
      b.batchNo === draft.batchNo && b.version === draft.version ? finalized : b,
    )
    const nextTodos =
      input.conclusion === '通过' ? createTodosForBatch(finalized) : todosSnapshot

    saveRows(MODULE_KEY, nextRows)
    writeExtra(BATCHES_KEY, nextBatches)
    writeExtra(TODOS_KEY, nextTodos)

    return {
      ok: true,
      batch: finalized,
      message:
        input.conclusion === '通过'
          ? `新版本 ${displayBatchNo(finalized)} 整体校核通过，已更新水位整编核对待办`
          : `新版本 ${displayBatchNo(finalized)} 已给出「需重测」`,
    }
  } catch (error) {
    saveRows(MODULE_KEY, rowsSnapshot)
    writeExtra(BATCHES_KEY, batchesSnapshot)
    writeExtra(TODOS_KEY, todosSnapshot)
    return {
      ok: false,
      message: error instanceof Error ? `新版本落库失败已整体回退：${error.message}` : '新版本落库失败已整体回退',
    }
  }
}

// ---- 存量记录回填：按测量日期（断面 + 年月）补历史批次号，只补号不改状态 ----

export function backfillLegacyBatches(): { updated: number; groups: number } {
  // 迁移只执行一次：已有标记就跳过；函数本身也幂等（只给没有批次号的记录补号）。
  if (readExtra<boolean>(MIGRATION_KEY, false)) {
    return { updated: 0, groups: 0 }
  }
  const rows = listRows(MODULE_KEY)
  const missing = rows.filter((row) => String(row['批次号'] ?? '').trim() === '')
  if (missing.length === 0) {
    writeExtra(MIGRATION_KEY, true)
    return { updated: 0, groups: 0 }
  }

  // 按「断面 + 测量年月」归组，同一月内同断面的多次测量回填同一个历史批次号。
  const groupKey = new Map<string, string[]>()
  for (const row of missing) {
    const section = String(row['断面名称'] ?? '未知断面').trim() || '未知断面'
    const month = String(row['测量日期'] ?? '').slice(0, 7).replace('-', '') || 'NA'
    const key = `${month}::${section}`
    const ids = groupKey.get(key) ?? []
    ids.push(String(row.id))
    groupKey.set(key, ids)
  }

  const seqByMonth = new Map<string, number>()
  const batchById = new Map<string, string>()
  for (const [key, ids] of [...groupKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const month = key.split('::')[0]
    const seq = (seqByMonth.get(month) ?? 0) + 1
    seqByMonth.set(month, seq)
    const batchNo = `XHBACK-${month}-${String(seq).padStart(2, '0')}`
    for (const id of ids) {
      batchById.set(id, batchNo)
    }
  }

  const nextRows = rows.map((row) => {
    const backNo = batchById.get(String(row.id))
    return backNo ? { ...row, 批次号: backNo } : row
  })
  saveRows(MODULE_KEY, nextRows)
  writeExtra(MIGRATION_KEY, true)
  return { updated: batchById.size, groups: groupKey.size }
}
