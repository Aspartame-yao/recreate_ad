# Tashan Stone · Ad Recreation Studio

“他山之石”是一款 AI 广告创作工作台，从参考视频拆解、逐镜复刻、视频处理与合成，一直延伸到封面和标题交付。

## 本地运行

```bash
npm ci
npm run build
npm start
```

访问 `http://127.0.0.1:4322/`。

复制 `server/.env.example` 为 `server/.env` 后配置火山方舟与 AI MediaKit 凭证，可启用完整生成能力。真实凭证不会提交到 Git。

项目使用服务端登录鉴权。`APP_LOGIN_USERNAME` 和 `APP_LOGIN_PASSWORD` 用于登录，`AUTH_SECRET` 用于签发 HttpOnly 会话 Cookie。所有模型、任务和媒体 API 都要求有效会话；生产环境缺少鉴权变量时会拒绝服务。

文本、视频理解与拆镜统一使用 Doubao Seed 2.1 Pro；图片与视频生成分别使用 Seedream 5.0 Lite 和 Seedance 2.0 Mini。字幕处理使用 AI MediaKit 字幕擦除标准版，Seedance Mini 已接入同步音轨参数。

## Vercel

项目包含 Vite 前端和位于 `api/` 的 Vercel Function 入口。部署时执行 `npm run build`，静态产物输出到 `dist/`。

火山方舟、AI MediaKit 和鉴权密钥只应保存在 Vercel Environment Variables 或本地已忽略的 `server/.env`，不得写入前端变量或提交到仓库。
