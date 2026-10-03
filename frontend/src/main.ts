import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { backfillLegacyBatches } from './api/crosscheck-batch'
import './styles/global.css'

// 存量断面记录按测量日期一次性回填历史批次号（只补号、不改状态，内部带迁移标记）。
backfillLegacyBatches()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
