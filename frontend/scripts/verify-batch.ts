import { listRows, saveRows } from '@/data/local-store'
import {
  backfillLegacyBatches,
  listBatches,
  listCompilationTodos,
  pendingGroups,
  rerunBatch,
  submitBatch,
  submitBatchDraft,
} from '@/api/crosscheck-batch'
import type { EntryRow } from '@/data/types'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++
    console.log('  ✅', msg)
  } else {
    fail++
    console.error('  ❌', msg)
  }
}

// 0) 回填存量：按 断面+测量月份 补历史批次号，只补号不改状态
const bf = backfillLegacyBatches()
console.log('回填结果', bf)
const rows0 = listRows('crosssection')
assert(rows0.every((r) => String(r['批次号']).startsWith('XHBACK-')), '所有存量记录都回填了历史批次号')
assert(rows0.find((r) => r.id === 2)!['批次号'] === rows0.find((r) => r.id === 3)!['批次号'], '同断面同月记录批次号相同 (id2=id3)')
assert(rows0.find((r) => r.id === 2)!['批次号'] !== rows0.find((r) => r.id === 4)!['批次号'], '不同断面批次号不同')
assert(rows0.every((r) => r.status !== '' && typeof r.status === 'string'), '回填不改动状态')
// 迁移幂等：第二次不处理
const bf2 = backfillLegacyBatches()
assert(bf2.updated === 0 && bf2.groups === 0, '回填迁移只执行一次（幂等）')

// 1) 待校核归组：只有 待校核 能进入
const groups = pendingGroups()
console.log('待校核断面', groups.map((g) => `${g.section}(${g.recordIds.length},spread=${g.elevationSpread})`))
assert(groups.length === 3, '待校核记录按断面归成 3 组')
assert(!groups.some((g) => g.recordIds.includes(1)), '已测量记录(id1)不进入批次')
assert(!groups.some((g) => g.recordIds.includes(8)), '已校核记录(id8)不进入批次')
assert(!groups.some((g) => g.recordIds.includes(9)), '需重测记录(id9)不进入批次')

// 2) 整体提交：丙断面高程差 0.90 > 0.5，应失败并整体回退
const pendingIds = [2, 3, 4, 5, 6, 7]
const snapshot = listRows('crosssection').map((r) => ({ ...r }))
const r1 = submitBatch({ recordIds: pendingIds, checker: '张三', conclusion: '通过', remark: '' })
console.log('超差提交:', r1.ok, r1.message)
assert(!r1.ok, '含超差断面时批次提交失败')
assert((r1.failedSections ?? []).includes('丙站浮标测流断面'), '失败断面定位到丙站浮标测流断面')
assert(listBatches().length === 0, '失败后没有任何批次落库')
assert(listCompilationTodos().length === 0, '失败后不产生水位整编待办')
const after = listRows('crosssection')
assert(
  pendingIds.every((id) => {
    const b = after.find((x) => x.id === id)!
    const a = snapshot.find((x) => x.id === id)!
    return b.status === a.status && b['批次号'] === a['批次号']
  }),
  '失败后所有记录状态/批次号整体回退到提交前',
)

// 3) 只选 甲+乙（高程差合格）整体通过
const r2 = submitBatch({ recordIds: [2, 3, 4, 5], checker: '张三', conclusion: '通过', remark: '合格' })
console.log('通过提交:', r2.ok, r2.message)
assert(r2.ok, '甲+乙合格断面提交成功')
const batch = r2.batch!
const month = new Date().toISOString().slice(0, 7).replace('-', '')
const expectedNo = `XH-${month}-001`
assert(batch.batchNo === expectedNo, `批次号为 ${expectedNo}，实际 ${batch.batchNo}`)
assert(batch.version === 1, '首版版本号 V1')
const rows3 = listRows('crosssection')
assert([2, 3, 4, 5].every((id) => rows3.find((r) => r.id === id)!.status === '已校核'), '通过后记录整体转为已校核')
assert([2, 3, 4, 5].every((id) => String(rows3.find((r) => r.id === id)!['批次号']) === expectedNo), '通过记录带正式批次号（覆盖回填号）')
const todos1 = listCompilationTodos()
assert(todos1.length === 2 && todos1.every((t) => t.status === '待核对'), '通过后按 2 个断面立项 2 条水位整编核对待办')

// 4) 重复提交同一批次（记录已非待校核）不得重复立项
const r3 = submitBatch({ recordIds: [2, 3, 4, 5], checker: '张三', conclusion: '通过', remark: '' })
assert(!r3.ok, '已校核记录不能再次进入批次（拦截重复提交）')
assert(listCompilationTodos().length === 2, '重复提交不重复立项')
assert(listBatches().length === 1, '重复提交不产生第二条批次')

