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

// 断面批量校核：批次以「业务批次号 + 版本号」标识，重跑生成新版本，旧版本作废留痕。
export type BatchStatus = '待校核' | '已通过' | '未通过' | '已作废'
export type BatchOrigin = 'normal' | 'legacy'

export type CrossSectionBatch = {
  id: number
  batchNo: string
  version: number
  origin: BatchOrigin
  status: BatchStatus
  superseded: boolean
  recordIds: number[]
  sections: string[]
  createdAt: string
  createdBy: string
  submittedAt: string
  checker: string
  conclusion: '通过' | '未通过' | ''
  remark: string
}

// 水位整编待办里的断面核对项：refKey 以业务批次号归组，重跑不重复立项。
export type CrossCheckTodo = {
  id: number
  refKey: string
  batchNo: string
  version: number
  stationNo: string
  section: string
  title: string
  status: '待核对' | '已核对'
  source: BatchOrigin
  createdAt: string
  passedAt: string
  checker: string
  resolvedAt: string
  remark: string
}

export type CrossCheckState = {
  batches: CrossSectionBatch[]
  todos: CrossCheckTodo[]
  backfilled: boolean
}

export type SectionDiff = {
  key: string
  stationNo: string
  section: string
  valid: boolean
  count: number
  firstDate: string
  lastDate: string
  startRange: number | null
  elevRange: number | null
  deltaElev: number | null
}
