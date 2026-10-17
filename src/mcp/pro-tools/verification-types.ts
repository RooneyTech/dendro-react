/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

// --- Verification Status ---

export type VerificationStatus =
  | 'verified'       // All tests passed — flow confirmed
  | 'failed'         // Assertion failure — flow is broken
  | 'inconclusive'   // Setup error — test issue, not necessarily flow problem
  | 'untested'       // No tests generated yet
  | 'running'        // Currently executing
  | 'partial';       // Mix of verified + other statuses

// --- Hypothesis ---

export interface StateFlowHypothesis {
  /** Unique ID, e.g. "ctx-auth-profile-1", "prop-usercard-avatar-1" */
  id: string;

  /** Which type of flow this hypothesis covers */
  flowType: 'context' | 'prop' | 'hook-state';

  /** What triggers the state change */
  trigger: {
    component: string;    // e.g. "AuthProvider"
    file: string;         // absolute path to source file
    action: string;       // e.g. "setUser" (context), prop name (prop), event handler (hook)
    payload: string;      // test value to inject, e.g. "{ id: 1, name: 'Test User' }"
  };

  /** Expected propagation path through tree */
  expectedPath: string[];  // e.g. ["AuthProvider", "RootNavigator", "ProfileScreen"]

  /** What should happen at the destination */
  expectation: {
    component: string;    // e.g. "ProfileScreen"
    file: string;         // absolute path
    property: string;     // e.g. "user.name" (context), prop name (prop), state var (hook)
    expectedValue: string; // e.g. "'Test User'"
  };

  /** Confidence from static analysis (0.0-1.0) */
  confidence: number;

  /** Explanation of confidence score */
  reasoning: string;

  /** Set after test execution */
  status?: VerificationStatus;
}

// --- Generated Test ---

export interface GeneratedTest {
  hypothesisId: string;
  testCode: string;
  testFilePath: string;    // e.g. __dendro__/tests/flow-ctx-auth-profile-1.test.tsx
  dependencies: string[];  // npm packages needed (e.g. "@testing-library/react-native")
  flowType: 'context' | 'prop' | 'hook-state';
  isTypeScript: boolean;
}

// --- Test Results ---

export type ErrorType = 'assertion' | 'setup' | 'timeout' | 'missing-dep';

export interface FlowTestResult {
  hypothesisId: string;
  status: 'verified' | 'failed' | 'inconclusive';
  errorType?: ErrorType;
  errorMessage?: string;
  duration: number;        // ms
  testFilePath: string;
}

// --- Aggregate State ---

export interface VerificationSummary {
  total: number;
  verified: number;
  failed: number;
  inconclusive: number;
  untested: number;
}

export interface VerificationState {
  hypotheses: StateFlowHypothesis[];
  results: FlowTestResult[];
  lastRunTimestamp: number;
  lastRunDuration: number;
  summary: VerificationSummary;
}

// --- Tool Input/Output Types ---

export interface GenerateHypothesesInput {
  entryFile: string;
  maxHypotheses?: number;
  flowTypes?: ('context' | 'prop' | 'hook-state')[];
}

export interface GenerateHypothesesStats {
  contextsFound: number;
  propsTracked: number;
  hooksAnalyzed: number;
  hypothesesGenerated: number;
  highConfidence: number;   // >= 0.8
  mediumConfidence: number; // 0.6-0.8
  lowConfidence: number;    // < 0.6
}

export interface GenerateHypothesesResult {
  hypotheses: StateFlowHypothesis[];
  stats: GenerateHypothesesStats;
  error?: string;
}

export interface GenerateFlowTestInput {
  hypotheses: StateFlowHypothesis[];
  workspaceRoot: string;
}

export interface GenerateFlowTestResult {
  tests: GeneratedTest[];
  jestConfigPath: string;
  warnings: string[];
  error?: string;
}

export interface RunFlowTestsInput {
  workspaceRoot: string;
  timeout?: number;
  hypothesisIds?: string[];
}

export interface RunFlowTestsResult {
  results: FlowTestResult[];
  summary: VerificationSummary;
  duration: number;
  error?: string;
}

export interface AnnotateVerificationInput {
  entryFile: string;
  results: FlowTestResult[];
  hypotheses: StateFlowHypothesis[];
  clearPrevious?: boolean;
}

export interface AnnotateVerificationResult {
  nodesHighlighted: number;
  flowsColored: number;
  summary: VerificationSummary & { coveragePercent: number };
  error?: string;
}