// 5) 需重测结论：不立项，记录整体转需重测
const r4 = submitBatch({ recordIds: [6, 7], checker: '李四', conclusion: '需重测', remark: '丙断面异常' })
assert(!r4.ok, '丙断面超差时即使结论需重测也被硬校验拦截（整批回退）')
// 制造合格的需重测场景：手动把丙断面高程改成合格
let rows4 = listRows('crosssection')
rows4 = rows4.map((r) => (r.id === 7 ? { ...r, '河底高程': 52.46 } : r))
saveRows('crosssection', rows4)
const r5 = submitBatch({ recordIds: [6, 7], checker: '李四', conclusion: '需重测', remark: '外业复核' })
assert(r5.ok, '丙断面修正后需重测批次可提交')
const rows5 = listRows('crosssection')
assert([6, 7].every((id) => rows5.find((r) => r.id === id)!.status === '需重测'), '需重测结论记录整体转为需重测')
assert(listCompilationTodos().length === 2, '需重测批次不产生水位整编待办')

// 6) 批次重跑：生成新版本，老版本被替代
// 重测后甲、乙断面各产生 2 个新的待校核测次
let rows6 = listRows('crosssection')
const nextId = Math.max(...rows6.map((r) => Number(r.id))) + 1
const add: EntryRow[] = [
  { id: nextId, status: '待校核', pending: true, abnormal: false, '记录编号': 'CROS-N1', '站点编号': 'ST-101', '断面名称': '甲站基本水尺断面', '测量方法': '水准测量', '起点距': 0, '河底高程': 45.31, '测量日期': '2026-10-02', '批次号': '', '记录状态': '已录入' },
  { id: nextId + 1, status: '待校核', pending: true, abnormal: false, '记录编号': 'CROS-N2', '站点编号': 'ST-101', '断面名称': '甲站基本水尺断面', '测量方法': '水准测量', '起点距': 0, '河底高程': 45.29, '测量日期': '2026-10-03', '批次号': '', '记录状态': '已录入' },
  { id: nextId + 2, status: '待校核', pending: true, abnormal: false, '记录编号': 'CROS-N3', '站点编号': 'ST-102', '断面名称': '乙站流速仪测流断面', '测量方法': '回声测深仪', '起点距': 12, '河底高程': 38.14, '测量日期': '2026-10-02', '批次号': '', '记录状态': '已录入' },
  { id: nextId + 3, status: '待校核', pending: true, abnormal: false, '记录编号': 'CROS-N4', '站点编号': 'ST-102', '断面名称': '乙站流速仪测流断面', '测量方法': '回声测深仪', '起点距': 12, '河底高程': 38.12, '测量日期': '2026-10-03', '批次号': '', '记录状态': '已录入' },
]
saveRows('crosssection', [...rows6, ...add])
const r6 = rerunBatch(expectedNo, 1)
console.log('重跑:', r6.ok, r6.message)
assert(r6.ok, '已通过批次可重跑')
const batches6 = listBatches()
assert(batches6.length === 3, '批次总数=原通过批次 + 需重测批次 + 新草稿 (3)')
const v1 = batches6.find((b) => b.batchNo === expectedNo && b.version === 1)!
const draft = batches6.find((b) => b.batchNo === expectedNo && b.version === 2)!
assert(v1.status === '已被新版本替代', 'V1 被标记为已被新版本替代（历史保留不覆盖）')
assert(draft.status === '待校核' && draft.version === 2, '生成 V2 待校核草稿')
assert(draft.recordIds.length === 4, 'V2 收集原批次断面下新的待校核记录 4 条')

// 7) 提交 V2 草稿（整体落库），通过后按 V2 断面立项，不影响既有待办
const r7 = submitBatchDraft({ batchNo: expectedNo, version: 2 }, { checker: '张三', conclusion: '通过', remark: '复核通过' })
if (!r7.ok) console.error('V2 提交失败原因:', r7.message)
assert(r7.ok, 'V2 草稿提交成功')
const todos7 = listCompilationTodos()
assert(todos7.filter((t) => t.sourceBatchNo.includes('V2')).length === 2, 'V2 通过后按断面立项（带 V2 标识，2 条）')
assert(todos7.filter((t) => !t.sourceBatchNo.includes('V2')).length === 2, 'V1 的 2 条待办保留不重复')

// 8) V2 已提交后再次提交同一草稿 -> 拦截，不重复立项
const r8 = submitBatchDraft({ batchNo: expectedNo, version: 2 }, { checker: '张三', conclusion: '通过', remark: '' })
assert(!r8.ok, '已提交的版本草稿不能重复提交')
assert(listCompilationTodos().length === todos7.length, '重复提交 V2 不重复立项')

// 9) 重跑一个已被替代的版本 -> 拒绝
const r9 = rerunBatch(expectedNo, 1)
assert(!r9.ok, '不能重跑已被替代的 V1')

// 10) 差异表内容校验
const diff = r7.batch!.differenceRows
assert(diff.length === 2 && diff.every((d) => d.result === '符合限差'), 'V2 差异表含 2 个断面且均符合限差')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
