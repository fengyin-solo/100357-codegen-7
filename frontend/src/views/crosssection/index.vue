<template>
  <section class="page" data-module="crosssection">
    <header class="page-head">
      <div>
        <h2>断面测量管理</h2>
        <p class="page-desc">多次测量按断面归组组建校核批次，校核人一次给出整体结论并下载差异表；任一断面校核失败则整批回退。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记断面测量记录</button>
        <button class="btn" type="button" @click="exportRows">导出断面测量清单</button>
      </div>
    </header>

    <div class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-item"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}
        <em v-if="tab.key === 'create' && pendingCount" class="tab-badge">{{ pendingCount }}</em>
      </button>
    </div>

    <span v-if="notice" class="inline-notice" :class="noticeKind" role="status">{{ notice }}</span>

    <!-- 测量记录 -->
    <div v-show="activeTab === 'records'">
      <div class="stat-row">
        <article v-for="item in stats" :key="item.label" class="stat-card">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="stat-value">{{ item.value }}</strong>
        </article>
      </div>

      <p class="status-legend">
        <span v-for="item in statusSummary" :key="item.status" class="legend-item">
          {{ item.status }}：{{ item.count }}
        </span>
      </p>

      <form class="filter-bar" @submit.prevent="reload">
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无断面测量数据</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>共 {{ total }} 条断面测量记录</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </div>

    <!-- 组建校核批次 -->
    <div v-show="activeTab === 'create'">
      <div class="batch-panel">
        <h3>待校核记录按断面归组</h3>
        <p class="hint">只有「待校核」记录会出现在这里。同一断面至少 2 个测次、河底高程较差不超过 ±{{ tolerance }}m 才能整批通过。</p>

        <div v-if="!groups.length" class="empty-block">当前没有待校核记录，先在「测量记录」里提交校核。</div>

        <div v-for="group in groups" :key="group.section" class="section-card" :class="{ 'has-error': failedSections.includes(group.section) }">
          <label class="section-check">
            <input
              type="checkbox"
              :checked="isGroupAllSelected(group)"
              @change="toggleGroup(group, ($event.target as HTMLInputElement).checked)"
            />
            <strong>{{ group.section }}</strong>
            <span class="muted">（站点 {{ group.stationCode }} · {{ group.recordIds.length }} 测次）</span>
          </label>
          <table class="data-table inner">
            <thead>
              <tr><th>选择</th><th>记录编号</th><th>测量日期</th><th>测量方法</th><th>起点距(m)</th><th>河底高程(m)</th></tr>
            </thead>
            <tbody>
              <tr v-for="(record, idx) in groupRecords(group)" :key="String(record.id)">
                <td><input type="checkbox" :value="Number(record.id)" v-model="selectedRecordIds" /></td>
                <td>{{ record['记录编号'] }}</td>
                <td>{{ record['测量日期'] }}</td>
                <td>{{ record['测量方法'] }}</td>
                <td>{{ group.startDistances[idx] === null ? '不可解析' : group.startDistances[idx] }}</td>
                <td>{{ group.elevations[idx] === null ? '不可解析' : group.elevations[idx] }}</td>
              </tr>
            </tbody>
          </table>
          <p class="section-meta">
            高程较差：
            <strong :class="group.elevationSpread !== null && group.elevationSpread > tolerance ? 'error-text' : ''">
              {{ group.elevationSpread === null ? '—' : group.elevationSpread.toFixed(2) + ' m' }}
            </strong>
            <span v-if="group.recordIds.length < 2" class="error-text">（不足 2 测次，整批会回退）</span>
          </p>
        </div>

        <div v-if="groups.length" class="batch-form">
          <label class="filter-item">
            <span>校核人</span>
            <input v-model="checker" placeholder="请输入校核人" />
          </label>
          <label class="filter-item">
            <span>整体结论</span>
            <select v-model="conclusion">
              <option value="" disabled>请选择结论</option>
              <option value="通过">通过</option>
              <option value="需重测">需重测</option>
            </select>
          </label>
          <label class="filter-item remark">
            <span>校核意见</span>
            <input v-model="remark" placeholder="可填写整体校核意见" />
          </label>
        </div>
        <div v-if="groups.length" class="batch-submit">
          <span class="muted">已选 {{ selectedRecordIds.length }} 条待校核记录，提交后整体落库，任一断面失败全部回退。</span>
          <button class="btn primary" type="button" :disabled="submitting" @click="submit">
            {{ submitting ? '提交中…' : '整体提交校核批次' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 批次历史 / 版本重跑 -->
    <div v-show="activeTab === 'batches'">
      <div class="batch-panel">
        <h3>校核批次</h3>
        <p class="hint">批次重跑采用新版本方式：历史结论保留并标记为「已被新版本替代」，新版本复用批次号、版本号递增。</p>
        <div v-if="!batches.length" class="empty-block">还没有校核批次。</div>
        <article v-for="batch in batches" :key="`${batch.batchNo}-${batch.version}`" class="batch-card">
          <header class="batch-card-head">
            <div>
              <strong class="batch-no">{{ batchLabel(batch) }}</strong>
              <span class="batch-status" :class="batchStatusClass(batch)">{{ batch.status }}</span>
              <span v-if="batch.rerunOf" class="muted">重跑自 {{ batch.rerunOf }}</span>
            </div>
            <div class="row-actions">
              <button class="btn" type="button" @click="downloadDiff(batch)">下载差异表</button>
              <button
                v-if="batch.status === '已通过' || batch.status === '需重测'"
                class="btn"
                type="button"
                @click="rerun(batch)"
              >
                重跑（生成新版本）
              </button>
              <button
                v-if="batch.status === '待校核'"
                class="btn primary"
                type="button"
                @click="openDraft(batch)"
              >
                提交新版本结论
              </button>
            </div>
          </header>
          <p class="batch-meta">
            校核人：{{ batch.checker || '—' }} ｜ 结论：{{ batch.conclusion || '待提交' }} ｜
            断面：{{ batch.sectionNames.join('、') }} ｜ 记录数：{{ batch.recordIds.length }} ｜
            提交时间：{{ batch.submittedAt || '—' }}
          </p>
          <p v-if="batch.remark" class="muted">意见：{{ batch.remark }}</p>

          <form v-if="draftOpen === batchKey(batch)" class="draft-form" @submit.prevent="submitDraft(batch)">
            <label class="filter-item">
              <span>校核人</span>
              <input v-model="draftChecker" />
            </label>
            <label class="filter-item">
              <span>整体结论</span>
              <select v-model="draftConclusion">
                <option value="通过">通过</option>
                <option value="需重测">需重测</option>
              </select>
            </label>
            <label class="filter-item remark">
              <span>校核意见</span>
              <input v-model="draftRemark" />
            </label>
            <button class="btn primary" type="submit">提交新版本（整体落库）</button>
            <button class="btn ghost" type="button" @click="draftOpen = ''">取消</button>
          </form>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  buildDifferenceCsv,
  displayBatchNo,
  downloadDifference,
  listBatches,
  pendingGroups,
  rerunBatch,
  submitBatch,
  submitBatchDraft,
} from '@/api/crosscheck-batch'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type {
  BatchConclusion,
  BatchSectionGroup,
  CrossCheckBatch,
  EntryRow,
} from '@/data/types'

const meta = moduleMeta('crosssection')
const columns = ['记录编号', '站点编号', '断面名称', '测量方法', '起点距', '河底高程', '测量日期', '批次号', '记录状态']
const actions = ['提交校核', '确认校核', '安排重测']
const statuses = ['已测量', '待校核', '已校核', '需重测']
const tolerance = 0.5

const tabs = [
  { key: 'records', label: '测量记录' },
  { key: 'create', label: '组建校核批次' },
  { key: 'batches', label: '批次与版本' },
] as const

type TabKey = (typeof tabs)[number]['key']
const activeTab = ref<TabKey>('records')

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const groups = ref<BatchSectionGroup[]>([])
const batches = ref<CrossCheckBatch[]>([])
const selectedRecordIds = ref<number[]>([])
const checker = ref('值班校核员')
const conclusion = ref<BatchConclusion | ''>('')
const remark = ref('')
const submitting = ref(false)
const failedSections = ref<string[]>([])

const draftOpen = ref('')
const draftChecker = ref('')
const draftConclusion = ref<BatchConclusion>('通过')
const draftRemark = ref('')

const notice = ref('')
const noticeKind = ref<'ok' | 'err'>('ok')

const stats = computed(() => [
  { label: '本月测量次数', value: rows.value.length },
  { label: '待校核记录', value: rows.value.filter((r) => r.status === '待校核').length },
  { label: '需重测记录', value: rows.value.filter((r) => r.status === '需重测').length },
])
const pendingCount = computed(() => groups.value.reduce((sum, g) => sum + g.recordIds.length, 0))
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function groupRecords(group: BatchSectionGroup): EntryRow[] {
  const byId = new Map(rows.value.map((row) => [Number(row.id), row]))
  return group.recordIds
    .map((id) => byId.get(id))
    .filter((row): row is EntryRow => Boolean(row))
}

function flash(message: string, kind: 'ok' | 'err' = 'ok') {
  notice.value = message
  noticeKind.value = kind
}

function switchTab(key: TabKey) {
  activeTab.value = key
  notice.value = ''
  if (key === 'create') {
    reloadGroups()
  } else if (key === 'batches') {
    batches.value = listBatches()
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '断面测量记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    groups.value = pendingGroups()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '断面测量列表读取失败'
  }
}

function reloadGroups() {
  groups.value = pendingGroups()
  // 默认全选所有待校核断面与其记录。
  selectedRecordIds.value = groups.value.flatMap((g) => g.recordIds)
  failedSections.value = []
}

function isGroupAllSelected(group: BatchSectionGroup): boolean {
  return group.recordIds.every((id) => selectedRecordIds.value.includes(id))
}

function toggleGroup(group: BatchSectionGroup, checked: boolean) {
  if (checked) {
    const merged = new Set([...selectedRecordIds.value, ...group.recordIds])
    selectedRecordIds.value = [...merged]
  } else {
    const remove = new Set(group.recordIds)
    selectedRecordIds.value = selectedRecordIds.value.filter((id) => !remove.has(id))
  }
}

function submit() {
  if (!conclusion.value) {
    flash('请先选择整体校核结论', 'err')
    return
  }
  submitting.value = true
  const result = submitBatch({
    recordIds: selectedRecordIds.value,
    checker: checker.value,
    conclusion: conclusion.value,
    remark: remark.value,
  })
  submitting.value = false
  if (!result.ok) {
    failedSections.value = result.failedSections ?? []
    flash(result.message, 'err')
    return
  }
  flash(result.message, 'ok')
  conclusion.value = ''
  remark.value = ''
  failedSections.value = []
  reload()
  reloadGroups()
  batches.value = listBatches()
  activeTab.value = 'batches'
}

function batchLabel(batch: CrossCheckBatch): string {
  return displayBatchNo(batch)
}

function batchKey(batch: CrossCheckBatch): string {
  return `${batch.batchNo}::${batch.version}`
}

function batchStatusClass(batch: CrossCheckBatch): string {
  if (batch.status === '已通过') return 'tag-ok'
  if (batch.status === '需重测') return 'tag-err'
  if (batch.status === '已被新版本替代') return 'tag-muted'
  return 'tag-pending'
}

function downloadDiff(batch: CrossCheckBatch) {
  // 差异表在提交结论时已随批次落库；草稿版本则实时按当前分组导出。
  if (batch.differenceRows.length > 0 && batch.submittedAt) {
    downloadDifference(batch)
    return
  }
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

function rerun(batch: CrossCheckBatch) {
  const result = rerunBatch(batch.batchNo, batch.version)
  if (!result.ok) {
    flash(result.message, 'err')
    return
  }
  batches.value = listBatches()
  reload()
  flash(result.message, 'ok')
}

function openDraft(batch: CrossCheckBatch) {
  draftOpen.value = batchKey(batch)
  draftChecker.value = batch.checker
  draftConclusion.value = '通过'
  draftRemark.value = ''
}

function submitDraft(batch: CrossCheckBatch) {
  const result = submitBatchDraft(
    { batchNo: batch.batchNo, version: batch.version },
    { checker: draftChecker.value, conclusion: draftConclusion.value, remark: draftRemark.value },
  )
  if (!result.ok) {
    failedSections.value = result.failedSections ?? []
    flash(result.message, 'err')
    return
  }
  draftOpen.value = ''
  failedSections.value = []
  batches.value = listBatches()
  reload()
  flash(result.message, 'ok')
}

onMounted(() => {
  reload()
  reloadGroups()
  batches.value = listBatches()
})
</script>
