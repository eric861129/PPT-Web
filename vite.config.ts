import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 相對路徑：同一份產出可以放在 GitHub Pages 的 /PPT-Web/ 底下，也能在本機直接開
  base: './',
  build: {
    rolldownOptions: {
      input: {
        display: resolve(import.meta.dirname, 'index.html'),
        remote: resolve(import.meta.dirname, 'remote.html'),
        audience: resolve(import.meta.dirname, 'audience.html'),
        viewer: resolve(import.meta.dirname, 'view.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
