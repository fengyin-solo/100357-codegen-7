<template>
  <section class="todo-panel">
    <h3>断面校核成果核对（水位整编待办联动）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>核对项</th>
          <th>关联批次</th>
          <th>版本</th>
          <th>站点</th>
          <th>断面</th>
          <th>校核人</th>
          <th>通过时间</th>
          <th>来源</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="todo in todos" :key="todo.id">
          <td>{{ todo.title }}</td>
          <td>{{ todo.batchNo }}</td>
          <td>v{{ todo.version }}</td>
          <td>{{ todo.stationNo }}</td>
          <td>{{ todo.section }}</td>
          <td>{{ todo.checker || '—' }}</td>
          <td>{{ todo.passedAt || '—' }}</td>
          <td><span class="tag" :class="todo.source === 'legacy' ? 'legacy' : 'normal'">{{ todo.source === 'legacy' ? '存量回填' : '批量校核' }}</span></td>
          <td><span class="tag" :class="todo.status === '待核对' ? 'pending' : 'passed'">{{ todo.status }}</span></td>
          <td>
            <button v-if="todo.status === '待核对'" class="link" type="button" @click="confirmTodo(todo.id)">核对确认</button>
            <span v-else class="empty-state">已确认</span>
          </td>
        </tr>
        <tr v-if="!todos.length">
          <td colspan="10" class="empty-state">暂无断面校核成果待核对；断面批次校核通过后会自动按业务批次号在这里立项，重跑不会重复立项。</td>
        </tr>
      </tbody>
    </table>
    <p v-if="message" class="page-foot"><span :class="messageOk ? '' : 'error-text'">{{ message }}</span></p>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { listTodos, resolveTodo } from '@/api/crosssection-batch'
import { useSessionStore } from '@/stores/session'
import type { CrossCheckTodo } from '@/data/types'

const store = useSessionStore()
const todos = ref<CrossCheckTodo[]>([])
const message = ref('')
const messageOk = ref(true)

function reload() {
  todos.value = listTodos()
}

function confirmTodo(id: number) {
  const result = resolveTodo(id, store.operator)
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) {
    reload()
    window.dispatchEvent(new Event('crosscheck:changed'))
  }
}

// 断面页提交批次后会广播该事件，回到本页无需手动刷新即可看到新核对项。
function handleChanged() {
  reload()
}

onMounted(() => {
  reload()
  window.addEventListener('crosscheck:changed', handleChanged)
})
onBeforeUnmount(() => {
  window.removeEventListener('crosscheck:changed', handleChanged)
})
defineExpose({ reload })
</script>
