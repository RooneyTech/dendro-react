/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import {
  getComponentTree,
  getNavigationStructure,
  getContextMap,
  getComplexityReport,
  getScreenComponents,
  detectCircularDeps,
  GetComponentTreeResult,
  GetNavigationStructureResult,
  GetContextMapResult,
  GetComplexityReportResult,
  GetScreenComponentsResult,
  DetectCircularDepsResult
} from '../tools';

const packageJson = require('../../../package.json');

type AnalysisType = 'tree' | 'navigation' | 'context' | 'complexity' | 'screens';

export type PersonaType = 'developer' | 'ceo' | 'investor' | 'eng-manager' | 'onboarding';

const VALID_ANALYSES: AnalysisType[] = ['tree', 'navigation', 'context', 'complexity', 'screens'];

const VALID_PERSONAS: PersonaType[] = ['developer', 'ceo', 'investor', 'eng-manager', 'onboarding'];

export interface ExportMarkdownResult {
  markdown: string;
  sections: string[];
  persona?: PersonaType;
  error?: string;
}

/** All raw analysis data collected before formatting. */
interface AnalysisData {
  tree?: GetComponentTreeResult;
  navigation?: GetNavigationStructureResult;
  context?: GetContextMapResult;
  complexity?: GetComplexityReportResult;
  screens?: GetScreenComponentsResult;
  circularDeps?: DetectCircularDepsResult;
}

interface ComponentNode {
  file: string;
  type: 'functional' | 'class' | null;
  state: string[];
  directive?: 'use client' | 'use server' | null;
  children: ComponentNode[];
}

/**
 * Render a component tree as indented Markdown lines.
 */
function renderTree(node: ComponentNode, indent = 0, maxDepth?: number): string[] {
  if (maxDepth !== undefined && indent > maxDepth) return [];

  const prefix = '  '.repeat(indent);
  const name = node.file.replace(/\.(jsx?|tsx?)$/, '');
  const badges: string[] = [];

  if (node.type === 'functional') badges.push('`fn`');
  else if (node.type === 'class') badges.push('`class`');

  if (node.state && node.state.length > 0) {
    badges.push(`\`state: ${node.state.join(', ')}\``);
  }
  if (node.directive) {
    badges.push(`\`${node.directive}\``);
  }

  const badgeStr = badges.length > 0 ? ' ' + badges.join(' ') : '';
  const lines: string[] = [`${prefix}- **${name}**${badgeStr}`];

  for (const child of node.children || []) {
    lines.push(...renderTree(child, indent + 1, maxDepth));
  }

  return lines;
}

/**
 * Format the tree analysis section.
 */
function formatTreeSection(result: GetComponentTreeResult, maxDepth?: number): string {
  const lines: string[] = ['## Component Tree', ''];

  if (result.error) {
    lines.push(`> Error: ${result.error}`, '');
    return lines.join('\n');
  }

  if (!result.tree) {
    lines.push('No component tree found.', '');
    return lines.join('\n');
  }

  // Stats table
  lines.push('| Metric | Value |', '|--------|-------|');
  lines.push(`| Total Components | ${result.stats.totalComponents} |`);
  lines.push(`| Functional | ${result.stats.functionalCount} |`);
  lines.push(`| Class | ${result.stats.classCount} |`);
  lines.push(`| Max Depth | ${result.stats.maxDepth} |`);
  lines.push('');

  // Tree
  lines.push('### Hierarchy', '');
  lines.push(...renderTree(result.tree, 0, maxDepth));
  lines.push('');

  return lines.join('\n');
}

/**
 * Format the navigation analysis section.
 */
