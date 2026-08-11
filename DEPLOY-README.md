# toushi-app 部署备忘（CVM）

## ✅ 当前状态：已部署成功（pm2 管理）
- 访问：`http://miyabcwang-any1.devcloud.woa.com:4322`
- `/api/health` 已验证 HTTP 200，OK，MUSE 真实凭证已生效（非模板）
- 进程管理：**pm2**，进程名 `toushi-app`，代码路径 `~/apps/toushi-app`（root 家目录下）

## 目标机
`miyabcwang-any1.devcloud.woa.com`（root）
**⚠️ SSH 端口不是默认 22，是 `36000`！**（22 端口有准入网关拦截，TCP 握手成功但会被直接断开，连 SSH banner 都不吐——这是之前多次部署失败的根因，务必带 `-p 36000`）

## ⚠️ 历史坑：曾有两套部署互相打架
早期用 `nohup` 把 `/data/toushi-app` 跑在 4322 端口；后来切到 `deploy.sh`（rsync + pm2，路径 `~/apps/toushi-app`）。
两套代码/端口一度同时存在，旧 nohup 进程先绑定 4322，导致新 pm2 进程一直 `errored` 重启却看不出来（外部访问看到的还是旧版本）。
**排错口诀**：外部看到的内容和本地构建不一致时，先 `ss -ltnp | grep 4322` 看真正是谁在监听，别只看 pm2 状态。
现状：已把 `/data/toushi-app` 的旧进程杀掉，统一只保留 `~/apps/toushi-app` + pm2 这一套。

## ⚠️ 历史坑：`.env` 真实凭证只在旧路径 `/data/toushi-app/server/.env`
`deploy.sh` 只有在**本地** `server/.env` 存在时才会同步覆盖远端 `.env`；本地工作区从未有这个文件，
所以每次重新 `./deploy.sh` 都不会动远端已有的 `.env`——但如果远端是"全新的 `~/apps/toushi-app`"（例如换了部署路径），
就会缺 `.env`，服务退回 mock 模式。真实凭证的备份位置：远端 `/data/toushi-app/server/.env`（旧部署遗留）。
若 `~/apps/toushi-app/server/.env` 丢失，用它恢复：
```bash
ssh -p 36000 root@miyabcwang-any1.devcloud.woa.com \
  'cp /data/toushi-app/server/.env ~/apps/toushi-app/server/.env && pm2 restart toushi-app --update-env'
```
更稳妥：把真实 `.env` 也备份一份到本地工作区外的私密位置，避免只有服务器上一份。

## 包内容
- `dist/` — 前端构建产物（Vite build）
- `server/` — Node 原生 http 服务，同端口同时提供 `/api/*` 后端代理 + 静态托管
- `package.json` — 只声明 react/react-dom，运行时无第三方依赖
- `deploy.sh` — rsync + pm2 自动化脚本（已配好 `-p 36000`，`./deploy.sh` 一键跑）

## 一键部署（推荐）
```bash
cd /Users/miyawang/WorkBuddy/2026-07-15-17-15-45/toushi-app
./deploy.sh
```
脚本会自动：`vite build` → rsync 到 `~/apps/toushi-app` → `pm2 restart/start toushi-app` → 健康检查。

## 停 / 重启
```bash
ssh -p 36000 root@miyabcwang-any1.devcloud.woa.com "pm2 restart toushi-app --update-env"
```

## 排错
- `/api/health` 返回 `muse.client: your***` 或 `(未配置)` → `.env` 缺失/是模板，见上面「历史坑」恢复步骤
- 打开首页字体/样式看起来是旧版本 → 先确认没有旧进程抢占端口：`ssh -p 36000 root@... "ss -ltnp | grep 4322"`，
  监听进程的 script path 应该是 `~/apps/toushi-app/server/start.mjs`（而不是 `/data/...`）
- 打开首页空白 → 检查 `dist/index.html` 是否存在、浏览器 Network 里 JS 是否 404
- 端口访问不通 → 服务器上 `curl 127.0.0.1:4322/api/health` 能否通，能通就是外网防火墙/端口白名单问题
- SSH 又连不上 → 先确认用了 `-p 36000`，不是默认 22

## 视频裁剪时长上限
- 裁剪窗口：**3~180 秒**（前端 `src/lib/museApi.ts` 的 `TRIM_MAX_SEC`，后端 `server/start.mjs` 的 `TRIM_MAX_DURATION_SEC`，两处需保持一致）。
- 超过 60s 的裁剪片段，`ffmpegTrim` 会自动降分辨率（长边≤720）+ 限码率，保证反推内联体积不超过 `INLINE_MAX_BYTES`（40MB）。

## 视频反推模型与真实探测
- 整片反推、拆镜策略和单镜反推固定使用 `doubao-seed-2-1-pro-260628`。
- 调用 MUSE OpenAI-compatible 接口：`/llm/v1/chat/completions`。
- 视频通过 `messages[].content[].type=video_url`、`video_url.url=data:video/mp4;base64,...` 承载（豆包 2.1 Pro 已真实验证；误用 image_url 会报 `Invalid base64 image_url`）。
- **不允许回退 Gemini 或其他模型**：遇到 400/403/429/5xx 时，保留豆包真实上游错误，保证结果来源可追溯。
- 健康检查 `/api/health` 应显示 `models.reverse=doubao-seed-2-1-pro-260628`，且不存在 fallback 字段。
- 排障不能只测 `/api/health`：必须真实上传并裁剪一段 5~15s MP4，再依次测试：
  1. `/api/muse/reverse-video`
  2. `/api/muse/breakdown-strategy`
  3. `/api/video/split-segments`
  4. `/api/muse/analyze-shot`
- 如果豆包拒绝 `video_url + data:video/mp4`，记录 HTTP 状态和上游原文；不要通过换模型把失败包装成成功。
