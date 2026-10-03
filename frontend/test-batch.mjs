// 断面批量校核的业务逻辑测试：用内存版 localStorage 跑回填/立项/整批回退/重跑/幂等待办。
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

const ENTRIES_KEY = 'hydrology-monitor-station:entries'
const CROSSCHECK_KEY = 'hydrology-monitor-station:crosscheck'

function makeLocalStorage(initial = new Map()) {
  const storage = new Map(initial)
  return {
    storage,
    ls: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  }
}

let bundleText
async function freshService(storage) {
  globalThis.window = { localStorage: storage.ls }
  if (!bundleText) {
    const result = await build({
      entryPoints: ['src/api/crosssection-batch.ts'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      alias: { '@': new URL('./src', import.meta.url).pathname },
    })
    bundleText = result.outputFiles[0].text
  }
  const file = new URL(`./.tmp-svc-${Math.random().toString(36).slice(2)}.mjs`, import.meta.url)
  writeFileSync(file, bundleText)
  return import(file.href)
}

let passed = 0
let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}
function readRows(box) {
  return JSON.parse(box.storage.get(ENTRIES_KEY)).crosssection
}

// ===== 场景 A：干净种子 -> 回填 -> 当批立项/整批结论/幂等/差异表/核对确认 =====
const boxA = makeLocalStorage()
const svc = await freshService(boxA)

const backfill = svc.backfillLegacyBatches('测试员')
check('回填生成 4 个历史批次（08-20 + 3 个混合日期）', backfill.batches === 4, `实际 ${backfill.batches}`)
check('回填覆盖 8 条记录（已测量/需重测不回填）', backfill.records === 8, `实际 ${backfill.records}`)
const batches1 = svc.listBatches()
const passedBatch = batches1.find((b) => b.batchNo.includes('20260820'))
check('全已校核日期的回填批次直接为已通过', passedBatch && passedBatch.status === '已通过')
const openBatches = batches1.filter((b) => b.status === '待校核')
check('其余 3 个日期批次为待校核', openBatches.length === 3, `实际 ${openBatches.length}`)
const noBackfilled = readRows(boxA).filter((r) => r.status === '已测量' || r.status === '需重测')
check('已测量/需重测不回填批次号', noBackfilled.every((r) => r['校核批次号'] === ''))
check('回填幂等：再次执行不新增', svc.backfillLegacyBatches().batches === 0)
check('回填通过批次生成 1 个断面核对项', svc.listTodos().length === 1, `实际 ${svc.listTodos().length}`)

// 只有待校核且未被占用的记录可立项
check('回填后无游离待校核记录可立项', svc.listSelectableRows().length === 0)

// 提交校核会把「需重测」记录（id=10）变回待校核（行内提交校核动作），此时它不在任何批次中 -> 可新建批次
{
  const entries = JSON.parse(boxA.storage.get(ENTRIES_KEY))
  const r = entries.crosssection.find((x) => x.id === 10)
  r.status = '待校核'
  r.abnormal = false
  r.pending = true
  boxA.storage.set(ENTRIES_KEY, JSON.stringify(entries))
}
// 用新实例读到刚改的状态后立项
const boxA2 = makeLocalStorage(boxA.storage)
const svcA2 = await freshService(boxA2)
const free = svcA2.listSelectableRows()
check('重测后提交校核的记录可进入新批次', free.length === 1 && free[0].id === 10, `实际 ${free.length}`)
const created = svcA2.createBatch([10], '值班员')
check('新批次立项成功（普通批次号）', created.ok && created.batchId !== undefined, created.message)
const newBatch = svcA2.batchDetail(created.batchId).batch
check('普通批次号形如 HD-PH-202610-NNN', /^HD-PH-\d{6}-\d{3}$/.test(newBatch.batchNo), newBatch.batchNo)
check('重复集合立项被拦截（不得重复立项）', svcA2.createBatch([10], '值班员').ok === false)

// 存量待校核批次（09-05，2 断面 2 条）整批通过
const b0905 = svcA2.listBatches().find((b) => b.batchNo.includes('20260905'))
const submitOk = svcA2.submitReview(b0905.id, '通过', '李校核', '断面稳定')
check('09-05 批次整批通过', submitOk.ok, submitOk.message)
check('批次内记录全部变为已校核', readRows(boxA2).filter((r) => b0905.recordIds.includes(r.id)).every((r) => r.status === '已校核'))
check('通过后核对项总数 3（回填 1 + 本次 2 断面）', svcA2.listTodos().length === 3, `实际 ${svcA2.listTodos().length}`)
check('重复提交同一批次被拦截', svcA2.submitReview(b0905.id, '通过', '李校核', '').ok === false)

// 新建的普通批次整批未通过 -> 记录需重测
const submitFail = svcA2.submitReview(created.batchId, '未通过', '李校核', '高程存疑')
check('普通批次可整批未通过', submitFail.ok, submitFail.message)
check('未通过批次内记录变为需重测并标记异常', readRows(boxA2).find((r) => r.id === 10).status === '需重测')

