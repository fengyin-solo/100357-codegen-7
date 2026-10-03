import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { backfillLegacyBatches } from './api/crosssection-batch'
import './styles/global.css'

// 存量断面记录按测量日期一次性回填校核批次号，回填过就不再重复执行。
backfillLegacyBatches()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
