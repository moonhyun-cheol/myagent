import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.MY_AGENT_API_PROXY ?? 'http://127.0.0.1:10200';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/profiles': API,
      '/organization-module': API,
      '/health': API,
    },
  },
});
