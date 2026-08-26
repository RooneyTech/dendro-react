/**
 * RSC directive detection ("use client" / "use server").
 *
 * Tolerates leading comments and blank lines — a license header or
 * `// @ts-nocheck` must not hide the directive. Directives are only valid
 * before the first statement, so scanning stops at the first line that is
 * neither a comment, whitespace, nor a directive string.
 */

export type FileDirective = 'use client' | 'use server' | null;

const DIRECTIVE_RE = /^(['"])use (client|server)\1;?$/;

export function detectFileDirective(code: string): FileDirective {
  let rest = code;
  // Strip BOM
  if (rest.charCodeAt(0) === 0xfeff) rest = rest.slice(1);

  let inBlockComment = false;
  for (const rawLine of rest.split('\n').slice(0, 100)) {
    let line = rawLine.trim();
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2).trim();
      inBlockComment = false;
    }
    // Strip any complete block comments on this line
    while (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end === -1) { inBlockComment = true; line = ''; break; }
      line = line.slice(end + 2).trim();
    }
    if (line === '' || line.startsWith('//')) continue;

    const m = line.match(DIRECTIVE_RE);
    if (m) return `use ${m[2]}` as FileDirective;
    // First real statement without a directive — stop looking
    return null;
  }
  return null;
}
