const path = require('path');
const webpack = require('webpack');
const buildStamp = require('./webpack.build-stamp');
const TerserPlugin = require('terser-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const terserOptions = {
  minimize: true,
  minimizer: [
    new TerserPlugin({
      terserOptions: {
        compress: {
          drop_console: true,
          drop_debugger: true,
          passes: 2,
        },
        mangle: {
          reserved: ['vscode'],
        },
        format: {
          comments: false,
        },
      },
      extractComments: false,
    }),
  ],
};

module.exports = [
  {
    name: 'extension',
    mode: 'production',
    target: 'node',
    entry: './out/server/extension.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'extension.js',
      libraryTarget: 'commonjs2',
      clean: true
    },
    externals: {
      vscode: 'commonjs vscode',
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
    optimization: terserOptions,
  },
  {
    name: 'webview',
    mode: 'production',
    target: 'web',
    entry: './src/webview/index.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
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
    optimization: terserOptions,
  },
  {
    name: 'mcp-server',
    mode: 'production',
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
    optimization: terserOptions,
  },
];
