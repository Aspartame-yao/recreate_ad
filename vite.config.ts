import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 相对 base，便于本地静态服务器 / 沙箱任意路径下预览
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  server: {
    port: 4321,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4322', changeOrigin: true },
    },
  },
})
