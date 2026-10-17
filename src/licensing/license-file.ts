/**
 * Cross-process license status reader for the MCP server.
 *
 * The MCP server runs as a separate stdio process with no access to VS Code APIs.
 * The extension's LicenseManager writes a signed status file to ~/.dendro/license-status.json
 * and a signing secret to ~/.dendro/.license-secret.
 * This module reads both files and verifies the HMAC-SHA256 signature.
 *
 * Falls back to free tier if files are missing, unreadable, expired, or signature is invalid.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHmac, timingSafeEqual } from 'crypto';
import { LicenseFileStatus } from './types';

const DENDRO_DIR = path.join(os.homedir(), '.dendro');
const LICENSE_FILE_PATH = path.join(DENDRO_DIR, 'license-status.json');
const LICENSE_SECRET_PATH = path.join(DENDRO_DIR, '.license-secret');

export function isProLicensed(): boolean {
  try {
    const secret = fs.readFileSync(LICENSE_SECRET_PATH, 'utf-8').trim();
    if (!secret || secret.length !== 64) return false;

    const raw = fs.readFileSync(LICENSE_FILE_PATH, 'utf-8');
    const status: LicenseFileStatus = JSON.parse(raw);

    if (!status.isPro) return false;
    if (Date.now() > status.cachedUntil) return false;
    if (!status.signature) return false;

    const expected = createHmac('sha256', secret)
      .update(`${status.isPro}:${status.cachedUntil}`)
      .digest('hex');

    if (expected.length !== status.signature.length) return false;

    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(status.signature, 'hex');
    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
