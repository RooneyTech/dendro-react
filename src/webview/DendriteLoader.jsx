import React from "react";
import { PALETTE, THEMES } from "./tokens";

/**
 * DendriteLoader - A neural/dendrite-inspired loading animation
 *
 * Displays an organic, pulsing dendrite pattern with branching axons
 * that glow with the brand cyan color, creating the effect of a
 * neuron waiting to receive signal data.
 *
 * @param {boolean} darkMode - Whether to render in dark mode (default: true)
 */

const BRAND = PALETTE;

const DendriteLoader = ({ darkMode = true }) => {
  const theme = darkMode ? THEMES.dark : THEMES.light;
  const accentCyan = darkMode ? BRAND.cyan : BRAND.cyanDark;
  const accentGreen = darkMode ? BRAND.green : BRAND.greenDark;
  const somaCore = darkMode ? BRAND.navy : BRAND.brown;
  const ambientInner = darkMode ? `${BRAND.nebulaSlate}40` : `${BRAND.brown}15`;

  return (
    <div className="dendrite-loader">
      <style>{`
        .dendrite-loader {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: calc(100vh - 60px);
          background: ${theme.background};
          position: relative;
          overflow: hidden;
        }

        .dendrite-container {
          position: relative;
          width: 300px;
          height: 300px;
        }

        /* Central soma (cell body) */
        .soma {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 40px;
          height: 40px;
          background: radial-gradient(
            circle,
            ${accentCyan} 0%,
            ${somaCore} 60%,
            transparent 100%
          );
          border-radius: 50%;
          animation: soma-pulse 2s ease-in-out infinite;
          box-shadow:
            0 0 20px ${accentCyan},
            0 0 40px ${accentCyan}40,
            0 0 60px ${accentCyan}20;
        }

        @keyframes soma-pulse {
          0%, 100% {
            transform: translate(-50%, -50%) scale(1);
            opacity: 0.8;
          }
          50% {
            transform: translate(-50%, -50%) scale(1.15);
            opacity: 1;
          }
        }

        /* Dendrite branches */
        .dendrite {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 3px;
          height: 80px;
          background: linear-gradient(
            to top,
            ${accentCyan} 0%,
            ${accentCyan}80 30%,
            ${accentCyan}40 60%,
            transparent 100%
          );
          transform-origin: bottom center;
          border-radius: 2px;
          animation: dendrite-grow 2.5s ease-in-out infinite;
        }

        /* Sub-branches */
        .dendrite::before,
        .dendrite::after {
          content: '';
          position: absolute;
          bottom: 40%;
          width: 2px;
          height: 35px;
          background: linear-gradient(
            to top,
            ${accentCyan}80 0%,
            ${accentCyan}40 50%,
            transparent 100%
          );
          border-radius: 2px;
          animation: branch-grow 2.5s ease-in-out infinite;
        }

        .dendrite::before {
          left: -15px;
          transform: rotate(-30deg);
          transform-origin: bottom center;
          animation-delay: 0.3s;
        }

        .dendrite::after {
          right: -15px;
          transform: rotate(30deg);
          transform-origin: bottom center;
          animation-delay: 0.5s;
        }

        @keyframes dendrite-grow {
          0%, 100% {
            opacity: 0.4;
            height: 70px;
          }
          50% {
            opacity: 1;
            height: 90px;
          }
        }

        @keyframes branch-grow {
          0%, 100% {
            opacity: 0.3;
            height: 30px;
          }
          50% {
            opacity: 0.8;
            height: 40px;
          }
        }

        /* Position each dendrite at different angles */
        .dendrite:nth-child(1) { transform: rotate(0deg) translateY(-20px); animation-delay: 0s; }
        .dendrite:nth-child(2) { transform: rotate(45deg) translateY(-20px); animation-delay: 0.15s; }
        .dendrite:nth-child(3) { transform: rotate(90deg) translateY(-20px); animation-delay: 0.3s; }
        .dendrite:nth-child(4) { transform: rotate(135deg) translateY(-20px); animation-delay: 0.45s; }
        .dendrite:nth-child(5) { transform: rotate(180deg) translateY(-20px); animation-delay: 0.6s; }
        .dendrite:nth-child(6) { transform: rotate(225deg) translateY(-20px); animation-delay: 0.75s; }
        .dendrite:nth-child(7) { transform: rotate(270deg) translateY(-20px); animation-delay: 0.9s; }
        .dendrite:nth-child(8) { transform: rotate(315deg) translateY(-20px); animation-delay: 1.05s; }

        /* Synaptic particles */
        .particle {
          position: absolute;
          width: 4px;
          height: 4px;
          background: ${accentGreen};
          border-radius: 50%;
          animation: particle-float 3s ease-in-out infinite;
          box-shadow: 0 0 6px ${accentGreen};
        }

        .particle:nth-child(1) { top: 20%; left: 30%; animation-delay: 0s; }
        .particle:nth-child(2) { top: 15%; left: 60%; animation-delay: 0.5s; }
        .particle:nth-child(3) { top: 70%; left: 25%; animation-delay: 1s; }
        .particle:nth-child(4) { top: 75%; left: 70%; animation-delay: 1.5s; }
        .particle:nth-child(5) { top: 40%; left: 85%; animation-delay: 2s; }
        .particle:nth-child(6) { top: 60%; left: 10%; animation-delay: 2.5s; }

        @keyframes particle-float {
          0%, 100% {
            transform: translate(0, 0) scale(0.8);
            opacity: 0.4;
          }
          25% {
            transform: translate(5px, -8px) scale(1);
            opacity: 1;
          }
          50% {
            transform: translate(-3px, -5px) scale(0.9);
            opacity: 0.7;
          }
          75% {
            transform: translate(2px, 3px) scale(1.1);
            opacity: 0.9;
          }
        }

        /* Signal ring pulses */
        .signal-ring {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 60px;
          height: 60px;
          border: 2px solid ${accentCyan};
          border-radius: 50%;
          animation: signal-expand 2.5s ease-out infinite;
          opacity: 0;
        }

        .signal-ring:nth-child(2) { animation-delay: 0.8s; }
        .signal-ring:nth-child(3) { animation-delay: 1.6s; }

        @keyframes signal-expand {
          0% {
            width: 40px;
            height: 40px;
            opacity: 0.8;
            border-width: 3px;
          }
          100% {
            width: 200px;
            height: 200px;
            opacity: 0;
            border-width: 1px;
          }
        }

        /* Loading text */
        .loader-text {
          margin-top: 40px;
          color: ${theme.text.primary};
          font-family: Inter, 'IBM Plex Sans', -apple-system, sans-serif;
          font-size: 14px;
          font-weight: 400;
          letter-spacing: 0.5px;
          opacity: 0.8;
          animation: text-pulse 2s ease-in-out infinite;
        }

        .loader-subtext {
          margin-top: 8px;
          color: ${accentCyan};
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          font-weight: 400;
          opacity: 0.6;
        }

        @keyframes text-pulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }

        /* Ambient background glow */
        .ambient-glow {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 400px;
          height: 400px;
          background: radial-gradient(
            circle,
            ${ambientInner} 0%,
            ${theme.background} 70%
          );
          pointer-events: none;
          animation: ambient-breathe 4s ease-in-out infinite;
        }

        @keyframes ambient-breathe {
          0%, 100% {
            transform: translate(-50%, -50%) scale(1);
            opacity: 0.5;
          }
          50% {
            transform: translate(-50%, -50%) scale(1.1);
            opacity: 0.7;
          }
        }

        /* === Reduced Motion: Accessibility === */

        @media (prefers-reduced-motion: reduce) {
          .soma,
          .dendrite,
          .dendrite::before,
          .dendrite::after,
          .particle,
          .signal-ring,
          .loader-text,
          .ambient-glow {
            animation: none !important;
          }

          /* Static visibility so loader content remains visible */
          .soma { opacity: 0.9; }
          .dendrite { opacity: 0.7; }
          .dendrite::before,
          .dendrite::after { opacity: 0.5; }
          .particle { opacity: 0.6; }
          .signal-ring { opacity: 0; }
          .loader-text { opacity: 0.8; }
          .ambient-glow { opacity: 0.6; }
        }
      `}</style>

      <div className="ambient-glow" />

      <div className="dendrite-container">
        {/* Signal rings */}
        <div className="signal-ring" />
        <div className="signal-ring" />
        <div className="signal-ring" />

        {/* Dendrite branches */}
        <div className="dendrite" />
        <div className="dendrite" />
        <div className="dendrite" />
        <div className="dendrite" />
        <div className="dendrite" />
        <div className="dendrite" />
        <div className="dendrite" />
        <div className="dendrite" />

        {/* Central soma */}
        <div className="soma" />

        {/* Floating particles */}
        <div className="particle" />
        <div className="particle" />
        <div className="particle" />
        <div className="particle" />
        <div className="particle" />
        <div className="particle" />
      </div>

      <p className="loader-text">Awaiting component data...</p>
      <p className="loader-subtext">Open a React file to visualize</p>
    </div>
  );
};

export default DendriteLoader;
