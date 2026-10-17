const path = require('path');
const webpack = require('webpack');
const buildStamp = require('./webpack.build-stamp');
const { ParserRuntimePlugin } = require('./scripts/stage-parser-runtime');
const CopyWebpackPlugin = require('copy-webpack-plugin');

/**
 * The VSIX runs dist/ bundles. OXC remains external because its native loader
 * resolves binaries relative to import.meta.url. ParserRuntimePlugin stages its
 * original package plus native/WASI bindings under dist/node_modules.
 * VS Code provides the other external module, vscode.
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
      vscode: 'commonjs vscode', // Provided by the VS Code runtime.
      'oxc-parser': 'commonjs oxc-parser', // Staged under dist/node_modules.
    },
    resolve: {
      extensions: ['.js', '.ts'],
    },
    plugins: [
      new ParserRuntimePlugin(),
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
    externals: { 'oxc-parser': 'commonjs oxc-parser' },
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
