#!/usr/bin/env node
/**
 * P0 Theme Audit Verification Tests
 *
 * Validates all P0 changes from the design audit implementation plan:
 *   P0-1: prefers-reduced-motion support (Dendrogram + DendriteLoader)
 *   P0-2: Idle animation reduction + large-tree threshold
 *   P0-3: Flow dash pattern differentiation
 *   P0-4: AppHeader pill shape icons
 *   P0-5: Text truncation 12→16
 *
 * Run: node scripts/test-p0-theme-audit.js
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
let sectionPassed = 0;
let sectionFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2705 ${name}`);
    passed++;
    sectionPassed++;
  } catch (e) {
    console.log(`  \u274c ${name}: ${e.message}`);
    failed++;
    sectionFailed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function section(name) {
  sectionPassed = 0;
  sectionFailed = 0;
  console.log(`\n\u{1F9EA} ${name}`);
}

function sectionSummary() {
  const total = sectionPassed + sectionFailed;
  console.log(`  \u2192 ${sectionPassed}/${total} passed`);
}

// Load source files
const projectRoot = path.resolve(__dirname, '..');
const dendrogramSrc = fs.readFileSync(path.join(projectRoot, 'src/webview/Dendrogram.jsx'), 'utf-8');
const loaderSrc = fs.readFileSync(path.join(projectRoot, 'src/webview/DendriteLoader.jsx'), 'utf-8');
const headerSrc = fs.readFileSync(path.join(projectRoot, 'src/webview/AppHeader.jsx'), 'utf-8');
const tokensSrc = fs.readFileSync(path.join(projectRoot, 'src/webview/tokens.js'), 'utf-8');

// Extracted files from Session 70 refactor
const renderFlowsSrc = fs.readFileSync(path.join(projectRoot, 'src/webview/layers/renderFlows.js'), 'utf-8');
const vizCommandsSrc = fs.readFileSync(path.join(projectRoot, 'src/webview/hooks/useVisualizationCommands.js'), 'utf-8');

// Combined source for tests that just need to find a pattern somewhere in the webview codebase
const allWebviewSrc = dendrogramSrc + '\n' + renderFlowsSrc + '\n' + vizCommandsSrc;

// Also check compiled output exists
const distDir = path.join(projectRoot, 'dist');
const webviewBundle = path.join(distDir, 'webview.js');

// ============================================================
// 1. P0-1: prefers-reduced-motion — Dendrogram.jsx
// ============================================================

section('P0-1a: prefers-reduced-motion — Dendrogram.jsx');

test('CSS @media (prefers-reduced-motion: reduce) block exists', () => {
  assert(
    dendrogramSrc.includes('@media (prefers-reduced-motion: reduce)'),
    'Missing @media (prefers-reduced-motion: reduce) in Dendrogram.jsx'
  );
});

test('Reduced-motion kills .node-soma animation', () => {
  // Inside the media query block, .node-soma should have animation: none
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(mediaBlock, 'Could not find reduced-motion media block');
  assert(
    mediaBlock.includes('.node-soma') && mediaBlock.includes('animation: none !important'),
    '.node-soma not killed in reduced-motion block'
  );
});

test('Reduced-motion kills .node-nucleus animation', () => {
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.node-nucleus'),
    '.node-nucleus not in reduced-motion kill list'
  );
});

test('Reduced-motion kills .node-membrane animation', () => {
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.node-membrane'),
    '.node-membrane not in reduced-motion kill list'
  );
});

test('Reduced-motion kills .neurotransmitter animation', () => {
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.neurotransmitter'),
    '.neurotransmitter not in reduced-motion kill list'
  );
});

test('Reduced-motion kills .action-potential-particle animation', () => {
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.action-potential-particle'),
    '.action-potential-particle not in reduced-motion kill list'
  );
});

test('Reduced-motion kills .flow-path.flow-animated animation', () => {
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.flow-path.flow-animated'),
    '.flow-path.flow-animated not in reduced-motion kill list'
  );
});

test('Reduced-motion kills .live-badge animation', () => {
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.live-badge'),
    '.live-badge not in reduced-motion kill list'
  );
});

test('Reduced-motion kills .calcium-wave and .calcium-receptor', () => {
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.calcium-wave') && mediaBlock.includes('.calcium-receptor'),
    'Calcium wave elements not in reduced-motion kill list'
  );
});

test('Calcium wave/receptor hidden with display: none', () => {
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('display: none'),
    'Calcium wave elements not hidden via display: none in reduced-motion'
  );
});

test('Reduced-motion kills transitions on nodes/links/text', () => {
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('transition: none !important'),
    'Transitions not killed in reduced-motion block'
  );
  assert(
    mediaBlock.includes('.node .node-rect') && mediaBlock.includes('.link'),
    '.node .node-rect and .link not in transition kill list'
  );
});

test('Neurogenesis keeps structure but disables animation', () => {
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.node.neurogenesis'),
    'Neurogenesis not addressed in reduced-motion block'
  );
});

test('Static opacity fallbacks in reduced-motion', () => {
  const mediaBlock = dendrogramSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  // Check for static opacity values
  assert(
    mediaBlock.includes('.node-soma { opacity:') || mediaBlock.includes('.node-soma { opacity:'),
    'Missing static opacity for .node-soma in reduced-motion'
  );
});

test('JS: prefersReducedMotion variable declared', () => {
  assert(
    dendrogramSrc.includes("window.matchMedia('(prefers-reduced-motion: reduce)').matches"),
    'Missing prefersReducedMotion JS check'
  );
});

test('JS: SMIL particle creation gated by !prefersReducedMotion', () => {
  // Particle rendering was extracted to src/webview/layers/renderFlows.js
  assert(
    renderFlowsSrc.includes('!prefersReducedMotion'),
    'Missing !prefersReducedMotion gate on SMIL particles'
  );
  // Specifically on the animateMotion particle creation line
  const particleLine = renderFlowsSrc.split('\n').find(l =>
    l.includes('flow.animated') && l.includes('NODE_STYLE') && l.includes('prefersReducedMotion')
  );
  assert(particleLine, 'SMIL particle creation not gated by prefersReducedMotion');
});

test('JS: Calcium wave gated by !prefersReducedMotion', () => {
  // Calcium wave rendering was extracted to src/webview/layers/renderFlows.js
  const calciumLine = renderFlowsSrc.split('\n').find(l =>
    l.includes("flow.flowType === 'context'") && l.includes('prefersReducedMotion')
  );
  assert(calciumLine, 'Calcium wave rendering not gated by prefersReducedMotion');
});

test('v1 limitation documented in code comment', () => {
  assert(
    dendrogramSrc.includes('v1 limitation'),
    'Missing v1 limitation comment about reduced-motion toggle behavior'
  );
});

test('Live badge animation moved to CSS class (not inline)', () => {
  // The liveBadgeStyle object should NOT contain animation property
  const liveBadgeStyleBlock = dendrogramSrc.split('const liveBadgeStyle')[1]?.split('};')[0];
  assert(liveBadgeStyleBlock, 'Could not find liveBadgeStyle block');
  assert(
    !liveBadgeStyleBlock.includes('animation:'),
    'liveBadgeStyle still has inline animation — should be in CSS .live-badge class'
  );
});

test('Live badge <span> has className="live-badge"', () => {
  assert(
    dendrogramSrc.includes('className="live-badge"'),
    'Live badge span missing className="live-badge"'
  );
});

test('.live-badge CSS class exists with animation', () => {
  // Outside the media query
  const cssSection = dendrogramSrc.split('`}</style>')[0];
  assert(
    cssSection.includes('.live-badge {') && cssSection.includes('live-pulse'),
    '.live-badge CSS class missing or not using live-pulse animation'
  );
});

sectionSummary();

// ============================================================
// 2. P0-1: prefers-reduced-motion — DendriteLoader.jsx
// ============================================================

section('P0-1b: prefers-reduced-motion — DendriteLoader.jsx');

test('CSS @media (prefers-reduced-motion: reduce) block exists', () => {
  assert(
    loaderSrc.includes('@media (prefers-reduced-motion: reduce)'),
    'Missing @media (prefers-reduced-motion: reduce) in DendriteLoader.jsx'
  );
});

test('Reduced-motion kills .soma animation', () => {
  const mediaBlock = loaderSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.soma') && mediaBlock.includes('animation: none !important'),
    '.soma not killed in DendriteLoader reduced-motion block'
  );
});

test('Reduced-motion kills .dendrite animation', () => {
  const mediaBlock = loaderSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.dendrite'),
    '.dendrite not in DendriteLoader reduced-motion kill list'
  );
});

test('Reduced-motion kills .dendrite::before and ::after', () => {
  const mediaBlock = loaderSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.dendrite::before') || mediaBlock.includes("dendrite::before"),
    '.dendrite::before not in DendriteLoader reduced-motion kill list'
  );
});

test('Reduced-motion kills .particle animation', () => {
  const mediaBlock = loaderSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.particle'),
    '.particle not in DendriteLoader reduced-motion kill list'
  );
});

test('Reduced-motion kills .signal-ring animation', () => {
  const mediaBlock = loaderSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.signal-ring'),
    '.signal-ring not in DendriteLoader reduced-motion kill list'
  );
});

test('Reduced-motion kills .loader-text animation', () => {
  const mediaBlock = loaderSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.loader-text'),
    '.loader-text not in DendriteLoader reduced-motion kill list'
  );
});

test('Reduced-motion kills .ambient-glow animation', () => {
  const mediaBlock = loaderSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  assert(
    mediaBlock.includes('.ambient-glow'),
    '.ambient-glow not in DendriteLoader reduced-motion kill list'
  );
});

test('Static opacity fallbacks so loader remains visible', () => {
  const mediaBlock = loaderSrc.split('@media (prefers-reduced-motion: reduce)')[1];
  // Should set static opacity values
  assert(
    mediaBlock.includes('.soma { opacity:'),
    'Missing static opacity for .soma in reduced-motion'
  );
  assert(
    mediaBlock.includes('.dendrite { opacity:'),
    'Missing static opacity for .dendrite in reduced-motion'
  );
  assert(
    mediaBlock.includes('.loader-text { opacity:'),
    'Missing static opacity for .loader-text in reduced-motion'
  );
});

sectionSummary();

// ============================================================
// 3. P0-2: Idle Animation Reduction
// ============================================================

section('P0-2: Idle Animation Reduction');

test('.node-soma RETAINS resting-potential animation (brand signature)', () => {
  // The .node-soma CSS rule should still have animation: resting-potential
  const somaRule = dendrogramSrc.match(/\.node-soma\s*\{[^}]*\}/);
  assert(somaRule, 'Could not find .node-soma CSS rule');
  assert(
    somaRule[0].includes('resting-potential'),
    '.node-soma lost its resting-potential animation — this is the brand signature!'
  );
});

test('.node-nucleus no longer has idle animation', () => {
  // Find the .node-nucleus CSS rule (not in media query)
  const lines = dendrogramSrc.split('\n');
  let inMediaQuery = false;
  let nucleusHasAnimation = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('@media (prefers-reduced-motion')) inMediaQuery = true;
    if (inMediaQuery && lines[i].includes('`}</style>')) inMediaQuery = false;
    if (!inMediaQuery && lines[i].includes('.node-nucleus {')) {
      // Check next few lines for animation property
      const nextLines = lines.slice(i, i + 5).join('\n');
      if (nextLines.includes('animation:') && nextLines.includes('nucleus-pulse')) {
        nucleusHasAnimation = true;
      }
    }
  }
  assert(!nucleusHasAnimation, '.node-nucleus still has idle nucleus-pulse animation');
});

test('.node-nucleus has static opacity: 0.9', () => {
  const nucleusMatch = dendrogramSrc.match(/\.node-nucleus\s*\{[^}]*opacity:\s*0\.9/);
  assert(nucleusMatch, '.node-nucleus missing static opacity: 0.9');
});

test('.node-membrane no longer has idle animation', () => {
  // Find the .node-membrane rule outside media queries
  const beforeMedia = dendrogramSrc.split('@media (prefers-reduced-motion')[0];
  const membraneRule = beforeMedia.match(/\.node-membrane\s*\{[^}]*\}/g);
  if (membraneRule) {
    const hasIdleAnimation = membraneRule.some(r =>
      r.includes('animation:') && r.includes('membrane-breathe')
    );
    assert(!hasIdleAnimation, '.node-membrane still has idle membrane-breathe animation');
  }
});

test('.neurotransmitter no longer has idle animation', () => {
  const beforeMedia = dendrogramSrc.split('@media (prefers-reduced-motion')[0];
  const ntRule = beforeMedia.match(/\.neurotransmitter\s*\{[^}]*\}/g);
  if (ntRule) {
    const hasIdleAnimation = ntRule.some(r =>
      r.includes('animation:') && r.includes('neurotransmitter-drift')
    );
    assert(!hasIdleAnimation, '.neurotransmitter still has idle neurotransmitter-drift animation');
  }
});

test('@keyframes nucleus-pulse still defined (for future triggered use)', () => {
  assert(
    dendrogramSrc.includes('@keyframes nucleus-pulse'),
    '@keyframes nucleus-pulse was deleted — should be kept for future triggered animations'
  );
});

test('@keyframes membrane-breathe still defined', () => {
  assert(
    dendrogramSrc.includes('@keyframes membrane-breathe'),
    '@keyframes membrane-breathe was deleted — should be kept for future triggered animations'
  );
});

test('@keyframes neurotransmitter-drift still defined', () => {
  assert(
    dendrogramSrc.includes('@keyframes neurotransmitter-drift'),
    '@keyframes neurotransmitter-drift was deleted — should be kept for future triggered animations'
  );
});

test('Large-tree CSS: .large-tree .node-soma kills animation', () => {
  assert(
    dendrogramSrc.includes('.large-tree .node-soma'),
    'Missing .large-tree .node-soma CSS rule'
  );
  assert(
    dendrogramSrc.includes('.large-tree .node-soma { animation: none !important; }') ||
    dendrogramSrc.includes(".large-tree .node-soma { animation: none !important; }"),
    '.large-tree .node-soma rule does not kill animation'
  );
});

test('JS: svg.classed("large-tree", nodes.length > 50)', () => {
  assert(
    dendrogramSrc.includes('svg.classed("large-tree"') ||
    dendrogramSrc.includes("svg.classed('large-tree'"),
    'Missing svg.classed("large-tree") call in update()'
  );
  assert(
    dendrogramSrc.includes('nodes.length > 50'),
    'Large-tree threshold not set to 50 nodes'
  );
});

test('Animation count estimate: only soma per node (max ~50)', () => {
  // Verify nucleus/membrane/neurotransmitter don't have idle animation
  // and soma is the only per-node idle animation remaining
  const beforeMedia = dendrogramSrc.split('@media (prefers-reduced-motion')[0];

  // Count CSS rules that apply per-node idle animations
  const perNodeAnimations = [];
  if (/\.node-soma\s*\{[^}]*animation:\s*resting-potential/.test(beforeMedia)) {
    perNodeAnimations.push('soma');
  }
  if (/\.node-nucleus\s*\{[^}]*animation:\s*nucleus-pulse/.test(beforeMedia)) {
    perNodeAnimations.push('nucleus');
  }
  if (/\.node-membrane\s*\{[^}]*animation:\s*membrane-breathe/.test(beforeMedia)) {
    perNodeAnimations.push('membrane');
  }
  if (/\.neurotransmitter\s*\{[^}]*animation:\s*neurotransmitter-drift/.test(beforeMedia)) {
    perNodeAnimations.push('neurotransmitter');
  }

  assert(
    perNodeAnimations.length === 1 && perNodeAnimations[0] === 'soma',
    `Expected only soma idle animation, found: [${perNodeAnimations.join(', ')}]`
  );
});

sectionSummary();

// ============================================================
// 4. P0-3: Flow Dash Pattern Differentiation
// ============================================================

section('P0-3: Flow Dash Pattern Differentiation');

test('FLOW_TYPE_PATTERNS constant exists', () => {
  // Extracted to src/webview/layers/renderFlows.js
  assert(
    renderFlowsSrc.includes('FLOW_TYPE_PATTERNS'),
    'Missing FLOW_TYPE_PATTERNS constant'
  );
});

test('FLOW_TYPE_PATTERNS has prop: solid (none)', () => {
  assert(
    renderFlowsSrc.includes("prop: 'none'"),
    "FLOW_TYPE_PATTERNS missing prop: 'none'"
  );
});

test('FLOW_TYPE_PATTERNS has context: dashed (12, 6)', () => {
  assert(
    renderFlowsSrc.includes("context: '12, 6'"),
    "FLOW_TYPE_PATTERNS missing context: '12, 6'"
  );
});

test('FLOW_TYPE_PATTERNS has hook-state: dotted (3, 4)', () => {
  assert(
    renderFlowsSrc.includes("'hook-state': '3, 4'"),
    "FLOW_TYPE_PATTERNS missing 'hook-state': '3, 4'"
  );
});

test('FLOW_TYPE_PATTERNS has hook: dotted (3, 4)', () => {
  assert(
    renderFlowsSrc.includes("hook: '3, 4'"),
    "FLOW_TYPE_PATTERNS missing hook: '3, 4'"
  );
});

test('Flow path uses dashPattern from FLOW_TYPE_PATTERNS', () => {
  assert(
    renderFlowsSrc.includes('FLOW_TYPE_PATTERNS[flow.flowType]'),
    'Flow path not reading from FLOW_TYPE_PATTERNS'
  );
});

test('Flow path applies stroke-dasharray inline', () => {
  assert(
    dendrogramSrc.includes("style(\"stroke-dasharray\"") ||
    dendrogramSrc.includes("style('stroke-dasharray'"),
    'Flow path not applying stroke-dasharray inline'
  );
});

test('CSS class renamed: .flow-path.animated → .flow-path.flow-animated', () => {
  // Should NOT have .flow-path.animated (old)
  // Should have .flow-path.flow-animated (new)
  const cssBlock = dendrogramSrc.split('`}</style>')[0];
  assert(
    !cssBlock.includes('.flow-path.animated {') && !cssBlock.includes('.flow-path.animated{'),
    'Old .flow-path.animated CSS class still exists — should be .flow-path.flow-animated'
  );
  assert(
    cssBlock.includes('.flow-path.flow-animated'),
    'Missing .flow-path.flow-animated CSS class'
  );
});

test('JS uses flow-animated class (not animated)', () => {
  assert(
    dendrogramSrc.includes('flow-animated'),
    'JS not using flow-animated class name'
  );
  // Ensure old 'animated' class is not used in flow path rendering
  const flowSection = dendrogramSrc.split('// Flow path with ID')[1]?.split('// Action potential')[0] || '';
  assert(
    !flowSection.includes("' animated'") && !flowSection.includes('" animated"'),
    'Flow path still uses old animated class instead of flow-animated'
  );
});

test('.flow-path.flow-animated does NOT set stroke-dasharray in CSS', () => {
  // stroke-dasharray is now set inline per flow type, not in CSS
  const flowAnimRule = dendrogramSrc.match(/\.flow-path\.flow-animated\s*\{[^}]*\}/);
  assert(flowAnimRule, 'Could not find .flow-path.flow-animated CSS rule');
  assert(
    !flowAnimRule[0].includes('stroke-dasharray'),
    '.flow-path.flow-animated still sets stroke-dasharray in CSS — should be inline only'
  );
});

test('Dotted anti-strobe: .flow-dotted has animation-duration: 2s', () => {
  assert(
    dendrogramSrc.includes('.flow-dotted'),
    'Missing .flow-dotted CSS class'
  );
  assert(
    dendrogramSrc.includes('animation-duration: 2s'),
    '.flow-dotted missing animation-duration: 2s for strobe prevention'
  );
});

test('JS applies .flow-dotted class for dotted patterns', () => {
  // Extracted to src/webview/layers/renderFlows.js
  assert(
    renderFlowsSrc.includes("isDotted") && renderFlowsSrc.includes("flow-dotted"),
    'JS not applying .flow-dotted class based on isDotted'
  );
});

test('Animated solid flows (prop) use 16,4 dash for animation', () => {
  // Extracted to src/webview/layers/renderFlows.js
  assert(
    renderFlowsSrc.includes("'16, 4'") || renderFlowsSrc.includes('"16, 4"'),
    'Animated solid flows not using 16,4 dash pattern for flow-dash keyframe'
  );
});

sectionSummary();

// ============================================================
// 5. P0-4: AppHeader Pill Shape Icons
// ============================================================

section('P0-4: AppHeader Pill Shape Icons');

test('Functional pill has f() marker', () => {
  assert(
    headerSrc.includes('f()'),
    'Functional pill missing f() marker'
  );
});

test('Functional f() uses monospace font', () => {
  // The f() span should have fontFamily: monospace
  const fMarkerIdx = headerSrc.indexOf('f()');
  const surroundingBlock = headerSrc.substring(Math.max(0, fMarkerIdx - 200), fMarkerIdx + 10);
  assert(
    surroundingBlock.includes('monospace'),
    'Functional f() marker not using monospace font'
  );
});

test('Class pill has ◆ (filled diamond) marker', () => {
  assert(
    headerSrc.includes('\\u25C6') || headerSrc.includes('\u25C6'),
    'Class pill missing ◆ (\\u25C6) diamond marker'
  );
});

test('Native pill has ▣ (square-in-square) marker', () => {
  assert(
    headerSrc.includes('\\u25A3') || headerSrc.includes('\u25A3'),
    'Native pill missing ▣ (\\u25A3) square marker'
  );
});

test('Other pill has ○ (circle outline) marker', () => {
  assert(
    headerSrc.includes('\\u25CB') || headerSrc.includes('\u25CB'),
    'Other pill missing ○ (\\u25CB) circle marker'
  );
});

test('All 4 pill types have distinct markers', () => {
  const markers = [
    headerSrc.includes('f()'),
    headerSrc.includes('\\u25C6') || headerSrc.includes('\u25C6'),
    headerSrc.includes('\\u25A3') || headerSrc.includes('\u25A3'),
    headerSrc.includes('\\u25CB') || headerSrc.includes('\u25CB'),
  ];
  const distinctCount = markers.filter(Boolean).length;
  assert(distinctCount === 4, `Only ${distinctCount}/4 pill markers found`);
});

test('Markers use consistent 11px font size', () => {
  // Count occurrences of fontSize: '11px' near the pill markers
  const matches = headerSrc.match(/fontSize:\s*['"]11px['"]/g);
  assert(
    matches && matches.length >= 3,
    'Not all pill markers use 11px font size'
  );
});

sectionSummary();

// ============================================================
// 6. P0-5: Text Truncation 12→16
// ============================================================

section('P0-5: Text Truncation 12→16');

test('textTruncateLength is 16 for neural style', () => {
  assert(
    dendrogramSrc.includes("textTruncateLength: NODE_STYLE === 'neural' ? 16"),
    'textTruncateLength not set to 16 for neural style'
  );
});

test('textTruncateLength is NOT 12 anymore', () => {
  assert(
    !dendrogramSrc.includes("textTruncateLength: NODE_STYLE === 'neural' ? 12"),
    'textTruncateLength still set to old value of 12'
  );
});

test('Compact mode fallback (9 chars) unchanged', () => {
  assert(
    dendrogramSrc.includes('isCompact ? 9'),
    'Compact mode truncation fallback to 9 was changed — should be preserved'
  );
});

sectionSummary();

// ============================================================
// 7. Build Artifact Verification
// ============================================================

section('Build Artifacts');

test('dist/webview.js exists', () => {
  assert(fs.existsSync(webviewBundle), 'dist/webview.js not found — run npm run build');
});

test('dist/extension.js exists', () => {
  assert(
    fs.existsSync(path.join(distDir, 'extension.js')),
    'dist/extension.js not found — run npm run build'
  );
});

test('webview bundle contains prefers-reduced-motion', () => {
  const bundle = fs.readFileSync(webviewBundle, 'utf-8');
  assert(
    bundle.includes('prefers-reduced-motion'),
    'Compiled webview.js missing prefers-reduced-motion — build may be stale'
  );
});

test('webview bundle contains FLOW_TYPE_PATTERNS', () => {
  const bundle = fs.readFileSync(webviewBundle, 'utf-8');
  // In the bundle it might be minified, check for the dash pattern values
  assert(
    bundle.includes('12, 6') || bundle.includes('12,6'),
    'Compiled webview.js missing flow dash patterns — build may be stale'
  );
});

test('webview bundle contains pill markers', () => {
  const bundle = fs.readFileSync(webviewBundle, 'utf-8');
  assert(
    bundle.includes('f()') && (bundle.includes('\u25C6') || bundle.includes('\\u25C6')),
    'Compiled webview.js missing pill markers — build may be stale'
  );
});

test('.vsix package exists', () => {
  const vsixFiles = fs.readdirSync(projectRoot).filter(f => f.endsWith('.vsix'));
  assert(vsixFiles.length > 0, 'No .vsix file found — run npm run package');
});

sectionSummary();

// ============================================================
// 8. Regression Guards
// ============================================================

section('Regression Guards');

test('@keyframes resting-potential still defined', () => {
  assert(
    dendrogramSrc.includes('@keyframes resting-potential'),
    '@keyframes resting-potential was accidentally deleted'
  );
});

test('@keyframes neurogenesis-bloom still defined', () => {
  assert(
    dendrogramSrc.includes('@keyframes neurogenesis-bloom'),
    '@keyframes neurogenesis-bloom was accidentally deleted'
  );
});

test('@keyframes live-pulse still defined', () => {
  assert(
    dendrogramSrc.includes('@keyframes live-pulse'),
    '@keyframes live-pulse was accidentally deleted'
  );
});

test('@keyframes flow-dash still defined', () => {
  assert(
    dendrogramSrc.includes('@keyframes flow-dash'),
    '@keyframes flow-dash was accidentally deleted'
  );
});

test('Keyboard navigation attributes preserved', () => {
  assert(
    dendrogramSrc.includes('tabindex') && dendrogramSrc.includes('role', 'treeitem'),
    'Keyboard navigation attributes (tabindex/role) missing'
  );
});

test('FLOW_TYPE_COLORS still present', () => {
  // Extracted to src/webview/hooks/useVisualizationCommands.js
  assert(
    vizCommandsSrc.includes('FLOW_TYPE_COLORS'),
    'FLOW_TYPE_COLORS constant was accidentally removed'
  );
});

test('NODE_STYLE still set to neural', () => {
  assert(
    dendrogramSrc.includes("const NODE_STYLE = 'neural'"),
    'NODE_STYLE changed from neural — should remain neural'
  );
});

test('SYNAPSE_CONFIG still present', () => {
  assert(
    dendrogramSrc.includes('SYNAPSE_CONFIG'),
    'SYNAPSE_CONFIG was accidentally removed'
  );
});

test('Myelination rendering still present', () => {
  assert(
    dendrogramSrc.includes('myelin-group') && dendrogramSrc.includes('myelin-sheath'),
    'Myelination rendering was accidentally removed'
  );
});

test('DendriteLoader structure unchanged (8 dendrites, 6 particles, 3 rings)', () => {
  const dendrites = (loaderSrc.match(/className="dendrite"/g) || []).length;
  const particles = (loaderSrc.match(/className="particle"/g) || []).length;
  const rings = (loaderSrc.match(/className="signal-ring"/g) || []).length;
  assert(dendrites === 8, `Expected 8 dendrites, found ${dendrites}`);
  assert(particles === 6, `Expected 6 particles, found ${particles}`);
  assert(rings === 3, `Expected 3 signal rings, found ${rings}`);
});

test('AppHeader pill structure unchanged (Functional, Class, Native, Other)', () => {
  assert(headerSrc.includes('Functional'), 'Missing Functional pill');
  assert(headerSrc.includes('Class'), 'Missing Class pill');
  assert(headerSrc.includes('Native'), 'Missing Native pill');
  assert(headerSrc.includes('Other'), 'Missing Other pill');
});

test('Soma stagger via --node-index preserved', () => {
  assert(
    dendrogramSrc.includes('--node-index'),
    'Soma stagger via --node-index CSS variable missing'
  );
});

test('Dark mode toggle still functional', () => {
  assert(
    dendrogramSrc.includes('setDarkMode'),
    'Dark mode toggle setDarkMode call missing'
  );
});

sectionSummary();

// ============================================================
// 9. Cross-file Consistency
// ============================================================

section('Cross-file Consistency');

test('FLOW_TYPE_PATTERNS keys match FLOW_TYPE_COLORS keys', () => {
  // Extract keys from source (these live in different extracted files now)
  const colorKeys = [];
  const patternKeys = [];

  const colorBlock = vizCommandsSrc.match(/FLOW_TYPE_COLORS\s*=\s*\{([^}]+)\}/);
  const patternBlock = renderFlowsSrc.match(/FLOW_TYPE_PATTERNS\s*=\s*\{([^}]+)\}/);

  assert(colorBlock && patternBlock, 'Could not extract FLOW_TYPE_COLORS or FLOW_TYPE_PATTERNS');

  // Extract keys (handling both plain and quoted)
  const keyRegex = /(?:'([^']+)'|(\w+))\s*:/g;
  let match;
  while ((match = keyRegex.exec(colorBlock[1]))) {
    colorKeys.push(match[1] || match[2]);
  }
  keyRegex.lastIndex = 0;
  while ((match = keyRegex.exec(patternBlock[1]))) {
    patternKeys.push(match[1] || match[2]);
  }

  assert(
    colorKeys.length === patternKeys.length,
    `Key count mismatch: COLORS has ${colorKeys.length}, PATTERNS has ${patternKeys.length}`
  );
  for (const key of colorKeys) {
    assert(
      patternKeys.includes(key),
      `FLOW_TYPE_PATTERNS missing key: ${key}`
    );
  }
});

test('tokens.js exports used by all webview files', () => {
  assert(
    dendrogramSrc.includes("from './tokens'") || dendrogramSrc.includes('from "./tokens"'),
    'Dendrogram.jsx not importing from tokens'
  );
  assert(
    headerSrc.includes("from './tokens'") || headerSrc.includes('from "./tokens"'),
    'AppHeader.jsx not importing from tokens'
  );
  assert(
    loaderSrc.includes("from './tokens'") || loaderSrc.includes('from "./tokens"'),
    'DendriteLoader.jsx not importing from tokens'
  );
});

sectionSummary();

// ============================================================
// Summary
// ============================================================

console.log('\n' + '='.repeat(60));
console.log(`\n\u{1F9EC} P0 Theme Audit Tests: ${passed} passed, ${failed} failed (${passed + failed} total)\n`);

if (failed > 0) {
  console.log('\u274c Some tests failed. Review the failures above.');
  process.exit(1);
} else {
  console.log('\u2705 All P0 theme audit changes verified!\n');
  console.log('Next steps:');
  console.log('  1. Install .vsix: code --install-extension dendro-mcp-0.4.0.vsix');
  console.log('  2. Cmd+Q restart VS Code');
  console.log('  3. Manual checks:');
  console.log('     - macOS System Settings > Accessibility > Display > Reduce motion');
  console.log('     - Small tree (<50 nodes): soma breathing should be visible');
  console.log('     - Large tree (>50 nodes): zero idle animations');
  console.log('     - Trigger flows: solid (prop) / dashed (context) / dotted (hook-state)');
  console.log('     - Header pills: f() / \u25C6 / \u25A3 / \u25CB markers visible');
  console.log('     - Component names: 16 chars before truncation');
  process.exit(0);
}
