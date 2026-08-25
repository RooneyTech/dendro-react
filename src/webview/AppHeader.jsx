/*
APP HEADER COMPONENT
==================

PURPOSE:
Renders a fixed header displaying app analysis statistics and branding.
Supports both light and dark mode themes.

BRAND DESIGN:
-----------------
Colors (from DESIGN-DIRECTION.md):
  - Ink Black: #1a1a1a
  - Slide Cream: #f5e6c8
  - Bio Cyan: #00d4ff
  - Bio Green: #00ffe5
  - Stain Brown: #3d2b1f
  - Deep Navy: #494f8b

Typography:
  - Font: Inter, IBM Plex Sans, system-ui, sans-serif
  - Wordmark: lowercase "dendro", letter-spacing +2%, weight 500
*/

import React from "react";
import { PALETTE, getHeaderColors } from "./tokens";

// Generate theme-aware styles
const getStyles = (darkMode) => {
  const colors = getHeaderColors(darkMode);
  return ({
  header: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: darkMode
      ? 'rgba(10, 14, 23, 0.95)' // membrane dark with transparency
      : 'rgba(245, 230, 200, 0.95)', // cream with transparency
    backdropFilter: 'blur(8px)',
    color: darkMode ? colors.cream : colors.ink,
    padding: '16px 24px',
    zIndex: 10,
    fontFamily: "'Inter', 'IBM Plex Sans', system-ui, sans-serif",
    borderBottom: darkMode
      ? `1px solid rgba(245, 230, 200, 0.1)`
      : `1px solid rgba(61, 43, 31, 0.15)`,
    transition: 'background-color 200ms ease, color 200ms ease, border-color 200ms ease',
  },
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    maxWidth: '1280px',
    margin: '0 auto',
  },
  contentWrapper: {
    display: 'flex',
    alignItems: 'center',
    gap: '48px',
  },
  brandSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  wordmark: {
    fontSize: '22px',
    fontWeight: 700,
    fontFamily: "'Space Grotesk', Inter, 'IBM Plex Sans', system-ui, sans-serif",
    letterSpacing: '0.02em',
    color: darkMode ? colors.cyan : colors.cyanDark,
    textShadow: darkMode
      ? `0 0 20px ${colors.cyan}40, 0 0 40px ${colors.cyan}20`
      : `0 0 15px ${colors.cyanDark}30`,
    margin: 0,
    lineHeight: 1,
  },
  filePath: {
    fontSize: '12px',
    fontWeight: 400,
    color: darkMode ? colors.cream : colors.brown,
    opacity: darkMode ? 0.5 : 0.7,
    margin: 0,
  },
  statsContainer: {
    display: 'flex',
    gap: '12px',
    marginTop: '12px',
  },
  pillBase: {
    fontSize: '12px',
    fontWeight: 500,
    padding: '4px 12px',
    borderRadius: '9999px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
  },
  functionalPill: {
    backgroundColor: `${colors.cyan}${darkMode ? '20' : '15'}`,
    color: colors.cyan,
    border: `1px solid ${colors.cyan}${darkMode ? '40' : '30'}`,
  },
  classPill: {
    backgroundColor: `${colors.green}${darkMode ? '20' : '15'}`,
    color: colors.green,
    border: `1px solid ${colors.green}${darkMode ? '40' : '30'}`,
  },
  otherPill: darkMode ? {
    backgroundColor: `${colors.cream}10`,
    color: colors.cream,
    opacity: 0.7,
    border: `1px solid ${colors.cream}20`,
  } : {
    backgroundColor: `${colors.brown}10`,
    color: colors.brown,
    opacity: 0.8,
    border: `1px solid ${colors.brown}20`,
  },
});
};

