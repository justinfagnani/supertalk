/**
 * Rollup configuration for checking bundle size.
 * Run with: npm run checksize
 *
 * This bundles the library and reports:
 * - Original size
 * - Minified size
 * - Gzipped size
 * - Brotli size
 */

import {nodeResolve} from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import summary from 'rollup-plugin-summary';

export default {
  input: 'index.js',
  output: {
    file: '.checksize/index.js',
    format: 'es',
  },
  plugins: [
    nodeResolve(),
    terser({
      ecma: 2024,
      module: true,
      compress: {
        passes: 2,
        pure_getters: true,
      },
    }),
    summary({
      showMinifiedSize: true,
      showGzippedSize: true,
      showBrotliSize: true,
    }),
  ],
};
