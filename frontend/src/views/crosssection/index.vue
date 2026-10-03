<template>
  <section class="page" data-module="crosssection">
    <header class="page-head">
      <div>
        <h2>断面测量管理</h2>
        <p class="page-desc">维护断面测量记录；待校核记录可按断面归组进入批量校核批次，一次给出结论并下载差异表。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记断面测量记录</button>
        <button class="btn" type="button" @click="exportRows">导出断面测量清单</button>
        <button class="btn ghost" type="button" @click="resetDemo">重置示例数据</button>
      </div>
    </header>

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

    <CrossSectionBatchPanel ref="batchPanel" :selected-ids="selectedIds" @changed="onBatchChanged" />

    <table class="data-table">
      <thead>
        <tr>
          <th style="width:36px">选</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td><input v-if="String(row.status) === '待校核'" type="checkbox" :value="Number(row.id)" v-model="selectedIds" /></td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openBatchOf(row)">查看批次</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无断面测量数据，可先登记断面测量记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条断面测量记录；已勾选 {{ selectedIds.length }} 条待校核记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import CrossSectionBatchPanel from '@/components/CrossSectionBatchPanel.vue'
import { listBatches, resetCrossSection } from '@/api/crosssection-batch'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('crosssection')
const columns = ['记录编号', '校核批次号', '站点编号', '断面名称', '测量方法', '起点距', '河底高程', '测量日期', '记录状态']
const statuses = ['已测量', '待校核', '已校核', '需重测']
const stats = [
  { label: '本月测量次数', value: 0 },
  { label: '待校核记录', value: 0 },
  { label: '需重测记录', value: 0 },
]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['记录编号', '站点编号', '断面名称']
const selectedIds = ref<number[]>([])
const batchPanel = ref<InstanceType<typeof CrossSectionBatchPanel> | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 校核结论必须整批给出：行内不再提供「确认校核」，只能提交校核或安排重测。
function availableActions(row: EntryRow): string[] {
  if (String(row.status) === '已测量') return ['提交校核']
  if (String(row.status) === '已校核') return []
  if (String(row.status) === '需重测') return ['提交校核']
  return ['安排重测']
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function resetDemo() {
  resetCrossSection()
  selectedIds.value = []
  errorMessage.value = '断面记录、校核批次与核对项已重置为示例状态'
  reload()
  batchPanel.value?.reload()
}

function openCreate() {
  errorMessage.value = '断面测量记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '确认校核') {
    errorMessage.value = '校核结论需在「批量校核批次」中整批给出，不支持单条确认'
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openBatchOf(row: EntryRow) {
  const batchNo = String(row['校核批次号'] ?? '')
  if (!batchNo) {
    errorMessage.value = `记录 ${row['记录编号']} 尚未进入任何校核批次`
    return
  }
  const target =
    listBatches().find((batch) => batch.batchNo === batchNo && !batch.superseded) ??
    listBatches().find((batch) => batch.batchNo === batchNo)
  if (!target) {
    errorMessage.value = `记录 ${row['记录编号']} 关联的批次 ${batchNo} 不存在`
    return
  }
  errorMessage.value = `已定位到批次 ${batchNo}（v${target.version}），可在上方批次列表点「查看/校核」`
}

function onBatchChanged() {
  selectedIds.value = []
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const stillPending = new Set(
      rows.value.filter((row) => String(row.status) === '待校核').map((row) => Number(row.id)),
    )
    selectedIds.value = selectedIds.value.filter((id) => stillPending.has(id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '断面测量列表读取失败'
  }
}

onMounted(reload)
</script>
