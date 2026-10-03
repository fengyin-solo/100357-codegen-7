import {
  CROSSCHECK_STORAGE_KEY,
  allRows,
  commitAtomic,
  readCollection,
  resetRows,
  writeCollection,
} from '@/data/local-store'
import type {
  CrossCheckState,
  CrossCheckTodo,
  CrossSectionBatch,
  EntryRow,
  SectionDiff,
} from '@/data/types'

const MODULE_KEY = 'crosssection'
const PENDING_STATUS = '待校核'
const PASSED_STATUS = '已校核'
const RETAKE_STATUS = '需重测'

const EMPTY_STATE: CrossCheckState = { batches: [], todos: [], backfilled: false }

export function sectionKeyOf(row: EntryRow): string {
  return `${String(row['站点编号'] ?? '')}|${String(row['断面名称'] ?? '')}`
}

function splitKey(key: string): { stationNo: string; section: string } {
  const [stationNo = '', section = ''] = key.split('|')
  return { stationNo, section }
}

function loadState(): CrossCheckState {
  return readCollection<CrossCheckState>(CROSSCHECK_STORAGE_KEY, EMPTY_STATE)
}

function saveState(state: CrossCheckState): void {
  writeCollection(CROSSCHECK_STORAGE_KEY, state)
}

function nowText(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

function nextId(items: { id: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value ?? '').trim()
  if (text === '') return null
  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 待校核记录才能进入批次；已经被「未作废且待校核」批次占用的记录不能重复立项。
export function selectableRows(rows: EntryRow[], state: CrossCheckState): EntryRow[] {
  const locked = new Set(
    state.batches
      .filter((batch) => !batch.superseded && batch.status === PENDING_STATUS)
      .flatMap((batch) => batch.recordIds),
  )
  return rows.filter((row) => String(row.status) === PENDING_STATUS && !locked.has(Number(row.id)))
}

// 页面直接取「当前能进入新批次」的待校核记录。
export function listSelectableRows(): EntryRow[] {
  return selectableRows(allRows()[MODULE_KEY] ?? [], loadState())
}

function upsertTodo(
  state: CrossCheckState,
  batch: CrossSectionBatch,
  key: string,
): void {
  const { stationNo, section } = splitKey(key)
  const existing = state.todos.find((todo) => todo.refKey === batch.batchNo && todo.section === section)
  if (existing) {
    // 同一批次业务号：重跑通过只更新同一条待办，不重复立项。
    existing.version = batch.version
    existing.status = '待核对'
    existing.source = batch.origin
    existing.passedAt = batch.submittedAt
    existing.checker = batch.checker
    existing.remark = `批次 ${batch.batchNo} v${batch.version} 校核通过，待水位整编核对`
    return
  }
  const todo: CrossCheckTodo = {
    id: nextId(state.todos),
    refKey: batch.batchNo,
    batchNo: batch.batchNo,
    version: batch.version,
    stationNo,
    section,
    title: `核对断面校核成果：${stationNo} ${section}`,
    status: '待核对',
    source: batch.origin,
    createdAt: nowText(),
    passedAt: batch.submittedAt,
    checker: batch.checker,
    resolvedAt: '',
    remark: `批次 ${batch.batchNo} v${batch.version} 校核通过，待水位整编核对`,
  }
  state.todos.push(todo)
}

// 存量记录按测量日期回填批次号：组内全已校核则批次直接通过并生成核对项，
// 混合态则保留为待校核的历史批次，可继续整批给结论。已测量/需重测不回填。
export function backfillLegacyBatches(operator = '系统回填'): { batches: number; records: number } {
  const state = loadState()
  if (state.backfilled) return { batches: 0, records: 0 }

  let result = { batches: 0, records: 0 }
  // 分组、写批次号、生成核对项全部在事务草稿里完成，失败可整体回退。
  commitAtomic(CROSSCHECK_STORAGE_KEY, (draft) => {
    const draftState = (draft.collection as CrossCheckState | null) ?? {
      batches: [],
      todos: [],
      backfilled: false,
    }
    if (draftState.backfilled) return
    const rows = (draft.entries[MODULE_KEY] ?? []).filter(
      (row) =>
        String(row['校核批次号'] ?? '') === '' &&
        (row.status === PENDING_STATUS || row.status === PASSED_STATUS),
    )
    if (rows.length === 0) {
      draftState.backfilled = true
      draft.collection = draftState
      return
    }

    const byDate = new Map<string, EntryRow[]>()
    for (const row of rows) {
      const date = String(row['测量日期'] ?? '未知日期')
      const group = byDate.get(date) ?? []
      group.push(row)
      byDate.set(date, group)
    }

    let seq = 0
    let touched = 0
    for (const [date, group] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      seq += 1
      const batchNo = `HD-PH-HIST-${date.replace(/-/g, '')}-${String(seq).padStart(2, '0')}`
      const allPassed = group.every((row) => row.status === PASSED_STATUS)
      const sections = [...new Set(group.map(sectionKeyOf))].sort()
      const batch: CrossSectionBatch = {
        id: nextId(draftState.batches),
        batchNo,
        version: 1,
        origin: 'legacy',
        status: allPassed ? '已通过' : PENDING_STATUS,
        superseded: false,
        recordIds: group.map((row) => Number(row.id)),
        sections,
        createdAt: nowText(),
        createdBy: operator,
        submittedAt: allPassed ? nowText() : '',
        checker: allPassed ? operator : '',
        conclusion: allPassed ? '通过' : '',
        remark: '存量记录按测量日期回填',
      }
      draftState.batches.push(batch)
      for (const row of group) {
        row['校核批次号'] = batchNo
        touched += 1
      }
      if (allPassed) {
        for (const key of sections) upsertTodo(draftState, batch, key)
      }
    }
    draftState.backfilled = true
    draft.collection = draftState
    result = { batches: seq, records: touched }
  })
  return result
}

export type BatchView = CrossSectionBatch & { recordCount: number; sectionCount: number }

export function listBatches(): BatchView[] {
  const state = loadState()
  return state.batches
    .map((batch) => ({
      ...batch,
      recordCount: batch.recordIds.length,
      sectionCount: batch.sections.length,
    }))
    .sort((a, b) =>
      a.batchNo === b.batchNo ? b.version - a.version : b.createdAt.localeCompare(a.createdAt),
    )
}

function findBatch(state: CrossCheckState, id: number): CrossSectionBatch | undefined {
  return state.batches.find((batch) => batch.id === id)
}

export function batchDetail(id: number): { batch: BatchView; rows: EntryRow[] } | null {
  const state = loadState()
  const batch = findBatch(state, id)
  if (!batch) return null
  const ids = new Set(batch.recordIds)
  const rows = (allRows()[MODULE_KEY] ?? []).filter((row) => ids.has(Number(row.id)))
  return {
    batch: { ...batch, recordCount: rows.length, sectionCount: batch.sections.length },
    rows,
  }
}

export type CreateBatchResult = { ok: boolean; message: string; batchId?: number }

// 一次立项：入参记录必须全部处于待校核且未被占用；同一记录集合重复提交直接拦截。
export function createBatch(recordIds: number[], operator: string): CreateBatchResult {
  const ids = [...new Set(recordIds.map(Number))]
  if (ids.length === 0) {
    return { ok: false, message: '请先勾选待校核记录，批次内至少一条断面记录' }
  }
  const state = loadState()
  const rows = allRows()[MODULE_KEY] ?? []
  const picked = ids.map((id) => rows.find((row) => Number(row.id) === id))
  if (picked.some((row) => !row)) {
    return { ok: false, message: '勾选的记录有缺失，请刷新后重新选择' }
  }
  const locked = new Set(
    state.batches
      .filter((batch) => !batch.superseded && batch.status === PENDING_STATUS)
      .flatMap((batch) => batch.recordIds),
  )
  for (const row of picked as EntryRow[]) {
    if (String(row.status) !== PENDING_STATUS) {
      return { ok: false, message: `记录 ${row['记录编号']} 不是待校核状态，不能进入批次` }
    }
    if (locked.has(Number(row.id))) {
      return { ok: false, message: `记录 ${row['记录编号']} 已在待校核批次中，不能重复立项` }
    }
  }

  const signature = ids.sort((a, b) => a - b).join(',')
  const duplicated = state.batches.find(
    (batch) => !batch.superseded && [...batch.recordIds].sort((a, b) => a - b).join(',') === signature,
  )
  if (duplicated) {
    return {
      ok: false,
      message: `相同断面记录已立项为批次 ${duplicated.batchNo}，不得重复提交`,
    }
  }

  const month = nowText().slice(0, 7).replace('-', '')
  const monthCount = state.batches.filter((batch) => batch.origin === 'normal').length + 1
  const batchNo = `HD-PH-${month}-${String(monthCount).padStart(3, '0')}`
  const sections = [...new Set((picked as EntryRow[]).map(sectionKeyOf))].sort()

  let batchId = 0
  commitAtomic(CROSSCHECK_STORAGE_KEY, (draft) => {
    const draftState = draft.collection as CrossCheckState
    const batch: CrossSectionBatch = {
      id: nextId(draftState.batches),
      batchNo,
      version: 1,
      origin: 'normal',
      status: PENDING_STATUS,
      superseded: false,
      recordIds: ids,
      sections,
      createdAt: nowText(),
      createdBy: operator,
      submittedAt: '',
      checker: '',
      conclusion: '',
      remark: '',
    }
    draftState.batches.push(batch)
    const draftRows = draft.entries[MODULE_KEY]
    for (const row of draftRows) {
      if (ids.includes(Number(row.id))) row['校核批次号'] = batchNo
    }
    batchId = batch.id
  })
  return { ok: true, message: `批次 ${batchNo} 已立项，共 ${ids.length} 条记录、${sections.length} 个断面`, batchId }
}

export type SubmitResult = { ok: boolean; message: string; failedSection?: string }

// 提交校核结论：逐断面校验，任一断面失败就整体回退；通过后按业务批次号幂等生成核对项。
export function submitReview(
  batchId: number,
  conclusion: '通过' | '未通过',
  checker: string,
  remark: string,
): SubmitResult {
  if (!checker.trim()) return { ok: false, message: '请填写校核人' }
  const state = loadState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: '没有找到该校核批次' }
  if (batch.superseded) return { ok: false, message: `批次 ${batch.batchNo} 已被新版本替代` }
  if (batch.status !== PENDING_STATUS) {
    return { ok: false, message: `批次 ${batch.batchNo} 已提交过结论，不能重复提交` }
  }

  const rows = allRows()[MODULE_KEY] ?? []
  const ids = new Set(batch.recordIds)
  const batchRows = rows.filter((row) => ids.has(Number(row.id)))
  if (batchRows.length !== batch.recordIds.length) {
    return { ok: false, message: '批次内记录数量与立项时不一致，已拒绝提交' }
  }

  // 按断面归组校验：起点距/河底高程必须可解析为数值，否则该断面失败，整批回退。
  const groups = new Map<string, EntryRow[]>()
  for (const row of batchRows) {
    const key = sectionKeyOf(row)
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  for (const [key, group] of groups) {
    const { stationNo, section } = splitKey(key)
    if (group.length === 0) {
      return { ok: false, message: `断面 ${stationNo} ${section} 没有任何记录`, failedSection: key }
    }
    for (const row of group) {
      if (toNumber(row['起点距']) === null || toNumber(row['河底高程']) === null) {
        return {
          ok: false,
          message: `断面 ${stationNo} ${section} 的记录 ${row['记录编号']} 起点距或河底高程无法核算，该断面校核失败，整批已回退`,
          failedSection: key,
        }
      }
    }
  }

  const passed = conclusion === '通过'
  const targetStatus = passed ? PASSED_STATUS : RETAKE_STATUS
  const timestamp = nowText()

  try {
    commitAtomic(CROSSCHECK_STORAGE_KEY, (draft) => {
      const draftState = draft.collection as CrossCheckState
      const target = draftState.batches.find((item) => item.id === batchId)
      if (!target || target.superseded || target.status !== PENDING_STATUS) {
        throw new Error('批次状态已变化，提交中止')
      }
      const draftRows = draft.entries[MODULE_KEY]
      for (const row of draftRows) {
        if (!ids.has(Number(row.id))) continue
        if (String(row.status) !== PENDING_STATUS) continue
        row.status = targetStatus
        row.pending = false
        row.abnormal = passed ? false : true
      }
      target.status = passed ? '已通过' : '未通过'
      target.submittedAt = timestamp
      target.checker = checker.trim()
      target.conclusion = conclusion
      target.remark = remark.trim()
      if (passed) {
        for (const key of target.sections) upsertTodo(draftState, target, key)
      }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '提交失败，整批已回退' }
  }

  return {
    ok: true,
    message: passed
      ? `批次 ${batch.batchNo} 已整批通过，已向水位整编待办推送 ${batch.sections.length} 个核对项`
      : `批次 ${batch.batchNo} 校核未通过，批次内待校核记录已安排重测`,
  }
}

export type RerunResult = { ok: boolean; message: string; batchId?: number }

// 批次重跑：业务批次号不变，版本号 +1，旧版本置「已作废」保留留痕；待校核记录进入新版本。
export function rerunBatch(batchId: number, operator: string): RerunResult {
  const state = loadState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: '没有找到该校核批次' }
  if (batch.superseded) return { ok: false, message: `批次 ${batch.batchNo} 已是作废版本` }
  if (batch.status !== '未通过') {
    return { ok: false, message: '只有校核未通过的批次可以重跑' }
  }

  const rows = allRows()[MODULE_KEY] ?? []
  const pool = selectableRows(rows, state)
  const sectionSet = new Set(batch.sections)
  const picked = pool.filter((row) => sectionSet.has(sectionKeyOf(row)))
  if (picked.length === 0) {
    return { ok: false, message: '原断面下暂无待校核重测记录，无法重跑，请先完成重测并提交校核' }
  }

  let newId = 0
  const version = batch.version + 1
  const recordIds = picked.map((row) => Number(row.id))
  const sections = [...new Set(picked.map(sectionKeyOf))].sort()
  const timestamp = nowText()
  const batchNo = batch.batchNo

  try {
    commitAtomic(CROSSCHECK_STORAGE_KEY, (draft) => {
      const draftState = draft.collection as CrossCheckState
      const old = draftState.batches.find((item) => item.id === batchId)
      if (!old || old.superseded || old.status !== '未通过') {
        throw new Error('批次状态已变化，重跑中止')
      }
      old.superseded = true
      old.status = '已作废'
      const created: CrossSectionBatch = {
        id: nextId(draftState.batches),
        batchNo,
        version,
        origin: old.origin,
        status: PENDING_STATUS,
        superseded: false,
        recordIds,
        sections,
        createdAt: timestamp,
        createdBy: operator,
        submittedAt: '',
        checker: '',
        conclusion: '',
        remark: `由 ${batchNo} v${old.version} 重跑生成`,
      }
      draftState.batches.push(created)
      for (const row of draft.entries[MODULE_KEY]) {
        if (recordIds.includes(Number(row.id))) row['校核批次号'] = batchNo
      }
      newId = created.id
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '重跑失败，已回退' }
  }
  return { ok: true, message: `批次 ${batchNo} 已生成 v${version}，旧版本作废留痕`, batchId: newId }
}

// 按断面归组计算差异：多次测量的首末日期、起点距与河底高程区间、高程差值。
export function buildSectionDiffs(batchRows: EntryRow[]): SectionDiff[] {
  const groups = new Map<string, EntryRow[]>()
  for (const row of batchRows) {
    const key = sectionKeyOf(row)
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const diffs: SectionDiff[] = []
  for (const [key, group] of groups) {
    const { stationNo, section } = splitKey(key)
    const sorted = [...group].sort((a, b) =>
      String(a['测量日期'] ?? '').localeCompare(String(b['测量日期'] ?? '')),
    )
    const starts = sorted.map((row) => toNumber(row['起点距']))
    const elevs = sorted.map((row) => toNumber(row['河底高程']))
    const validStarts = starts.filter((value): value is number => value !== null)
    const validElevs = elevs.filter((value): value is number => value !== null)
    const valid = validStarts.length === sorted.length && validElevs.length === sorted.length
    diffs.push({
      key,
      stationNo,
      section,
      valid,
      count: sorted.length,
      firstDate: String(sorted[0]?.['测量日期'] ?? ''),
      lastDate: String(sorted[sorted.length - 1]?.['测量日期'] ?? ''),
      startRange:
        validStarts.length > 0 ? Math.max(...validStarts) - Math.min(...validStarts) : null,
      elevRange: validElevs.length > 0 ? Math.max(...validElevs) - Math.min(...validElevs) : null,
      deltaElev:
        validElevs.length >= 2 ? validElevs[validElevs.length - 1] - validElevs[0] : null,
    })
  }
  return diffs.sort((a, b) => a.stationNo.localeCompare(b.stationNo) || a.section.localeCompare(b.section))
}

export function diffCsv(batch: CrossSectionBatch, rows: EntryRow[]): { filename: string; content: string } {
  const diffs = buildSectionDiffs(rows)
  const lines: string[] = []
  lines.push(['批次号', '版本', '校核状态', '校核人', '结论', '备注'].map(csvCell).join(','))
  lines.push(
    [batch.batchNo, `v${batch.version}`, batch.status, batch.checker, batch.conclusion, batch.remark]
      .map(csvCell)
      .join(','),
  )
  lines.push('')
  lines.push(['站点编号', '断面名称', '测次数', '首次测量', '末次测量', '起点距极差(米)', '河底高程极差(米)', '首末高程差(米)', '数据可核算'].map(csvCell).join(','))
  for (const diff of diffs) {
    lines.push(
      [
        diff.stationNo,
        diff.section,
        diff.count,
        diff.firstDate,
        diff.lastDate,
        diff.startRange ?? '',
        diff.elevRange ?? '',
        diff.deltaElev ?? '',
        diff.valid ? '是' : '否',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  lines.push('')
  lines.push(['记录编号', '站点编号', '断面名称', '测量日期', '测量方法', '起点距', '河底高程', '记录状态'].map(csvCell).join(','))
  for (const row of [...rows].sort((a, b) =>
    String(a['测量日期'] ?? '').localeCompare(String(b['测量日期'] ?? '')),
  )) {
    lines.push(
      [
        row['记录编号'],
        row['站点编号'],
        row['断面名称'],
        row['测量日期'],
        row['测量方法'],
        row['起点距'],
        row['河底高程'],
        row.status,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return {
    filename: `断面校核差异表-${batch.batchNo}-v${batch.version}.csv`,
    content: `﻿${lines.join('\n')}`,
  }
}

export function downloadDiff(batchId: number): { ok: boolean; message: string } {
  const detail = batchDetail(batchId)
  if (!detail) return { ok: false, message: '没有找到该校核批次' }
  const { filename, content } = diffCsv(detail.batch, detail.rows)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return { ok: true, message: `差异表 ${filename} 已开始下载` }
}

export function listTodos(): CrossCheckTodo[] {
  return loadState()
    .todos.map((todo) => ({ ...todo }))
    .sort((a, b) => b.passedAt.localeCompare(a.passedAt))
}

export function resolveTodo(todoId: number, operator: string): { ok: boolean; message: string } {
  const state = loadState()
  const todo = state.todos.find((item) => item.id === todoId)
  if (!todo) return { ok: false, message: '没有找到该核对项' }
  if (todo.status === '已核对') return { ok: false, message: '该核对项已确认，无需重复操作' }
  todo.status = '已核对'
  todo.resolvedAt = nowText()
  todo.remark = `${todo.remark}；${operator} 已于 ${todo.resolvedAt} 核对确认`
  saveState(state)
  return { ok: true, message: `核对项「${todo.title}」已确认` }
}

// 重置断面模块时同步清空批次与核对项，保证示例数据可重复演示。
export function resetCrossSection(): void {
  resetRows(MODULE_KEY)
  saveState({ ...EMPTY_STATE })
}
