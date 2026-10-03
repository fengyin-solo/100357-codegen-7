<template>
  <section class="batch-panel">
    <div class="batch-panel-head">
      <div>
        <h3>批量校核批次</h3>
        <p>仅「待校核」记录可进入批次；提交时任一断面核算失败将整体回退；批次重跑生成新版本，旧版本作废留痕。</p>
      </div>
      <div class="row-actions">
        <button class="btn primary" type="button" @click="openCreate">按勾选记录立项</button>
        <button class="btn ghost" type="button" @click="reload">刷新批次</button>
      </div>
    </div>

    <p v-if="!selectedIds.length" class="page-desc">在下方清单勾选待校核记录后，再点「按勾选记录立项」。</p>

    <table class="data-table">
      <thead>
        <tr>
          <th>批次号</th>
          <th>版本</th>
          <th>来源</th>
          <th>状态</th>
          <th>断面数</th>
          <th>记录数</th>
          <th>校核人</th>
          <th>结论</th>
          <th>立项/提交时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="batch in batches" :key="batch.id">
          <td>{{ batch.batchNo }}</td>
          <td>v{{ batch.version }}<span v-if="batch.superseded" class="tag void" style="margin-left:4px">已作废</span></td>
          <td><span class="tag" :class="batch.origin === 'legacy' ? 'legacy' : 'normal'">{{ batch.origin === 'legacy' ? '存量回填' : '当批立项' }}</span></td>
          <td><span class="tag" :class="statusClass(batch.status)">{{ batch.status }}</span></td>
          <td>{{ batch.sectionCount }}</td>
          <td>{{ batch.recordCount }}</td>
          <td>{{ batch.checker || '—' }}</td>
          <td>{{ batch.conclusion || '—' }}</td>
          <td>{{ batch.submittedAt || batch.createdAt }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(batch.id)">查看/校核</button>
            <button class="link" type="button" @click="download(batch.id)">下载差异表</button>
            <button v-if="batch.status === '未通过' && !batch.superseded" class="link" type="button" @click="rerun(batch.id)">重跑新版本</button>
          </td>
        </tr>
        <tr v-if="!batches.length">
          <td colspan="10" class="empty-state">还没有校核批次，先勾选待校核记录立项</td>
        </tr>
      </tbody>
    </table>

    <!-- 立项弹窗 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>新建校核批次</h3>
          <button class="modal-close" type="button" @click="creating = false">×</button>
        </div>
        <div class="form-row">
          <label style="flex-direction:row;align-items:center;gap:6px">
            <input type="checkbox" :checked="allPicked" @change="toggleAll" />
            全选当前可立项记录
          </label>
          <button class="btn ghost" type="button" @click="pickedIds = []">清空勾选</button>
        </div>
        <p class="page-desc">以下待校核记录将按「站点编号 + 断面名称」归组，校核结论对批次内全部断面生效；已被待校核批次占用的记录不会出现。</p>
        <table class="data-table">
          <thead>
            <tr>
              <th style="width:36px">选</th>
              <th v-for="column in pickColumns" :key="column">{{ column }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in selectable" :key="String(row.id)">
              <td><input type="checkbox" :value="Number(row.id)" v-model="pickedIds" /></td>
              <td v-for="column in pickColumns" :key="column">{{ row[column] ?? '—' }}</td>
            </tr>
            <tr v-if="!selectable.length">
              <td :colspan="pickColumns.length + 1" class="empty-state">暂无可立项的待校核记录（可能已被其他待校核批次占用）</td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn" type="button" @click="creating = false">取消</button>
          <button class="btn primary" type="button" :disabled="!pickedIds.length" @click="confirmCreate">确认立项（{{ pickedIds.length }} 条）</button>
        </div>
      </div>
    </div>

    <!-- 批次详情 / 提交结论弹窗 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal wide">
        <div class="modal-head">
          <h3>批次 {{ detail.batch.batchNo }}（v{{ detail.batch.version }}）校核详情</h3>
          <button class="modal-close" type="button" @click="detail = null">×</button>
        </div>

        <div class="meta-grid">
          <div><span>状态：</span><span class="tag" :class="statusClass(detail.batch.status)">{{ detail.batch.status }}</span></div>
          <div><span>来源：</span>{{ detail.batch.origin === 'legacy' ? '存量记录回填' : '当批立项' }}</div>
          <div><span>立项人：</span>{{ detail.batch.createdBy }}</div>
          <div><span>立项时间：</span>{{ detail.batch.createdAt }}</div>
          <div><span>校核人：</span>{{ detail.batch.checker || '—' }}</div>
          <div><span>提交时间：</span>{{ detail.batch.submittedAt || '—' }}</div>
          <div><span>结论：</span>{{ detail.batch.conclusion || '待给出' }}</div>
          <div style="grid-column: span 2"><span>备注：</span>{{ detail.batch.remark || '—' }}</div>
        </div>

        <p class="page-desc">按断面归组的多次测量差异：</p>
        <table class="data-table">
          <thead>
            <tr>
              <th>站点编号</th>
              <th>断面名称</th>
              <th>测次数</th>
              <th>首次测量</th>
              <th>末次测量</th>
              <th>起点距极差(米)</th>
              <th>河底高程极差(米)</th>
              <th>首末高程差(米)</th>
              <th>数据可核算</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="diff in diffs" :key="diff.key">
              <td>{{ diff.stationNo }}</td>
              <td>{{ diff.section }}</td>
              <td>{{ diff.count }}</td>
              <td>{{ diff.firstDate }}</td>
              <td>{{ diff.lastDate }}</td>
              <td>{{ diff.startRange ?? '—' }}</td>
              <td>{{ diff.elevRange ?? '—' }}</td>
              <td>{{ diff.deltaElev ?? '—' }}</td>
              <td><span :class="diff.valid ? 'tag passed' : 'section-invalid'">{{ diff.valid ? '是' : '否（阻断提交）' }}</span></td>
            </tr>
          </tbody>
        </table>

        <p class="page-desc" style="margin-top:12px">批次内测量记录：</p>
        <div v-for="group in recordGroups" :key="group.key" class="section-group">
          <div class="section-group-head">
            <strong>{{ group.stationNo }} · {{ group.section }}</strong>
            <span>{{ group.rows.length }} 次测量</span>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th v-for="column in detailColumns" :key="column">{{ column }}</th>
                <th>当前状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in group.rows" :key="String(row.id)">
                <td v-for="column in detailColumns" :key="column">{{ row[column] ?? '—' }}</td>
                <td>{{ row.status }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="canSubmit" class="form-row">
          <label>校核人
            <input v-model="checker" placeholder="请输入校核人姓名" />
          </label>
          <label style="flex:1">整体校核意见
            <textarea v-model="remark" placeholder="一次给出批次结论；通过后向水位整编待办推送核对项，未通过则批次内待校核记录全部安排重测"></textarea>
          </label>
        </div>

        <p v-if="detailError" class="error-text">{{ detailError }}</p>

        <div class="modal-actions">
          <button class="btn" type="button" @click="download(detail.batch.id)">下载差异表</button>
          <button class="btn" type="button" @click="detail = null">关闭</button>
          <template v-if="canSubmit">
            <button class="btn primary" type="button" @click="submit('通过')">一次给出结论：整批通过</button>
            <button class="btn" type="button" @click="submit('未通过')">整批未通过（安排重测）</button>
          </template>
          <button v-else-if="detail.batch.status === '未通过' && !detail.batch.superseded" class="btn primary" type="button" @click="rerun(detail.batch.id)">重跑生成新版本</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  batchDetail,
  buildSectionDiffs,
  createBatch,
  downloadDiff,
  listBatches,
  listSelectableRows,
  rerunBatch,
  sectionKeyOf,
  submitReview,
} from '@/api/crosssection-batch'
import { useSessionStore } from '@/stores/session'
import type { BatchView } from '@/api/crosssection-batch'
import type { EntryRow, SectionDiff } from '@/data/types'

const props = defineProps<{ selectedIds: number[] }>()
const emit = defineEmits<{ changed: [] }>()

const store = useSessionStore()
const pickColumns = ['记录编号', '站点编号', '断面名称', '测量日期', '测量方法', '起点距', '河底高程']
const detailColumns = ['记录编号', '测量日期', '测量方法', '起点距', '河底高程']

const batches = ref<BatchView[]>([])
const creating = ref(false)
const selectable = ref<EntryRow[]>([])
const pickedIds = ref<number[]>([])
const detail = ref<{ batch: BatchView; rows: EntryRow[] } | null>(null)
const diffs = ref<SectionDiff[]>([])
const checker = ref(store.operator)
const remark = ref('')
const detailError = ref('')

const canSubmit = computed(() => detail.value?.batch.status === '待校核' && !detail.value.batch.superseded)

const allPicked = computed(
  () => selectable.value.length > 0 && pickedIds.value.length === selectable.value.length,
)

const recordGroups = computed(() => {
  if (!detail.value) return []
  const map = new Map<string, { key: string; stationNo: string; section: string; rows: EntryRow[] }>()
  for (const row of detail.value.rows) {
    const key = sectionKeyOf(row)
    const [stationNo, section] = key.split('|')
    const group = map.get(key) ?? { key, stationNo, section, rows: [] }
    group.rows.push(row)
    map.set(key, group)
  }
  return [...map.values()]
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) =>
        String(a['测量日期'] ?? '').localeCompare(String(b['测量日期'] ?? '')),
      ),
    }))
    .sort((a, b) => a.stationNo.localeCompare(b.stationNo) || a.section.localeCompare(b.section))
})

