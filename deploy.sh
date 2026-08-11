#!/usr/bin/env bash
# 部署到 CVM: miyabcwang-any1.devcloud.woa.com
# 用法：
#   ./deploy.sh                       # 打包 + rsync + 远端重启（默认 4322 端口）
#   REMOTE=xxx PORT=8080 ./deploy.sh   # 覆写目标机 / 端口
set -euo pipefail

REMOTE="${REMOTE:-miyabcwang-any1.devcloud.woa.com}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-~/apps/toushi-app}"
PORT="${PORT:-4322}"
SSH_PORT="${SSH_PORT:-36000}"
SSH_OPTS="-p $SSH_PORT"
RSYNC_SSH="ssh -p $SSH_PORT"

echo "==> build (TypeScript + Vite)"
npm run build

echo "==> package"
STAGE=$(mktemp -d)
mkdir -p "$STAGE/toushi-app"
cp -R dist server package.json "$STAGE/toushi-app/"
# server/.env 单独处理：若本地没配置，就带一份 .env.example 上去
if [ -f server/.env ]; then
  cp server/.env "$STAGE/toushi-app/server/.env"
fi

echo "==> rsync -> $REMOTE_USER@$REMOTE:$REMOTE_DIR (ssh port $SSH_PORT)"
ssh $SSH_OPTS "$REMOTE_USER@$REMOTE" "mkdir -p $REMOTE_DIR"
# 视频缓存由运行中服务维护（30分钟TTL）；部署不应因 --delete 清空用户刚上传的原片/分镜。
rsync -avz --delete -e "$RSYNC_SSH" \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='dist/uploads/' \
  --exclude='server/data/' \
  "$STAGE/toushi-app/" "$REMOTE_USER@$REMOTE:$REMOTE_DIR/"

# 只有本地存在 .env 时才覆盖远端 .env（首次部署也不要清掉远端的 .env）
if [ -f server/.env ]; then
  rsync -avz -e "$RSYNC_SSH" server/.env "$REMOTE_USER@$REMOTE:$REMOTE_DIR/server/.env"
fi

echo "==> restart on remote (pm2 or nohup)"
ssh $SSH_OPTS "$REMOTE_USER@$REMOTE" bash -s <<REMOTE_SH
set -e
cd $REMOTE_DIR
if command -v pm2 >/dev/null 2>&1; then
  pm2 delete toushi-app 2>/dev/null || true
  PORT=$PORT pm2 start server/start.mjs --name toushi-app --time
  pm2 save 2>/dev/null || true
else
  # 兜底：nohup 后台
  pkill -f 'server/start.mjs' 2>/dev/null || true
  sleep 1
  PORT=$PORT nohup node server/start.mjs > toushi-app.log 2>&1 &
  disown
fi
sleep 2
curl -sf http://127.0.0.1:$PORT/api/health | head -c 400 || echo "health check failed"
echo
REMOTE_SH

echo "==> done. Try: http://$REMOTE:$PORT/"
