import { FeatureTier } from './types';

/**
 * Feature registry: maps feature IDs to their tier.
 *
 * Convention:
 * - MCP tool names used directly (e.g., 'get_component_tree')
 * - Extension-only features use 'ext.' prefix (e.g., 'ext.save_analysis_config')
 */
const FEATURE_REGISTRY: Record<string, FeatureTier> = {
  // MCP Analysis Tools — FREE
  'get_component_tree': 'free',
  'get_component_details': 'free',
  'get_component_contract': 'free',
  'get_modified_components': 'free',
  'run_workflow': 'free',
  'detect_circular_deps': 'free',
  'get_used_by': 'free',
  'get_prop_flow': 'free',
  'get_hook_deps': 'free',
  'get_navigation_structure': 'free',
  'get_context_map': 'free',
  'get_screen_components': 'free',
  'get_complexity_report': 'free',
  'get_rerender_risks': 'free',

  // Runtime Tools — FREE
  'get_runtime_status': 'free',
  'get_live_tree': 'free',
  'get_runtime_state': 'free',

  // Visualization Tools — FREE
  'open_visualizer': 'free',
  'visualize_batch': 'free',
  // 'start_tour': 'free',  // shelved — .dev/bugs/TOUR-BUG-REPORT.md

  // Agent Orientation — FREE
  'get_usage_guide': 'free',
  'submit_feedback': 'free',
  'get_context_pack': 'free',
  'get_usage_stats': 'free',

  // Composite Agent Tools — FREE (TICKET-042)
  'analyze_codebase': 'free',
  'quick_audit': 'free',
  'visualize_analysis': 'free',

  // Workflow Tools — FREE (TICKET-055)

  // Export Tools — PRO

  // Pro Analysis Tools
  'export_analysis': 'pro',
  'manage_snapshots': 'pro',
  'verify_state_flows': 'pro',
  'batch_analysis': 'pro',

  // Verified Projection Tools (Paradigm 2)

  // Triggered Projection (Paradigm 3)
  'trigger_projection': 'pro',

  // Live Introspection (Paradigm 4)
  'inspect_live_component': 'pro',
  'find_state_owner': 'pro',

  // State Modification (Paradigm 4 Phase 4)
  'modify_runtime_state': 'pro',

  // Live Prop Tracing + Navigation (Paradigm 4 Phase 4B)
  'trace_live_prop': 'pro',
  'get_live_navigation': 'pro',
};

export function getFeatureTier(featureId: string): FeatureTier {
  return FEATURE_REGISTRY[featureId] || 'free';
}

export function isProFeature(featureId: string): boolean {
  return getFeatureTier(featureId) === 'pro';
}

export function getProFeatureList(): string[] {
  return Object.entries(FEATURE_REGISTRY)
    .filter(([_, tier]) => tier === 'pro')
    .map(([id]) => id);
}

export function getFreeFeatureList(): string[] {
  return Object.entries(FEATURE_REGISTRY)
    .filter(([_, tier]) => tier === 'free')
    .map(([id]) => id);
}
