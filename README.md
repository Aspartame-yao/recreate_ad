# Tashan Stone · Ad Recreation Studio

“他山之石”是一款 AI 广告创作工作台，从参考视频拆解、逐镜复刻、视频处理与合成，一直延伸到封面和标题交付。

## 本地运行

```bash
npm ci
npm run build
npm start
```

访问 `http://127.0.0.1:4322/`。

复制 `server/.env.example` 为 `server/.env` 后配置服务凭证，可启用完整生成能力。真实凭证不会提交到 Git。

## Vercel

项目包含 Vite 前端和位于 `api/` 的 Vercel Function 入口。部署时执行 `npm run build`，静态产物输出到 `dist/`。