function statusClass(status: string): string {
  if (status === '已通过') return 'passed'
  if (status === '未通过') return 'failed'
  if (status === '已作废') return 'void'
  return 'pending'
}

function reload() {
  batches.value = listBatches()
  if (detail.value) openDetail(detail.value.batch.id, true)
}

function toggleAll() {
  pickedIds.value = allPicked.value
    ? []
    : selectable.value.map((row) => Number(row.id))
}

function openCreate() {
  detailError.value = ''
  selectable.value = listSelectableRows()
  // 外部清单勾选的记录作为默认勾选，校核人可在弹窗内增删。
  const valid = new Set(selectable.value.map((row) => Number(row.id)))
  pickedIds.value = props.selectedIds.filter((id) => valid.has(id))
  if (pickedIds.value.length === 0) {
    pickedIds.value = selectable.value.map((row) => Number(row.id))
  }
  creating.value = true
}

function confirmCreate() {
  const result = createBatch(pickedIds.value, store.operator)
  detailError.value = result.ok ? '' : result.message
  if (!result.ok) return
  creating.value = false
  reload()
  emit('changed')
}

function openDetail(id: number, silent = false) {
  const data = batchDetail(id)
  if (!data) {
    if (!silent) detailError.value = '批次不存在或已被重置'
    return
  }
  detail.value = data
  diffs.value = buildSectionDiffs(data.rows)
  checker.value = data.batch.checker || store.operator
  remark.value = data.batch.remark
  detailError.value = ''
}

function submit(value: '通过' | '未通过') {
  if (!detail.value) return
  const result = submitReview(detail.value.batch.id, value, checker.value, remark.value)
  detailError.value = result.ok ? '' : result.message
  if (!result.ok) return
  detail.value = null
  reload()
  emit('changed')
  window.dispatchEvent(new Event('crosscheck:changed'))
}

function rerun(id: number) {
  const result = rerunBatch(id, store.operator)
  detailError.value = result.ok ? '' : result.message
  if (!result.ok) return
  detail.value = null
  reload()
  emit('changed')
  window.dispatchEvent(new Event('crosscheck:changed'))
  if (result.batchId) openDetail(result.batchId)
}

function download(id: number) {
  const result = downloadDiff(id)
  detailError.value = result.ok ? '' : result.message
}

onMounted(reload)
defineExpose({ reload })
</script>
