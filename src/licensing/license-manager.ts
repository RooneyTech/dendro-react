import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHmac, randomBytes } from 'crypto';
import { LicenseStatus, LicenseFileStatus, ActivationResult } from './types';

const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;  // 24 hours
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LS_API_BASE = 'https://api.lemonsqueezy.com/v1/licenses';
const LICENSE_FILE_DIR = path.join(os.homedir(), '.dendro');
const LICENSE_FILE_PATH = path.join(LICENSE_FILE_DIR, 'license-status.json');
const LICENSE_SECRET_PATH = path.join(LICENSE_FILE_DIR, '.license-secret');
const SECRET_STORAGE_KEY = 'dendro-license-secret';

// TODO: Replace with actual Lemon Squeezy product URL after account creation
const CHECKOUT_URL = 'https://dendro.lemonsqueezy.com/checkout/buy/PRODUCT_ID';
const PORTAL_URL = 'https://dendro.lemonsqueezy.com/billing';

export class LicenseManager {
  private status: LicenseStatus;
  private secretStorage: vscode.SecretStorage;
  private statusChangeEmitter: vscode.EventEmitter<LicenseStatus>;
  public readonly onStatusChange: vscode.Event<LicenseStatus>;

  constructor(context: vscode.ExtensionContext) {
    this.secretStorage = context.secrets;
    this.statusChangeEmitter = new vscode.EventEmitter<LicenseStatus>();
    this.onStatusChange = this.statusChangeEmitter.event;
    this.status = this.getDefaultStatus();
  }

  async initialize(): Promise<void> {
    const cached = await this.secretStorage.get('dendro-license-status');
    if (cached) {
      try {
        this.status = JSON.parse(cached);
        if (Date.now() < this.status.cachedUntil) {
          this.fireStatusChange();
          return;
        }
        // Cache expired — try revalidation
        if (this.status.licenseKey && this.status.instanceId) {
          await this.validate(this.status.licenseKey, this.status.instanceId);
          return;
        }
      } catch {
        this.status = this.getDefaultStatus();
      }
    }
    this.fireStatusChange();
  }