const AppHeader = ({ stats, filePath, darkMode = true, isRuntime = false, runtimeStatus = null }) => {
  // Calculate component type percentages
  const { functionalCount, classCount, nullCount, totalComponents } = stats;
  const functionalPercent = totalComponents > 0 ? ((functionalCount / totalComponents) * 100).toFixed(1) : '0.0';
  const classPercent = totalComponents > 0 ? ((classCount / totalComponents) * 100).toFixed(1) : '0.0';
  const nullPercent = totalComponents > 0 ? ((nullCount / totalComponents) * 100).toFixed(1) : '0.0';

  // Runtime-specific stats
  const hostCount = stats.hostCount || 0;
  const hostPercent = totalComponents > 0 ? ((hostCount / totalComponents) * 100).toFixed(1) : '0.0';

  // Get theme-aware styles
  const styles = getStyles(darkMode);

  // Runtime status badge styles
  const runtimeBadge = isRuntime ? {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    fontWeight: 600,
    padding: '3px 10px',
    borderRadius: '9999px',
    marginLeft: '12px',
    ...(runtimeStatus === 'connected' ? {
      backgroundColor: 'rgba(0, 255, 100, 0.15)',
      color: PALETTE.statusConnected,
      border: '1px solid rgba(0, 255, 100, 0.3)',
    } : runtimeStatus === 'listening' || runtimeStatus === 'waiting' ? {
      backgroundColor: 'rgba(255, 200, 0, 0.15)',
      color: PALETTE.statusListening,
      border: '1px solid rgba(255, 200, 0, 0.3)',
    } : {
      backgroundColor: 'rgba(255, 68, 68, 0.15)',
      color: PALETTE.statusOffline,
      border: '1px solid rgba(255, 68, 68, 0.3)',
    }),
  } : null;

  return (
    <header style={styles.header}>
      <div style={styles.container}>
        <div style={styles.contentWrapper}>
          {/* Brand Section */}
          <div style={styles.brandSection}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <h1 style={styles.wordmark}>dendro</h1>
              {isRuntime && runtimeBadge && (
                <span style={runtimeBadge}>
                  <span style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    backgroundColor: runtimeStatus === 'connected' ? PALETTE.statusConnected :
                      (runtimeStatus === 'listening' || runtimeStatus === 'waiting') ? PALETTE.statusListening : PALETTE.statusOffline,
                    display: 'inline-block',
                  }} />
                  {runtimeStatus === 'connected' ? 'LIVE' :
                    runtimeStatus === 'listening' ? 'WAITING' :
                    runtimeStatus === 'waiting' ? 'WAITING' : 'OFFLINE'}
                </span>
              )}
            </div>
            <p style={styles.filePath}>{filePath}</p>

            {/* Statistics pills */}
            {totalComponents > 0 && (
              <div style={styles.statsContainer}>
                <span style={{ ...styles.pillBase, ...styles.functionalPill }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '11px' }}>f()</span>
                  <span style={{ opacity: 0.7 }}>Functional</span>
                  <span style={{ fontWeight: 600 }}>{functionalPercent}%</span>
                </span>
                <span style={{ ...styles.pillBase, ...styles.classPill }}>
                  <span style={{ fontSize: '11px' }}>{'\u25C6'}</span>
                  <span style={{ opacity: 0.7 }}>Class</span>
                  <span style={{ fontWeight: 600 }}>{classPercent}%</span>
                </span>
                {isRuntime && hostCount > 0 && (
                  <span style={{ ...styles.pillBase, ...styles.otherPill }}>
                    <span style={{ fontSize: '11px' }}>{'\u25A3'}</span>
                    <span style={{ opacity: 0.7 }}>Native</span>
                    <span style={{ fontWeight: 600 }}>{hostPercent}%</span>
                  </span>
                )}
                {!isRuntime && nullCount > 0 && (
                  <span style={{ ...styles.pillBase, ...styles.otherPill }}>
                    <span style={{ fontSize: '11px' }}>{'\u25CB'}</span>
                    <span style={{ opacity: 0.7 }}>Other</span>
                    <span style={{ fontWeight: 600 }}>{nullPercent}%</span>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

export default AppHeader;

/*
USAGE:
-----
<AppHeader
  stats={{
    functionalCount: 10,
    classCount: 2,
    nullCount: 0,
    totalComponents: 12
  }}
  filePath="/src/App.tsx"
  darkMode={true}  // optional, defaults to true
/>
*/
