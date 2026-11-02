import { defineConfig } from 'vitest/config'
// The bridge is its own package; without this file vitest would load the bundle's config one level up.
export default defineConfig({ test: { include: ['tests/**/*.spec.ts'] } })
