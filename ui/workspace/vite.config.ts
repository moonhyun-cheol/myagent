import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const MY_AGENT_API = process.env.MY_AGENT_API_PROXY ?? process.env.MY_AGENT_API_PROXY ?? 'http://127.0.0.1:10200';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/chat': MY_AGENT_API,
      '/sessions': MY_AGENT_API,
      '/models': MY_AGENT_API,
      '/license': MY_AGENT_API,
      '/config': MY_AGENT_API,
      '/providers': MY_AGENT_API,
      '/attachments': MY_AGENT_API,
      '/skills': MY_AGENT_API,
      '/generate': MY_AGENT_API,
      '/outputs': MY_AGENT_API,
      '/admin': MY_AGENT_API,
      '/error-report': MY_AGENT_API,
      '/fs': MY_AGENT_API,
      '/workspace': MY_AGENT_API,
      '/projects': MY_AGENT_API,
    },
  },
});