function formatNavigationSection(result: GetNavigationStructureResult): string {
  const lines: string[] = ['## Navigation Structure', ''];

  if (result.error) {
    lines.push(`> Error: ${result.error}`, '');
    return lines.join('\n');
  }

  lines.push(`**${result.totalNavigators} navigators**, **${result.totalScreens} screens**`, '');

  if (result.formattedTree) {
    lines.push('```');
    lines.push(result.formattedTree);
    lines.push('```', '');
  }

  if (result.screens && result.screens.length > 0) {
    lines.push('### Screens', '');
    lines.push('| Screen | Component | Navigator |', '|--------|-----------|-----------|');
    for (const screen of result.screens) {
      lines.push(`| ${screen.name} | ${screen.componentName || '—'} | ${screen.navigatorName} |`);
    }
    lines.push('');
  }

  if (result.warnings && result.warnings.length > 0) {
    lines.push('### Warnings', '');
    for (const w of result.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format the context map analysis section.
 */
function formatContextSection(result: GetContextMapResult): string {
  const lines: string[] = ['## Context Map', ''];

  if (result.error) {
    lines.push(`> Error: ${result.error}`, '');
    return lines.join('\n');
  }

  lines.push(`**${result.totalContexts} contexts**, **${result.totalConsumers} consumers**`, '');

  if (result.contexts && result.contexts.length > 0) {
    lines.push('### Definitions', '');
    lines.push('| Context | File | Line |', '|---------|------|------|');
    for (const ctx of result.contexts) {
      lines.push(`| ${ctx.name} | ${ctx.filePath} | ${ctx.line} |`);
    }
    lines.push('');
  }

  if (result.consumers && result.consumers.length > 0) {
    lines.push('### Consumers', '');
    lines.push('| Context | File | Component | Hook |', '|---------|------|-----------|------|');
    for (const c of result.consumers) {
      lines.push(`| ${c.contextName} | ${c.filePath} | ${c.componentName || '—'} | ${c.hookName || 'useContext'} |`);
    }
    lines.push('');
  }

  if (result.formattedTree) {
    lines.push('### Hierarchy', '', '```');
    lines.push(result.formattedTree);
    lines.push('```', '');
  }

  return lines.join('\n');
}

/**
 * Format the complexity report section.
 */
function formatComplexitySection(result: GetComplexityReportResult): string {
  const lines: string[] = ['## Complexity Report', ''];

  if (result.error) {
    lines.push(`> Error: ${result.error}`, '');
    return lines.join('\n');
  }

  if (result.summary) {
    lines.push('### Summary', '');
    lines.push('| Metric | Value |', '|--------|-------|');
    lines.push(`| Total Components | ${result.summary.totalComponents} |`);
    lines.push(`| Average Score | ${result.summary.average.toFixed(1)} |`);
    lines.push(`| High Complexity | ${result.summary.high} |`);
    lines.push(`| Medium Complexity | ${result.summary.medium} |`);
    lines.push(`| Low Complexity | ${result.summary.low} |`);
    lines.push('');
  }

  if (result.components && result.components.length > 0) {
    lines.push('### Components', '');
    lines.push('| Component | Score | Lines | JSX Depth | State | Effects |', '|-----------|-------|-------|-----------|-------|---------|');
    // Sort by score descending
    const sorted = [...result.components].sort((a, b) => b.score - a.score);
    for (const comp of sorted) {
      lines.push(
        `| ${comp.componentName || comp.file} | **${comp.score}** | ${comp.metrics.lines} | ${comp.metrics.jsxDepth} | ${comp.metrics.stateCount} | ${comp.metrics.effectCount} |`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format the screens analysis section.
 */
function formatScreensSection(result: GetScreenComponentsResult): string {
  const lines: string[] = ['## Screen Components', ''];

  if (result.error) {
    lines.push(`> Error: ${result.error}`, '');
    return lines.join('\n');
  }

  lines.push(`**${result.totalScreens} screens**`, '');

  if (result.formattedTree) {
    lines.push('```');
    lines.push(result.formattedTree);
    lines.push('```', '');
  }

  return lines.join('\n');
}

// ============================================================================
// Persona-specific formatters
// ============================================================================

/** Compute a health grade letter from a 0-100 score. */
function scoreToGrade(score: number): string {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/** Render a 10-char bar visualization for a 0-100 score. */
function scoreBar(score: number): string {
  const filled = Math.round(score / 10);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
}

/**
 * CEO persona: jargon-free summary, health grade, top risks in business terms.
 */
function formatCeoReport(entryFile: string, data: AnalysisData): string {
  const lines: string[] = [];

  const totalComponents = data.tree?.stats?.totalComponents ?? 0;
  const screenCount = data.navigation?.totalScreens ?? data.screens?.totalScreens ?? 0;
  const circularCount = data.circularDeps?.circularDependencies?.length ?? 0;
  const avgComplexity = data.complexity?.summary?.average ?? 0;
  const highComplexity = data.complexity?.summary?.high ?? 0;

  // Health score: simple heuristic
  let healthScore = 80;
  if (circularCount > 0) healthScore -= Math.min(circularCount * 5, 20);
  if (avgComplexity > 6) healthScore -= 15;
  else if (avgComplexity > 4) healthScore -= 5;
  if (highComplexity > totalComponents * 0.15) healthScore -= 10;
  healthScore = Math.max(0, Math.min(100, healthScore));
  const grade = scoreToGrade(healthScore);

  lines.push('# Architecture Overview');
  lines.push('');
  lines.push(`> Generated by Dendro v${packageJson.version} on ${new Date().toISOString()}`);
  lines.push('');

  // Plain-English summary
  lines.push('## Summary');
  lines.push('');
  if (screenCount > 0) {
    lines.push(`Your application has **${totalComponents} building blocks** organized across **${screenCount} screens**. Think of each building block as a reusable piece of your interface — a button, a form, a navigation bar.`);
  } else {
    lines.push(`Your application has **${totalComponents} building blocks**. Think of each building block as a reusable piece of your interface — a button, a form, a navigation bar.`);
  }
  lines.push('');

  // Health grade
  lines.push(`## Health Grade: ${grade} (${healthScore}/100)`);
  lines.push('');
  if (healthScore >= 85) {
    lines.push('The codebase is well-structured and maintainable. Your engineering team has built a solid foundation.');
  } else if (healthScore >= 70) {
    lines.push('The codebase is in good shape with some areas that could benefit from attention. Nothing urgent, but worth monitoring.');
  } else if (healthScore >= 55) {
    lines.push('The codebase has structural issues that may slow down future development. Consider allocating engineering time to address the risks below.');
  } else {
    lines.push('The codebase has significant structural issues that are likely already slowing development. This should be a priority.');
  }
  lines.push('');

  // Key numbers
  lines.push('## Key Numbers');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Building blocks | ${totalComponents} |`);
  if (screenCount > 0) lines.push(`| Screens | ${screenCount} |`);
  if (data.context) lines.push(`| Data systems | ${data.context.totalContexts} |`);
  if (data.complexity?.summary) lines.push(`| Areas needing attention | ${highComplexity} |`);
  lines.push('');

  // Top risks in business terms
  lines.push('## Top Risks');
  lines.push('');
  const risks: string[] = [];
  if (circularCount > 0) {
    risks.push(`**Tangled dependencies** — ${circularCount} area${circularCount > 1 ? 's' : ''} where parts of the application depend on each other in circles. This makes changes riskier and slower because changing one piece can unexpectedly break another.`);
  }
  if (highComplexity > 0) {
    const sorted = [...(data.complexity?.components ?? [])].sort((a, b) => b.score - a.score);
    const worstName = sorted[0]?.componentName || sorted[0]?.file || 'unknown';
    risks.push(`**Complex areas** — ${highComplexity} building block${highComplexity > 1 ? 's are' : ' is'} significantly more complex than the rest. The most complex is "${worstName}". Complex areas take longer to modify and are more likely to introduce bugs.`);
  }
  if (data.context && data.context.totalContexts > 5) {
    risks.push(`**Many data systems** — Your app uses ${data.context.totalContexts} separate data-sharing systems. While not inherently bad, this adds complexity. Think of each as a company-wide announcement channel — too many channels means important updates can get lost.`);
  }
  if (risks.length === 0) {
    risks.push('No significant risks identified. The codebase appears well-maintained.');
  }
  for (let i = 0; i < Math.min(risks.length, 3); i++) {
    lines.push(`${i + 1}. ${risks[i]}`);
  }
  lines.push('');

  // Recommendation
  lines.push('## Recommendation');
  lines.push('');
  if (circularCount > 0) {
    lines.push('Prioritize resolving the tangled dependencies. These are structural issues that compound over time and make every future change more expensive.');
  } else if (highComplexity > 3) {
    lines.push('Consider breaking down the most complex building blocks into smaller, more focused pieces. This investment will pay off in faster development speed and fewer bugs.');
  } else {
    lines.push('The codebase is in good shape. Continue current engineering practices and monitor complexity as new features are added.');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Investor persona: standardized scorecard with weighted categories.
 */
function formatInvestorReport(entryFile: string, data: AnalysisData): string {
  const lines: string[] = [];

  const totalComponents = data.tree?.stats?.totalComponents ?? 0;
  const functionalCount = data.tree?.stats?.functionalCount ?? 0;
  const classCount = data.tree?.stats?.classCount ?? 0;
  const maxDepth = data.tree?.stats?.maxDepth ?? 0;
  const circularDeps = data.circularDeps?.circularDependencies ?? [];
  const circularCount = circularDeps.length;
  const contextCount = data.context?.totalContexts ?? 0;
  const consumerCount = data.context?.totalConsumers ?? 0;
  const avgComplexity = data.complexity?.summary?.average ?? 0;
  const highComplexity = data.complexity?.summary?.high ?? 0;
  const medComplexity = data.complexity?.summary?.medium ?? 0;
  const lowComplexity = data.complexity?.summary?.low ?? 0;
  const functionalRatio = totalComponents > 0 ? functionalCount / totalComponents : 0;

  // Score each category
  // 1. Architecture Health (25%)
  let archScore = 85;
  if (circularCount > 0) archScore -= Math.min(circularCount * 8, 40);
  if (maxDepth > 15) archScore -= 10;
  if (contextCount > 0 && consumerCount / contextCount > 8) archScore -= 5;
  archScore = Math.max(0, Math.min(100, archScore));

  // 2. Component Complexity (20%)
  let complexityScore = 90;
  if (totalComponents > 0) {
    const criticalRatio = highComplexity / totalComponents;
    if (criticalRatio > 0.15) complexityScore -= 30;
    else if (criticalRatio > 0.1) complexityScore -= 20;
    else if (criticalRatio > 0.05) complexityScore -= 10;
  }
  if (avgComplexity > 6) complexityScore -= 15;
  else if (avgComplexity > 4) complexityScore -= 5;
  complexityScore = Math.max(0, Math.min(100, complexityScore));

  // 3. Data Flow Clarity (15%)
  let dataFlowScore = 80;
  if (contextCount > 8) dataFlowScore -= 15;
  if (contextCount > 0 && consumerCount / contextCount > 10) dataFlowScore -= 10;
  dataFlowScore = Math.max(0, Math.min(100, dataFlowScore));

  // 4. Codebase Modernization (10%)
  let modernScore = Math.round(functionalRatio * 100);
  modernScore = Math.max(0, Math.min(100, modernScore));

  // 5. Structural Debt (15%)
  let debtScore = 85;
  const refactorCandidates = highComplexity + medComplexity;
  if (refactorCandidates > totalComponents * 0.2) debtScore -= 25;
  else if (refactorCandidates > totalComponents * 0.1) debtScore -= 10;
  if (circularCount > 0) debtScore -= Math.min(circularCount * 5, 20);
  debtScore = Math.max(0, Math.min(100, debtScore));

  // 6. Engineering Discipline (15%) — limited data without snapshots
  const disciplineScore = 70; // baseline without snapshot data

  // Weighted overall
  const overall = Math.round(
    archScore * 0.25 +
    complexityScore * 0.20 +
    dataFlowScore * 0.15 +
    modernScore * 0.10 +
    debtScore * 0.15 +
    disciplineScore * 0.15
  );
  const overallGrade = scoreToGrade(overall);

  lines.push('# Dendro Investor Scorecard v1.0');
  lines.push('');
  lines.push(`> Generated by Dendro v${packageJson.version} on ${new Date().toISOString()}`);
  lines.push(`> Entry: \`${entryFile}\``);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push(`## Overall Grade: ${overallGrade} (${overall}/100)`);
  lines.push('');

  // Category scores
  lines.push('## Category Scores');
  lines.push('');
  lines.push('```');
  lines.push(`  Architecture Health ............ ${archScore}/100  [${scoreToGrade(archScore)}]  ${scoreBar(archScore)}`);
  if (circularCount === 0) {
    lines.push(`    0 circular deps \u2713 | Depth: ${maxDepth} | ${contextCount} providers, ${consumerCount} consumers`);
  } else {
    lines.push(`    ${circularCount} circular dep${circularCount > 1 ? 's' : ''} \u2717 | Depth: ${maxDepth} | ${contextCount} providers, ${consumerCount} consumers`);
  }
  lines.push('');

  lines.push(`  Component Complexity ........... ${complexityScore}/100  [${scoreToGrade(complexityScore)}]  ${scoreBar(complexityScore)}`);
  lines.push(`    ${totalComponents} total | ${lowComplexity} healthy (${totalComponents > 0 ? Math.round(lowComplexity / totalComponents * 100) : 0}%) | ${highComplexity} critical (${totalComponents > 0 ? Math.round(highComplexity / totalComponents * 100) : 0}%)`);
  if (data.complexity?.components) {
    const sorted = [...data.complexity.components].sort((a, b) => b.score - a.score);
    const worst = sorted.slice(0, 2).map(c => `${c.componentName || c.file} (${c.score})`).join(', ');
    if (worst) lines.push(`    Worst: ${worst}`);
  }
  lines.push('');

  lines.push(`  Data Flow Clarity .............. ${dataFlowScore}/100  [${scoreToGrade(dataFlowScore)}]  ${scoreBar(dataFlowScore)}`);
  lines.push(`    ${contextCount} contexts, ${consumerCount} consumers`);
  lines.push('');

  lines.push(`  Codebase Modernization ......... ${modernScore}/100  [${scoreToGrade(modernScore)}]  ${scoreBar(modernScore)}`);
  lines.push(`    ${Math.round(functionalRatio * 100)}% functional | ${classCount} class component${classCount !== 1 ? 's' : ''} remaining`);
  lines.push('');

  lines.push(`  Structural Debt ................ ${debtScore}/100  [${scoreToGrade(debtScore)}]  ${scoreBar(debtScore)}`);
  lines.push(`    ${refactorCandidates} refactor candidate${refactorCandidates !== 1 ? 's' : ''} | ${circularCount} circular dep${circularCount !== 1 ? 's' : ''}`);
  lines.push('');

  lines.push(`  Engineering Discipline ......... ${disciplineScore}/100  [${scoreToGrade(disciplineScore)}]  ${scoreBar(disciplineScore)}`);
  lines.push(`    Baseline score (use save_snapshot for trend tracking)`);
  lines.push('');

  lines.push(`  Test Coverage:      NOT AVAILABLE`);
  lines.push(`  Security Posture:   NOT AVAILABLE`);
  lines.push(`  Dependency Health:  NOT AVAILABLE`);
  lines.push(`  Bus Factor:         NOT AVAILABLE`);
  lines.push('```');
  lines.push('');

  // Red flags
  lines.push('## Red Flags');
  lines.push('');
  const redFlags: string[] = [];
  if (circularCount > 0) redFlags.push(`${circularCount} circular dependencies detected — indicates tight coupling`);
  if (highComplexity > totalComponents * 0.1) redFlags.push(`${highComplexity} high-complexity components (${totalComponents > 0 ? Math.round(highComplexity / totalComponents * 100) : 0}% of codebase) — increases bug risk and slows feature delivery`);
  if (classCount > totalComponents * 0.2) redFlags.push(`${classCount} class components remaining — outdated patterns increase maintenance cost`);
  if (avgComplexity > 5) redFlags.push(`Average complexity ${avgComplexity.toFixed(1)} — above recommended threshold of 5.0`);
  if (redFlags.length === 0) redFlags.push('No significant red flags identified');
  for (const flag of redFlags) lines.push(`- ${flag}`);
  lines.push('');

  // Green flags
  lines.push('## Green Flags');
  lines.push('');
  const greenFlags: string[] = [];
  if (circularCount === 0) greenFlags.push('Zero circular dependencies — clean architectural boundaries');
  if (functionalRatio >= 0.9) greenFlags.push(`${Math.round(functionalRatio * 100)}% functional components — modern React patterns`);
  if (avgComplexity <= 4) greenFlags.push(`Low average complexity (${avgComplexity.toFixed(1)}) — codebase is maintainable`);
  if (totalComponents > 20 && highComplexity <= 2) greenFlags.push('Minimal high-complexity components — well-factored code');
  if (greenFlags.length === 0) greenFlags.push('See category scores above for strengths');
  for (const flag of greenFlags) lines.push(`- ${flag}`);
  lines.push('');

  // Recommendations
  lines.push('## Recommendations');
  lines.push('');
  const recs: string[] = [];
  if (circularCount > 0) recs.push('Resolve circular dependencies to improve modularity and testability');
  if (highComplexity > 0) {
    const sorted = [...(data.complexity?.components ?? [])].sort((a, b) => b.score - a.score);
    const top3 = sorted.slice(0, 3).map(c => c.componentName || c.file).join(', ');
    recs.push(`Break down high-complexity components (start with: ${top3})`);
  }
  if (classCount > 0) recs.push(`Migrate ${classCount} class component${classCount > 1 ? 's' : ''} to functional components with hooks`);
  recs.push('Establish snapshot tracking with save_snapshot for complexity trend monitoring');
  recs.push('Add test coverage analysis when available for a complete health picture');
  for (let i = 0; i < Math.min(recs.length, 5); i++) {
    lines.push(`${i + 1}. ${recs[i]}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Engineering Manager persona: concise sprint health check.
 */
function formatEngManagerReport(entryFile: string, data: AnalysisData): string {
  const lines: string[] = [];

  const totalComponents = data.tree?.stats?.totalComponents ?? 0;
  const circularCount = data.circularDeps?.circularDependencies?.length ?? 0;
  const highComplexity = data.complexity?.summary?.high ?? 0;
  const avgComplexity = data.complexity?.summary?.average ?? 0;
  const classCount = data.tree?.stats?.classCount ?? 0;
  const functionalCount = data.tree?.stats?.functionalCount ?? 0;

  // Health indicator
  let health: 'GREEN' | 'YELLOW' | 'RED' = 'GREEN';
  let healthReason = 'Codebase is in good shape.';
  if (circularCount > 3 || highComplexity > totalComponents * 0.15 || avgComplexity > 6) {
    health = 'RED';
    healthReason = 'Structural issues need attention this sprint.';
  } else if (circularCount > 0 || highComplexity > totalComponents * 0.05 || avgComplexity > 4.5) {
    health = 'YELLOW';
    healthReason = 'Minor issues worth monitoring.';
  }

  lines.push('# Sprint Health Check');
  lines.push('');
  lines.push(`> Generated by Dendro v${packageJson.version} on ${new Date().toISOString()}`);
  lines.push('');

  lines.push(`**Health: ${health}** — ${healthReason}`);
  lines.push('');

  // Components above threshold 5
  const aboveThreshold = (data.complexity?.components ?? []).filter(c => c.score >= 5);
  lines.push(`**Components above threshold 5:** ${aboveThreshold.length}`);
  if (aboveThreshold.length > 0) {
    const sorted = [...aboveThreshold].sort((a, b) => b.score - a.score);
    const names = sorted.slice(0, 5).map(c => `${c.componentName || c.file} (${c.score})`).join(', ');
    lines.push(`  ${names}${sorted.length > 5 ? ` (+${sorted.length - 5} more)` : ''}`);
  }
  lines.push('');

  // Circular deps
  lines.push(`**Circular dependencies:** ${circularCount}`);
  if (circularCount > 0) {
    for (const dep of data.circularDeps!.circularDependencies.slice(0, 3)) {
      lines.push(`  - ${dep.description}`);
    }
  }
  lines.push('');

  // Complexity trend — without snapshots, report current state
  lines.push(`**Average complexity:** ${avgComplexity.toFixed(1)}${avgComplexity > 5 ? ' (above target)' : ''}`);
  lines.push('');

  // Class components
  lines.push(`**Class components remaining:** ${classCount}${classCount > 0 ? ` (${totalComponents > 0 ? Math.round(classCount / totalComponents * 100) : 0}% of codebase)` : ''}`);
  lines.push('');

  // Recommendation
  lines.push('**Recommended action:**');
  if (circularCount > 0) {
    lines.push(`Resolve ${circularCount} circular dependenc${circularCount > 1 ? 'ies' : 'y'} — these create hidden coupling that makes changes unpredictable.`);
  } else if (highComplexity > 0) {
    const worst = [...(data.complexity?.components ?? [])].sort((a, b) => b.score - a.score)[0];
    lines.push(`Refactor ${worst?.componentName || worst?.file || 'highest-complexity component'} (score: ${worst?.score ?? '?'}) — break into smaller, focused components.`);
  } else if (classCount > 0) {
    lines.push(`Migrate ${classCount} class component${classCount > 1 ? 's' : ''} to functional — reduces cognitive load and aligns with modern React patterns.`);
  } else {
    lines.push('No blockers. Continue current velocity.');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Onboarding persona: progressive walkthrough for new team members.
 */
function formatOnboardingReport(entryFile: string, data: AnalysisData): string {
  const lines: string[] = [];

  const totalComponents = data.tree?.stats?.totalComponents ?? 0;
  const screenCount = data.navigation?.totalScreens ?? data.screens?.totalScreens ?? 0;

  lines.push('# Codebase Onboarding Guide');
  lines.push('');
  lines.push(`> Generated by Dendro v${packageJson.version} on ${new Date().toISOString()}`);
  lines.push('');

  // Step 1: What is this app?
  lines.push('## 1. What Is This App?');
  lines.push('');
  if (screenCount > 0) {
    lines.push(`This application is built with React and has **${totalComponents} components** organized across **${screenCount} screens**.`);
  } else {
    lines.push(`This application is built with React and has **${totalComponents} components**.`);
  }
  if (data.tree?.stats) {
    const { functionalCount, classCount } = data.tree.stats;
    const ratio = totalComponents > 0 ? Math.round(functionalCount / totalComponents * 100) : 0;
    lines.push(`The codebase uses ${ratio}% functional components${classCount > 0 ? ` (${classCount} class components remaining)` : ''}.`);
  }
  lines.push('');

  // Step 2: Navigation structure
  if (data.navigation && !data.navigation.error) {
    lines.push('## 2. How Is the App Organized?');
    lines.push('');
    lines.push(`The app uses **${data.navigation.totalNavigators} navigator${data.navigation.totalNavigators !== 1 ? 's' : ''}** to organize its screens.`);
    lines.push('');
    if (data.navigation.formattedTree) {
      lines.push('```');
      lines.push(data.navigation.formattedTree);
      lines.push('```');
      lines.push('');
    }
    if (data.navigation.screens && data.navigation.screens.length > 0) {
      lines.push('**Screens you should know:**');
      lines.push('');
      for (const screen of data.navigation.screens) {
        lines.push(`- **${screen.name}** — component: \`${screen.componentName || 'unknown'}\` (in ${screen.navigatorName})`);
      }
      lines.push('');
    }
  }

  // Step 3: Data flow
  if (data.context && !data.context.error && data.context.totalContexts > 0) {
    lines.push('## 3. How Does Data Flow?');
    lines.push('');
    lines.push(`The app uses **${data.context.totalContexts} Context provider${data.context.totalContexts !== 1 ? 's' : ''}** to share data across components. Think of each Context as a shared data channel that multiple components can read from.`);
    lines.push('');
    if (data.context.contexts && data.context.contexts.length > 0) {
      lines.push('**Key data providers:**');
      lines.push('');
      for (const ctx of data.context.contexts) {
        const consumers = (data.context.consumers ?? []).filter(c => c.contextName === ctx.name);
        lines.push(`- **${ctx.name}** (${ctx.filePath}) — used by ${consumers.length} component${consumers.length !== 1 ? 's' : ''}`);
      }
      lines.push('');
      // Highlight the most-used context
      const contextUsage = (data.context.contexts ?? []).map(ctx => ({
        name: ctx.name,
        count: (data.context!.consumers ?? []).filter(c => c.contextName === ctx.name).length
      })).sort((a, b) => b.count - a.count);
      if (contextUsage.length > 0 && contextUsage[0].count > 0) {
        lines.push(`> **Most important:** ${contextUsage[0].name} is the most widely used context (${contextUsage[0].count} consumers). Start here when learning the data flow.`);
        lines.push('');
      }
    }
  }

  // Step 4: Complex areas
  if (data.complexity && !data.complexity.error) {
    const complex = (data.complexity.components ?? []).filter(c => c.score >= 5).sort((a, b) => b.score - a.score);
    lines.push('## 4. Complex Areas to Know About');
    lines.push('');
    if (complex.length === 0) {
      lines.push('Good news — no components have complexity scores above 5. The codebase is well-factored and approachable.');
    } else {
      lines.push(`There are **${complex.length} components** with above-average complexity. These are the areas you should understand first before making changes:`);
      lines.push('');
      for (const comp of complex.slice(0, 8)) {
        lines.push(`- **${comp.componentName || comp.file}** (score: ${comp.score}) — ${comp.metrics.lines} lines, ${comp.metrics.stateCount} state variables, ${comp.metrics.effectCount} effects`);
      }
      if (complex.length > 8) lines.push(`- ...and ${complex.length - 8} more`);
    }
    lines.push('');
  }

  // Step 5: Watch out for
  const circularCount = data.circularDeps?.circularDependencies?.length ?? 0;
  if (circularCount > 0) {
    lines.push('## 5. Things to Watch Out For');
    lines.push('');
    lines.push(`There are **${circularCount} circular dependencies** in the codebase. These are areas where components depend on each other in a loop, which can cause unexpected behavior:`);
    lines.push('');
    for (const dep of data.circularDeps!.circularDependencies.slice(0, 5)) {
      lines.push(`- ${dep.description}`);
      if (dep.recommendation) lines.push(`  - Fix: ${dep.recommendation}`);
    }
    lines.push('');
  }

  // Tips
  lines.push('## Getting Started Tips');
  lines.push('');
  lines.push('1. Start by running the app and exploring each screen');
  if (data.context && data.context.totalContexts > 0) {
    lines.push('2. Read the Context providers to understand the data model');
  }
  lines.push(`${data.context && data.context.totalContexts > 0 ? '3' : '2'}. Use Dendro\'s \`open_visualizer\` to see the component tree visually`);
  lines.push(`${data.context && data.context.totalContexts > 0 ? '4' : '3'}. When modifying a component, use \`get_used_by\` to understand its impact radius`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Collect all analysis data needed for persona-specific reports.
 * Runs additional tools (circular deps, component types) beyond the standard set.
 */
function collectAnalysisData(
  entryFile: string,
  selectedAnalyses: AnalysisType[],
  maxDepth: number | undefined,
  errors: string[]
): { data: AnalysisData; sections: string[] } {
  const data: AnalysisData = {};
  const sections: string[] = [];

  // Run standard analyses
  if (selectedAnalyses.includes('tree')) {
    try {
      data.tree = getComponentTree(entryFile, maxDepth);
      sections.push('tree');
      if (data.tree.error) errors.push(`tree: ${data.tree.error}`);
    } catch (err) {
      errors.push(`tree: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (selectedAnalyses.includes('navigation')) {
    try {
      data.navigation = getNavigationStructure(entryFile);
      sections.push('navigation');
      if (data.navigation.error) errors.push(`navigation: ${data.navigation.error}`);
    } catch (err) {
      errors.push(`navigation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (selectedAnalyses.includes('context')) {
    try {
      data.context = getContextMap(entryFile);
      sections.push('context');
      if (data.context.error) errors.push(`context: ${data.context.error}`);
    } catch (err) {
      errors.push(`context: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (selectedAnalyses.includes('complexity')) {
    try {
      data.complexity = getComplexityReport(entryFile);
      sections.push('complexity');
      if (data.complexity.error) errors.push(`complexity: ${data.complexity.error}`);
    } catch (err) {
      errors.push(`complexity: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (selectedAnalyses.includes('screens')) {
    try {
      data.screens = getScreenComponents(entryFile);
      sections.push('screens');
      if (data.screens.error) errors.push(`screens: ${data.screens.error}`);
    } catch (err) {
      errors.push(`screens: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Always run circular deps and component types for persona reports
  try {
    data.circularDeps = detectCircularDeps(entryFile);
  } catch (err) {
    // Non-fatal — persona formatters handle missing data
  }

  return { data, sections };
}

/** Default analyses per persona when none are explicitly specified. */
const PERSONA_DEFAULT_ANALYSES: Record<PersonaType, AnalysisType[]> = {
  developer: ['tree'],
  ceo: ['tree', 'complexity', 'context', 'navigation', 'screens'],
  investor: ['tree', 'complexity', 'context', 'navigation', 'screens'],
  'eng-manager': ['tree', 'complexity'],
  onboarding: ['tree', 'navigation', 'context', 'complexity', 'screens'],
};

/**
 * Export a comprehensive Markdown report combining multiple Dendro analyses.
 * Supports persona-specific formatting for different audiences.
 *
 * @param entryFile - Path to the root component file
 * @param optionsOrAnalyses - Array of analysis names, or options object with analyses, maxDepth, persona
 * @returns ExportMarkdownResult with the Markdown string and section list
 */
export function exportMarkdown(
  entryFile: string,
  optionsOrAnalyses?: string[] | { analyses?: string[]; maxDepth?: number; persona?: string }
): ExportMarkdownResult {
  let rawAnalyses: string[] | undefined;
  let maxDepth: number | undefined;
  let persona: PersonaType = 'developer';

  if (Array.isArray(optionsOrAnalyses)) {
    rawAnalyses = optionsOrAnalyses;
  } else if (optionsOrAnalyses && typeof optionsOrAnalyses === 'object') {
    rawAnalyses = optionsOrAnalyses.analyses;
    maxDepth = optionsOrAnalyses.maxDepth;
    if (optionsOrAnalyses.persona && VALID_PERSONAS.includes(optionsOrAnalyses.persona as PersonaType)) {
      persona = optionsOrAnalyses.persona as PersonaType;
    }
  }

  // Determine which analyses to run
  let selectedAnalyses: AnalysisType[] = [];
  if (rawAnalyses && rawAnalyses.length > 0) {
    for (const a of rawAnalyses) {
      if (VALID_ANALYSES.includes(a as AnalysisType)) {
        selectedAnalyses.push(a as AnalysisType);
      }
    }
  }
  // If no analyses specified, use persona defaults
  if (selectedAnalyses.length === 0) {
    selectedAnalyses = [...PERSONA_DEFAULT_ANALYSES[persona]];
  }

  const errors: string[] = [];

  // Developer persona: use original section-by-section format
  if (persona === 'developer') {
    const sections: string[] = [];
    const markdownParts: string[] = [];

    markdownParts.push(`# Dendro Analysis Report`);
    markdownParts.push('');
    markdownParts.push(`> Generated by Dendro v${packageJson.version} on ${new Date().toISOString()}`);
    markdownParts.push(`> Entry: \`${entryFile}\``);
    markdownParts.push('');
    markdownParts.push('---');
    markdownParts.push('');

    if (selectedAnalyses.includes('tree')) {
      try {
        const result = getComponentTree(entryFile, maxDepth);
        markdownParts.push(formatTreeSection(result, maxDepth));
        sections.push('tree');
        if (result.error) errors.push(`tree: ${result.error}`);
      } catch (err) {
        errors.push(`tree: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (selectedAnalyses.includes('navigation')) {
      try {
        const result = getNavigationStructure(entryFile);
        markdownParts.push(formatNavigationSection(result));
        sections.push('navigation');
        if (result.error) errors.push(`navigation: ${result.error}`);
      } catch (err) {
        errors.push(`navigation: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (selectedAnalyses.includes('context')) {
      try {
        const result = getContextMap(entryFile);
        markdownParts.push(formatContextSection(result));
        sections.push('context');
        if (result.error) errors.push(`context: ${result.error}`);
      } catch (err) {
        errors.push(`context: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (selectedAnalyses.includes('complexity')) {
      try {
        const result = getComplexityReport(entryFile);
        markdownParts.push(formatComplexitySection(result));
        sections.push('complexity');
        if (result.error) errors.push(`complexity: ${result.error}`);
      } catch (err) {
        errors.push(`complexity: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (selectedAnalyses.includes('screens')) {
      try {
        const result = getScreenComponents(entryFile);
        markdownParts.push(formatScreensSection(result));
        sections.push('screens');
        if (result.error) errors.push(`screens: ${result.error}`);
      } catch (err) {
        errors.push(`screens: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const result: ExportMarkdownResult = {
      markdown: markdownParts.join('\n'),
      sections,
    };
    if (errors.length > 0) result.error = errors.join('; ');
    return result;
  }

  // Persona-specific reports: collect all data, then format holistically
  const { data, sections } = collectAnalysisData(entryFile, selectedAnalyses, maxDepth, errors);

  let markdown: string;
  switch (persona) {
    case 'ceo':
      markdown = formatCeoReport(entryFile, data);
      break;
    case 'investor':
      markdown = formatInvestorReport(entryFile, data);
      break;
    case 'eng-manager':
      markdown = formatEngManagerReport(entryFile, data);
      break;
    case 'onboarding':
      markdown = formatOnboardingReport(entryFile, data);
      break;
    default:
      markdown = '';
  }

  const result: ExportMarkdownResult = { markdown, sections, persona };
  if (errors.length > 0) result.error = errors.join('; ');
  return result;
}

export const exportToMarkdown = exportMarkdown;
