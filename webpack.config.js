const path = require('path');
const webpack = require('webpack');
const buildStamp = require('./webpack.build-stamp');
const CopyWebpackPlugin = require('copy-webpack-plugin');

/**
 * WEBPACK BUNDLING ARCHITECTURE
 *
 * CRITICAL: The vsix package uses dist/ (bundled), NOT out/ (unbundled).
 *
 * Why this matters:
 * - VS Code extension vsix files do NOT include node_modules/
 * - out/server/extension.js has `require('oxc-parser')` which will FAIL in vsix
 * - dist/extension.js bundles all dependencies inline (~150KB)
 *
 * Build flow:
 * 1. TypeScript compiles to out/
 * 2. Webpack bundles out/ → dist/ (with dependencies)
 * 3. vsix includes dist/ only (see .vscodeignore)
 * 4. package.json "main" points to dist/extension.js
 *
 * If "command not found" error: Check that package.json main is "./dist/extension.js"
 * If webview blank: Check extension.ts uses 'dist/webview.js' not 'out/webview/webview.js'
 *
 * See .dev/HANDOFF.md "Extension Packaging Architecture" for full troubleshooting.
 */

module.exports = [
  {
    name: 'extension',
    mode: 'development',
    devtool: 'source-map',
    target: 'node',
    entry: './out/server/extension.js',  // Input: unbundled TypeScript output
    output: {
      path: path.resolve(__dirname, 'dist'),  // Output: bundled for vsix
      filename: 'extension.js',
      libraryTarget: 'commonjs2',
      clean: true
    },
    externals: {
      vscode: 'commonjs vscode',  // vscode is provided by VS Code runtime
    },
    resolve: {
      extensions: ['.js', '.ts'],
    },
    plugins: [
      new webpack.DefinePlugin({
        DENDRO_INCLUDE_PRO: JSON.stringify(true),
        ...buildStamp,
      }),
    ],
  },
  {
    name: 'webview',
    mode: 'development',
    // Webpack's development default is devtool: 'eval', which the webview's
    // nonce-based CSP silently blocks (blank panel, no error in the Extension
    // Host console). Must stay a non-eval devtool.
    devtool: 'source-map',
    target: 'web',
    entry: './src/webview/index.js',
    output: {
      path: path.resolve(__dirname, 'dist'),  // Must match localResourceRoots in extension.ts
      filename: 'webview.js',
      clean: false
    },
    resolve: {
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    },
    module: {
      rules: [
        {
          test: /\.(js|jsx)$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: ['@babel/preset-env', '@babel/preset-react'],
            },
          },
        },
      ],
    },
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: 'src/webview/fonts', to: 'fonts' },
        ],
      }),
    ],
  },
  {
    name: 'mcp-server',
    mode: 'development',
    devtool: 'source-map',
    target: 'node',
    entry: './out/mcp/index.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'mcp-server.js',
      libraryTarget: 'commonjs2',
      clean: false
    },
    resolve: {
      extensions: ['.js', '.ts'],
    },
    plugins: [
      new webpack.BannerPlugin({
        banner: '#!/usr/bin/env node',
        raw: true,
      }),
      new webpack.DefinePlugin({
        DENDRO_INCLUDE_PRO: JSON.stringify(true),
        ...buildStamp,
      }),
    ],
  },
];
