/**
 * Shared Pro feature gating utilities.
 * Used by both server.ts (free tools with conditional gating) and pro-registry.ts (pro tools).
 */

/**
 * Returns a Pro-gated upgrade message as valid MCP tool output.
 * Does NOT throw — Claude can relay this gracefully to the user.
 * Currently unreachable (see isGated) but retained for a future paid tier.
 */
export function proFeatureResponse(toolName: string): { content: [{ type: 'text'; text: string }] } {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'pro_feature_required',
        tool: toolName,
        message: `"${toolName}" is a Dendro Pro feature. Upgrade to unlock exports and advanced analysis.`,
        upgradeUrl: 'https://dendro.lemonsqueezy.com',
        freeAlternative: toolName.startsWith('export_')
          ? 'Use get_component_tree for raw analysis data (free).'
          : null
      }, null, 2)
    }]
  };
}

/**
 * Check if a Pro tool should be gated.
 * As of v0.5.1 every tool ships free — gating is dormant. The licensing
 * plumbing (feature registry, license files, VS Code commands) is retained
 * so a paid tier could be re-enabled with:
 *   return isProFeature(toolName) && !isProLicensed();
 */
export function isGated(_toolName: string): boolean {
  return false;
}
