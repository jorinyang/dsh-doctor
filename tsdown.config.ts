import type { UserConfig } from 'tsdown'

export default {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: {
    // schemastery stays unbundled because the Loader validates the plugin's
    // Config schema and must see its own schemastery instance; cordis is
    // type-only in this bundle.
    neverBundle: ['@deepseek-ai/schemastery', '@deepseek-ai/cordis'],
  },
} satisfies UserConfig
