import { defineConfig, Plugin } from "vite";
import path from "path";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

/**
 * Plugin to shim Node.js built-in modules that shouldn't run in browser.
 */
const nodeBuiltinsShim = (): Plugin => ({
  name: "node-builtins-shim",
  enforce: "pre",
  resolveId(source) {
    if (source === "fs/promises" || source === "fs" || source === "net" || source === "tty") {
      return `\0virtual:${source}`;
    }
    return null;
  },
  load(id) {
    if (id === "\0virtual:fs/promises") {
      return `
        export const mkdir = () => Promise.reject(new Error('fs/promises not available in browser'));
        export const writeFile = () => Promise.reject(new Error('fs/promises not available in browser'));
        export const readFile = () => Promise.reject(new Error('fs/promises not available in browser'));
        export const rm = () => Promise.reject(new Error('fs/promises not available in browser'));
        export default { mkdir, writeFile, readFile, rm };
      `;
    }
    if (id === "\0virtual:fs") {
      return `
        export const existsSync = () => false;
        export const readFileSync = () => { throw new Error('fs not available in browser'); };
        export const writeFileSync = () => { throw new Error('fs not available in browser'); };
        export const mkdirSync = () => { throw new Error('fs not available in browser'); };
        export default { existsSync, readFileSync, writeFileSync, mkdirSync };
      `;
    }
    if (id === "\0virtual:net") {
      return `
        export const Socket = class Socket { constructor() { throw new Error('net not available in browser'); } };
        export const connect = () => { throw new Error('net not available in browser'); };
        export default { Socket, connect };
      `;
    }
    if (id === "\0virtual:tty") {
      return `
        export const isatty = () => false;
        export default { isatty };
      `;
    }
    return null;
  },
});

export default defineConfig({
  plugins: [
    nodeBuiltinsShim(),
    wasm(),
    topLevelAwait(),
    nodePolyfills({
      include: ["buffer", "crypto", "util", "assert", "process", "stream", "path", "events"],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      exclude: ["fs", "net", "tty"],
      overrides: {
        fs: false,
        net: false,
        tty: false,
      },
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: {
      "@artifacts": path.resolve(__dirname, "../artifacts"),
      crypto: "crypto-browserify",
      stream: "stream-browserify",
      util: "util",
      "pino": "pino/browser.js",
      // Fix CommonJS exports
      "sha3": "sha3/index.js",
      "hash.js": "hash.js/lib/hash.js",
      "lodash.chunk": "lodash.chunk/index.js",
      "lodash.times": "lodash.times/index.js",
      "lodash.isequal": "lodash.isequal/index.js",
      "lodash.pickby": "lodash.pickby/index.js",
      "json-stringify-deterministic": "json-stringify-deterministic/lib/index.js",
    },
    dedupe: ["@aztec/foundation", "@aztec/circuits.js", "@noble/curves"],
  },
  define: {
    global: "globalThis",
  },
  assetsInclude: ["**/*.wasm"],
  server: {
    port: 3000,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy: {
      "/pxe/next-devnet": {
        target: "https://pxe.next.devnet.aztec-labs.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pxe\/next-devnet/, ""),
      },
      "/pxe/devnet": {
        target: "https://pxe.devnet.aztec-labs.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pxe\/devnet/, ""),
      },
    },
  },
  build: {
    target: "esnext",
    sourcemap: false,
    minify: "esbuild",
    chunkSizeWarningLimit: 5000,
    commonjsOptions: {
      defaultIsModuleExports: (id) => {
        if (id.includes("@aztec/")) {
          return false;
        }
        return "auto";
      },
    },
    rollupOptions: {
      onwarn(warning, warn) {
        // Suppress circular dependency and unresolved import warnings for polyfills
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        if (warning.code === 'UNRESOLVED_IMPORT' && warning.exporter?.includes('polyfills')) return;
        warn(warning);
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
      define: {
        global: "globalThis",
      },
    },
    include: [
      "buffer",
      "crypto-browserify",
      "stream-browserify",
      "util",
      "@aztec/bb.js",
    ],
    exclude: [
      "@aztec/pxe",
      "@aztec/pxe/client/lazy",
      "@aztec/foundation",
      "@aztec/circuits.js",
      "@aztec/noir-contracts.js",
    ],
  },
});
