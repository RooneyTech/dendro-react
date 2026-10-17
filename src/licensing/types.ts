export type FeatureTier = 'free' | 'pro';

export interface LicenseStatus {
  isValid: boolean;
  isPro: boolean;
  licenseKey: string | null;
  instanceId: string | null;
  expiresAt: string | null;
  plan: string | null; // 'monthly' | 'annual' | 'lifetime'
  customerEmail: string | null;
  lastValidated: number; // Unix timestamp ms
  cachedUntil: number;   // Unix timestamp ms
}

export interface LicenseFileStatus {
  isPro: boolean;
  cachedUntil: number;
  signature: string;
}

export interface LemonSqueezyActivateResponse {
  activated: boolean;
  valid: boolean;
  error: string | null;
  license_key: {
    id: number;
    status: string;
    key: string;
    activation_limit: number;
    activation_usage: number;
    created_at: string;
    expires_at: string | null;
  };
  instance: {
    id: string;
    name: string;
    created_at: string;
  } | null;
  meta: {
    store_id: number;
    product_id: number;
    product_name: string;
    variant_id: number;
    variant_name: string;
    customer_id: number;
    customer_name: string;
    customer_email: string;
  };
}

export interface LemonSqueezyValidateResponse {
  valid: boolean;
  error: string | null;
  license_key: {
    id: number;
    status: string;
    key: string;
    activation_limit: number;
    activation_usage: number;
    created_at: string;
    expires_at: string | null;
  };
  instance: {
    id: string;
    name: string;
    created_at: string;
  } | null;
  meta: {
    store_id: number;
    product_id: number;
    product_name: string;
    variant_id: number;
    variant_name: string;
    customer_id: number;
    customer_name: string;
    customer_email: string;
  };
}

export interface ActivationResult {
  success: boolean;
  error?: string;
}
