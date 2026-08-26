/** Set by webpack DefinePlugin. When false, Pro code is stripped at build time. */
declare const DENDRO_INCLUDE_PRO: boolean;

/**
 * Build stamp, set by webpack DefinePlugin at bundle time.
 * Undefined in unbundled (tsc-only, out/) runs — always access via typeof guard.
 * Purpose: lets an agent detect a stale running server after a recompile
 * (new code on disk, old process still serving old tool behavior).
 */
declare const DENDRO_VERSION: string;
declare const DENDRO_GIT_SHA: string;
declare const DENDRO_BUILD_TIME: string;