// 核对项确认与重复确认
const todo = svcA2.listTodos().find((t) => t.batchNo === b0905.batchNo)
check('核对项可确认', svcA2.resolveTodo(todo.id, '整编员').ok)
check('核对项重复确认被拦截', svcA2.resolveTodo(todo.id, '整编员').ok === false)

// 差异表
const detail0905 = svcA2.batchDetail(b0905.id)
const { filename, content } = svcA2.diffCsv(detail0905.batch, detail0905.rows)
check('差异表文件名含批次号与版本', filename.includes(b0905.batchNo) && filename.includes('v1'))
check('差异表含断面汇总段与明细段', content.includes('河底高程极差') && content.includes('CROS-0004'))

// ===== 场景 B：任一断面核算失败 -> 整批回退 =====
const boxB = makeLocalStorage()
const svcB = await freshService(boxB)
svcB.backfillLegacyBatches('测试员')
const bB = svcB.listBatches().find((x) => x.batchNo.includes('20260910'))
{
  const entries = JSON.parse(boxB.storage.get(ENTRIES_KEY))
  const victim = entries.crosssection.find((r) => bB.recordIds.includes(r.id))
  victim['河底高程'] = 'NaN值'
  boxB.storage.set(ENTRIES_KEY, JSON.stringify(entries))
}
const boxB2 = makeLocalStorage(boxB.storage)
const svcB2 = await freshService(boxB2)
const bB2 = svcB2.listBatches().find((x) => x.batchNo.includes('20260910'))
const bad = svcB2.submitReview(bB2.id, '通过', '李校核', '')
check('坏数据断面导致整批提交失败并指出断面', bad.ok === false && bad.failedSection !== undefined, bad.message)
check('失败后记录全部仍为待校核（整批回退）', readRows(boxB2).filter((r) => bB2.recordIds.includes(r.id)).every((r) => r.status === '待校核'))
check('失败后批次仍为待校核', svcB2.listBatches().find((x) => x.id === bB2.id).status === '待校核')

// ===== 场景 C：修复后整批未通过 -> 重测 -> 重跑生成新版本 -> 待办不重复立项 =====
{
  const entries = JSON.parse(boxB2.storage.get(ENTRIES_KEY))
  const v = entries.crosssection.find((r) => r['河底高程'] === 'NaN值')
  v['河底高程'] = '37.51'
  boxB2.storage.set(ENTRIES_KEY, JSON.stringify(entries))
}
const boxC = makeLocalStorage(boxB2.storage)
const svcC = await freshService(boxC)
const bC = svcC.listBatches().find((x) => x.batchNo.includes('20260910'))
const failSubmit = svcC.submitReview(bC.id, '未通过', '李校核', '需重测')
check('修复后批次可整批未通过', failSubmit.ok, failSubmit.message)
check('记录全部变为需重测', readRows(boxC).filter((r) => bC.recordIds.includes(r.id)).every((r) => r.status === '需重测'))
check('无待校核重测记录时重跑被拦截', svcC.rerunBatch(bC.id, '测试员').ok === false)

// 重测完成：记录改回待校核，新实例重跑
{
  const entries = JSON.parse(boxC.storage.get(ENTRIES_KEY))
  for (const r of entries.crosssection) {
    if (bC.recordIds.includes(r.id)) {
      r.status = '待校核'
      r.abnormal = false
      r.pending = true
    }
  }
  boxC.storage.set(ENTRIES_KEY, JSON.stringify(entries))
}
const boxD = makeLocalStorage(boxC.storage)
const svcD = await freshService(boxD)
const bD = svcD.listBatches().find((x) => x.batchNo.includes('20260910'))
const rerun = svcD.rerunBatch(bD.id, '测试员')
check('重跑生成新版本批次', rerun.ok && rerun.batchId !== undefined, rerun.message)
const versions = svcD.listBatches().filter((x) => x.batchNo === bD.batchNo)
check('同业务批次号存在 v1/v2', versions.length === 2 && versions.some((x) => x.version === 1) && versions.some((x) => x.version === 2))
check('旧版本作废留痕（已作废 + superseded）', versions.find((x) => x.version === 1).status === '已作废' && versions.find((x) => x.version === 1).superseded === true)
check('新版本为待校核', versions.find((x) => x.version === 2).status === '待校核')
const passV2 = svcD.submitReview(rerun.batchId, '通过', '王复核', '重测合格')
check('新版本可整批通过', passV2.ok, passV2.message)
check('通过后记录全部已校核', readRows(boxD).filter((r) => bD.recordIds.includes(r.id)).every((r) => r.status === '已校核'))
const todosSameNo = svcD.listTodos().filter((t) => t.batchNo === bD.batchNo)
check('重跑通过不重复立项：同业务批次号仍为 3 个核对项', todosSameNo.length === 3, `实际 ${todosSameNo.length}`)
check('核对项版本升到 v2 并回到待核对', todosSameNo.every((t) => t.version === 2 && t.status === '待核对'))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
