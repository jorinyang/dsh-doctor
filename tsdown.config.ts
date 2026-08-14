import type { UserConfig } from 'tsdown'

// Library entry: keep external deps unbundled
const libConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: {
    neverBundle: ['@deepseek-ai/schemastery', '@deepseek-ai/cordis'],
  },
} satisfies UserConfig

// CLI entry: single self-contained file (all deps inlined)
const cliConfig = {
  entry: { 'cli.bundle': 'src/cli.ts' },
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  clean: false,
} satisfies UserConfig

export default [libConfig, cliConfig]
