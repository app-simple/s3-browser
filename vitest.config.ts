import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// main-process logic only; the renderer is exercised by driving the packaged app
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