  async activate(licenseKey: string): Promise<ActivationResult> {
    const instanceName = `vscode-${vscode.env.machineId}`;

    try {
      const response = await fetch(`${LS_API_BASE}/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          license_key: licenseKey,
          instance_name: instanceName
        })
      });

      const data = await response.json();

      if (data.activated || data.valid) {
        this.status = {
          isValid: true,
          isPro: true,
          licenseKey,
          instanceId: data.instance?.id || null,
          expiresAt: data.license_key?.expires_at || null,
          plan: data.meta?.variant_name || null,
          customerEmail: data.meta?.customer_email || null,
          lastValidated: Date.now(),
          cachedUntil: Date.now() + CACHE_DURATION_MS
        };
        await this.persistStatus();
        this.fireStatusChange();
        return { success: true };
      }

      return { success: false, error: data.error || 'Activation failed' };
    } catch (err) {
      return {
        success: false,
        error: `Network error: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  async validate(licenseKey: string, instanceId: string): Promise<boolean> {
    try {
      const response = await fetch(`${LS_API_BASE}/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          license_key: licenseKey,
          instance_id: instanceId
        })
      });

      const data = await response.json();

      this.status = {
        isValid: data.valid,
        isPro: data.valid,
        licenseKey,
        instanceId,
        expiresAt: data.license_key?.expires_at || null,
        plan: data.meta?.variant_name || null,
        customerEmail: data.meta?.customer_email || null,
        lastValidated: Date.now(),
        cachedUntil: Date.now() + CACHE_DURATION_MS
      };

      await this.persistStatus();
      this.fireStatusChange();
      return data.valid;
    } catch {
      // Network failure — use grace period
      if (this.status.isPro && this.isWithinGracePeriod()) {
        return true;
      }
      return false;
    }
  }

  isProUnlocked(): boolean {
    if (!this.status.isPro) return false;
    if (Date.now() < this.status.cachedUntil) return true;
    if (this.isWithinGracePeriod()) return true;
    return false;
  }

  getStatus(): Readonly<LicenseStatus> {
    return { ...this.status };
  }

  async deactivate(): Promise<void> {
    if (this.status.licenseKey && this.status.instanceId) {
      try {
        await fetch(`${LS_API_BASE}/deactivate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            license_key: this.status.licenseKey,
            instance_id: this.status.instanceId
          })
        });
      } catch {
        // Best-effort deactivation
      }
    }
    this.status = this.getDefaultStatus();
    await this.persistStatus();
    this.fireStatusChange();
    this.deleteLicenseFiles();
  }

  getCheckoutUrl(): string {
    if (this.status.customerEmail) {
      return `${CHECKOUT_URL}?checkout[email]=${encodeURIComponent(this.status.customerEmail)}`;
    }
    return CHECKOUT_URL;
  }

  getPortalUrl(): string {
    return PORTAL_URL;
  }

  dispose(): void {
    this.statusChangeEmitter.dispose();
  }

  // --- Private ---

  private isWithinGracePeriod(): boolean {
    const timeSinceValidation = Date.now() - this.status.lastValidated;
    return timeSinceValidation < GRACE_PERIOD_MS;
  }

  private async persistStatus(): Promise<void> {
    // Persist to VS Code SecretStorage (encrypted)
    await this.secretStorage.store(
      'dendro-license-status',
      JSON.stringify(this.status)
    );

    // Also write signed cross-process license file for MCP server
    await this.writeLicenseFile();
  }

  private async writeLicenseFile(): Promise<void> {
    try {
      const secret = await this.ensureSecret();
      fs.mkdirSync(LICENSE_FILE_DIR, { recursive: true });
      const fileStatus: LicenseFileStatus = {
        isPro: this.status.isPro,
        cachedUntil: this.status.cachedUntil,
        signature: this.signPayload(this.status.isPro, this.status.cachedUntil, secret),
      };
      fs.writeFileSync(LICENSE_FILE_PATH, JSON.stringify(fileStatus), 'utf-8');
    } catch {
      // Non-critical — MCP gating degrades to free tier
    }
  }

  private fireStatusChange(): void {
    this.statusChangeEmitter.fire(this.status);
    // Ensure license file is in sync on every status change
    this.writeLicenseFile().catch(() => {});
  }

  private async ensureSecret(): Promise<string> {
    // Check SecretStorage first (source of truth)
    let secret = await this.secretStorage.get(SECRET_STORAGE_KEY);
    if (secret) {
      this.writeSecretFile(secret);
      return secret;
    }

    // Check file (might exist from prior session)
    try {
      const fileSecret = fs.readFileSync(LICENSE_SECRET_PATH, 'utf-8').trim();
      if (fileSecret.length === 64) {
        await this.secretStorage.store(SECRET_STORAGE_KEY, fileSecret);
        return fileSecret;
      }
    } catch {
      // File doesn't exist or is unreadable
    }

    // Generate new secret
    const newSecret = randomBytes(32).toString('hex');
    await this.secretStorage.store(SECRET_STORAGE_KEY, newSecret);
    this.writeSecretFile(newSecret);
    return newSecret;
  }

  private writeSecretFile(secret: string): void {
    try {
      fs.mkdirSync(LICENSE_FILE_DIR, { recursive: true });
      fs.writeFileSync(LICENSE_SECRET_PATH, secret, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      // Non-critical — MCP will fall back to free tier
    }
  }

  private signPayload(isPro: boolean, cachedUntil: number, secret: string): string {
    return createHmac('sha256', secret).update(`${isPro}:${cachedUntil}`).digest('hex');
  }

  private deleteLicenseFiles(): void {
    try { fs.unlinkSync(LICENSE_FILE_PATH); } catch { /* ok */ }
    try { fs.unlinkSync(LICENSE_SECRET_PATH); } catch { /* ok */ }
  }

  private getDefaultStatus(): LicenseStatus {
    return {
      isValid: false,
      isPro: false,
      licenseKey: null,
      instanceId: null,
      expiresAt: null,
      plan: null,
      customerEmail: null,
      lastValidated: 0,
      cachedUntil: 0
    };
  }
}
