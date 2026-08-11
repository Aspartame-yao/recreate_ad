// 兼容开发入口：统一加载完整生产服务，避免维护两套 API 路由。
// `npm run server` 与 `npm start` 均由 server/start.mjs 提供静态站点和完整 /api/* 能力。
import './start.mjs'
