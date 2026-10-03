# 水文监测站网管理系统

面向水文监测站点运行、水位流量雨量数据采集、遥测设备维护与数据整编发布的水文站网管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 监测站点 | `station` | 水文监测站 | 站点编号、站点名称、站点类型 |
| 水位监测 | `waterlevel` | 水位记录 | 记录编号、站点编号、观测时间 |
| 流量监测 | `discharge` | 流量记录 | 记录编号、站点编号、测量方法 |
| 雨量观测 | `rainfall` | 雨量记录 | 记录编号、站点编号、观测时段 |
| 水质检测 | `waterquality` | 水质检测报告 | 报告编号、采样站点、采样时间 |
| 断面测量 | `crosssection` | 断面测量记录 | 记录编号、站点编号、断面名称 |
| 遥测设备 | `telemetry` | 遥测设备 | 设备编号、设备类型、所属站点 |
| 数据整编 | `compilation` | 整编成果 | 成果编号、整编年份、站点编号 |
| 预警阈值 | `warning` | 预警阈值配置 | 配置编号、站点编号、监测类型 |
| 地下水观测 | `groundwater` | 地下水观测记录 | 记录编号、井点编号、观测日期 |
| 蒸发观测 | `evaporation` | 蒸发观测记录 | 记录编号、站点编号、观测日期 |
| 测流缆道 | `cableway` | 测流缆道 | 缆道编号、所属站点、跨度米数 |
| 泥沙监测 | `sediment` | 泥沙监测记录 | 记录编号、站点编号、采样时间 |
| 通讯系统 | `communication` | 通讯设备 | 设备编号、设备类型、所属站点 |
| 站房维护 | `stationhouse` | 站房维护记录 | 记录编号、站点编号、维护类型 |
| 仪器检定 | `calibration` | 仪器检定记录 | 记录编号、仪器编号、仪器名称 |
| 巡检记录 | `inspection` | 巡检记录 | 记录编号、站点编号、巡检日期 |
| 测报方案 | `plan` | 测报方案 | 方案编号、方案名称、适用范围 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `hydrology-monitor-station:entries` 这一项，或调用 `resetModule(模块)`。

## 断面批量校核批次

断面测量支持把多次测量按断面归组、整批校核（领域逻辑在
`frontend/src/api/crosscheck-batch.ts`，批次/待办存于 localStorage 的
`hydrology-monitor-station:extras` 命名空间）：

- **组建批次**：只有「待校核」记录能进入批次，页面按「断面名称」自动归组；同一断面至少
  2 个测次，且河底高程、起点距可解析、多次测量高程较差不超过 ±0.5m，否则该断面判为超差。
- **整体落库**：校核人一次给出「通过 / 需重测」结论。提交前逐断面校验，任一断面失败即整体
  回退（记录状态、批次号、批次对象、待办都不留痕）；全部通过才连续写入并流转记录状态。
- **差异表**：提交结论时随批次生成每断面的测次、高程/起点距序列、高程较差与限差判定，
  可在「批次与版本」里随时下载 CSV。
- **批次重跑（生成新版本，不覆盖）**：重跑保留历史批次结论并标记为「已被新版本替代」，
  新版本复用批次号、版本号递增（`XH-YYYYMM-NNN-V2`），草稿提交时同样走逐断面校验与整体落库。
- **存量回填**：应用启动时执行一次性迁移，按「断面 + 测量年月」给历史记录回填
  `XHBACK-YYYYMM-NN` 批次号，只补号、不改状态，迁移幂等。
- **水位整编核对待办**：批次整体通过后按断面在「水位监测」页生成核对项，以
  「批次号-版本 + 断面」为幂等键；重复提交同一批次、重复通过都不会重复立项。「需重测」不立项。
- 批次号格式为 `XH-YYYYMM-NNN`（当月序号）。

## 验证脚本

```bash
cd frontend
npm run verify:batch   # 断面包批：整体回退 / 幂等立项 / 版本重跑 / 存量回填 的领域逻辑断言
```
