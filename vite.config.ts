import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const envRoot = process.cwd();
  const env = loadEnv(mode, envRoot, '');
  const apiPort = Number(process.env.PORT ?? env.PORT ?? 3000);
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('PORT 需为1至65535的整数');
  return {
    root: 'web',
    envDir: envRoot,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}`, '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true } } },
    build: { outDir: '../dist/web', emptyOutDir: true },
  };
});
