/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ===== 断面批量校核批次 =====

/** 批次内按断面归组后的分组结果（由待校核记录实时汇总，不单独落库）。 */
export type BatchSectionGroup = {
  section: string
  stationCode: string
  measureDates: string[]
  recordIds: number[]
  recordCodes: string[]
  /** 同断面多次测量的河底高程，已按数值解析；无法解析时为 null。 */
  elevations: (number | null)[]
  startDistances: (number | null)[]
  /** 多次测量间最大高程差（米），用于差异校核。 */
  elevationSpread: number | null
}

export type BatchConclusion = '通过' | '需重测'

export type CrossCheckBatch = {
  /** 批次号，形如 XH-202610-001；重跑新版本复用同一批次号、版本号递增。 */
  batchNo: string
  version: number
  status: '待校核' | '已通过' | '需重测' | '已被新版本替代'
  sectionNames: string[]
  recordIds: number[]
  groups: BatchSectionGroup[]
  checker: string
  conclusion: BatchConclusion | ''
  remark: string
  createdAt: string
  submittedAt: string
  /** 差异表（差异校核明细），提交结论时生成并随批次一起落库。 */
  differenceRows: BatchDifferenceRow[]
  /** 重跑来源批次号（新版本指向其根批次）。 */
  rerunOf: string
}

export type BatchDifferenceRow = {
  section: string
  stationCode: string
  measureCount: number
  measureDates: string
  elevations: string
  startDistances: string
  elevationSpread: string
  result: '符合限差' | '超差'
}

/** 批次提交入参（由页面勾选的待校核记录组装）。 */
export type SubmitBatchInput = {
  recordIds: number[]
  checker: string
  conclusion: BatchConclusion
  remark: string
}

export type BatchActionResult = {
  ok: boolean
  message: string
  batch?: CrossCheckBatch
  /** 失败时命中问题的断面，用于提示与整体回退。 */
  failedSections?: string[]
}

// ===== 水位整编待办（核对项） =====

export type CompilationTodo = {
  /** 幂等键：来源批次号 + 断面，重复提交不重复立项。 */
  id: string
  sourceBatchNo: string
  stationCode: string
  section: string
  measureCount: number
  measureDates: string
  title: string
  status: '待核对' | '已核对'
  createdAt: string
  checkedAt: string
}
