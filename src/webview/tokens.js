/**
 * Dendro React Design Tokens
 * Single source of truth for all colors, themes, and visual constants.
 *
 * Cosmic design language: constellation-inspired naming (visual brand layer).
 * See `.dev/BRAND.md` for the full brand system (cosmic visual + chemistry conceptual).
 * Neural naming was retired 2026-04-14 — if you see any remaining references, remove them.
 */

// === Core Palette ===
export const PALETTE = {
  // Primary (cosmic)
  voidDeep: "#0A0E17",       // Primary dark background — the cosmic void
  nebulaSlate: "#1A1F2E",    // Secondary dark background — faint nebular gas
  stellarCyan: "#00d4ff",    // Primary accent — star core
  auroraGreen: "#009E73",    // Secondary accent — aurora, Okabe-Ito CVD-safe
  novaWhite: "#FFFFFF",      // Brightest text/highlights — nova flash

  // Legacy (light mode)
  ink: "#1a1a1a",            // Ink Black (kept for light mode text)
  cream: "#f5e6c8",          // Slide Cream — light mode background
  brown: "#3d2b1f",          // Stain Brown — light mode borders/links
  navy: "#494f8b",           // Deep Navy (legacy, replaced by nebulaSlate in dark)

  // Light mode adjusted accents
  cyanDark: "#007a99",       // Darker cyan for readability on cream
  greenDark: "#007A5E",      // Darker aurora green for light mode (CVD-safe)

  // Signal colors (semantic — cosmic-themed)
  flareOrange: "#FF6B35",    // Warnings, hot paths — solar flare
  quasarViolet: "#8B5CF6",   // Context flow, state management — quasar's deep violet
  solarGold: "#FFB800",      // Highlights, selections — sunlight
  redshiftRose: "#FF4D6A",   // Critical errors, broken connections — redshift
  genesisGreen: "#10B981",   // Success, verified — birth of stars

  // State colors
  darkMatter: "#2A3040",     // Inactive/collapsed nodes — invisible mass

  // Status indicators (runtime connection)
  statusConnected: "#00ff64",  // Connected — bright green
  statusListening: "#ffc800",  // Listening/waiting — gold
  statusOffline: "#ff4444",    // Offline/error — red

  // Short aliases (used by BRAND references in components)
  cyan: "#00d4ff",
  green: "#009E73",
};

// === Highlight Colors (AI-controlled visualization) ===
export const HIGHLIGHT_COLORS = {
  red: "#ff4444",
  orange: "#ff8c00",
  yellow: "#ffd700",
  green: "#00ff7f",
  blue: "#4169e1",
  purple: "#9370db",
};

// === Theme Schemes ===
export const THEMES = {
  light: {
    background: PALETTE.cream,
    link: "rgba(61, 43, 31, 0.7)",
    text: {
      primary: PALETTE.ink,
      secondary: PALETTE.brown,
      tertiary: PALETTE.cyanDark,
    },
    depths: [
      PALETTE.cream,
      "#edd9b5",
      "#e0c99e",
      "#d4ba87",
      "#c7aa70",
      PALETTE.brown,
    ],
    popup: {
      background: "#fffbf5",
      border: PALETTE.brown,
      text: PALETTE.ink,
      shadow: "rgba(61, 43, 31, 0.2)",
    },
    nodeStroke: PALETTE.brown,
    nodeStrokeOpacity: 0.6,
    nodeShadow: PALETTE.cyanDark,
  },
  dark: {
    background: PALETTE.voidDeep,
    link: "rgba(245, 230, 200, 0.5)",
    text: {
      primary: PALETTE.cream,
      secondary: PALETTE.stellarCyan,
      tertiary: PALETTE.auroraGreen,
    },
    depths: [
      PALETTE.nebulaSlate,
      "#1e2436",
      "#171c2c",
      "#121722",
      "#0e1219",
      PALETTE.voidDeep,
    ],
    popup: {
      background: PALETTE.nebulaSlate,
      border: PALETTE.stellarCyan,
      text: PALETTE.cream,
      shadow: "rgba(0, 0, 0, 0.4)",
    },
    nodeStroke: PALETTE.cream,
    nodeStrokeOpacity: 0.3,
    nodeShadow: PALETTE.stellarCyan,
  },
};

// === CSS Custom Properties (embedded in <style> block) ===
export const CSS_VARS = `
  :root {
    --dendro-bg: ${PALETTE.voidDeep};
    --dendro-bg-secondary: ${PALETTE.nebulaSlate};
    --dendro-cream: ${PALETTE.cream};
    --dendro-cyan: ${PALETTE.stellarCyan};
    --dendro-green: ${PALETTE.auroraGreen};
    --dendro-brown: ${PALETTE.brown};
    --dendro-ink: ${PALETTE.ink};
    --dendro-navy: ${PALETTE.navy};
    --dendro-violet: ${PALETTE.quasarViolet};
    --dendro-gold: ${PALETTE.solarGold};
    --dendro-flare: ${PALETTE.flareOrange};
    --dendro-rose: ${PALETTE.redshiftRose};
    --dendro-genesis: ${PALETTE.genesisGreen};
    --dendro-darkmatter: ${PALETTE.darkMatter};
    --dendro-ease: cubic-bezier(0.4, 0, 0.2, 1);
    --dendro-duration: 200ms;
  }
`;

// === Gradients ===
export const GRADIENTS = {
  signal: `linear-gradient(90deg, ${PALETTE.stellarCyan} 0%, ${PALETTE.auroraGreen} 50%, ${PALETTE.stellarCyan} 100%)`,
  voidField: `linear-gradient(180deg, ${PALETTE.voidDeep} 0%, ${PALETTE.nebulaSlate} 100%)`,
  darkField: `radial-gradient(ellipse at 30% 40%, rgba(0, 212, 255, 0.03) 0%, transparent 50%), radial-gradient(ellipse at 70% 60%, rgba(0, 158, 115, 0.03) 0%, transparent 50%)`,
};

// === AppHeader Color Helpers ===
export const getHeaderColors = (darkMode) => ({
  ink: PALETTE.ink,
  cream: PALETTE.cream,
  cyan: darkMode ? PALETTE.stellarCyan : PALETTE.cyanDark,
  green: darkMode ? PALETTE.auroraGreen : PALETTE.greenDark,
  brown: PALETTE.brown,
  navy: PALETTE.navy,
});
