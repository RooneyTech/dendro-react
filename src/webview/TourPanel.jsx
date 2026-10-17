import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PALETTE, THEMES } from './tokens';

/**
 * TourPanel — Step-by-step tour overlay for guided codebase walkthroughs.
 *
 * Renders as a fixed panel at the bottom of the viewport. Each step has a
 * title, description, and array of viz commands. Commands feed into the
 * existing Dendrogram command queue via handleVisualizationCommand.
 */
const TourPanel = ({ config, darkMode, onExit }) => {
  const [stepIndex, setStepIndex] = useState(0);
  const [autoPlaying, setAutoPlaying] = useState(config.autoPlay || false);
  const [transitioning, setTransitioning] = useState(false);
  const autoAdvanceTimerRef = useRef(null);

  const step = config.steps[stepIndex];
  const totalSteps = config.steps.length;
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === totalSteps - 1;

  // Calculate total command delay for a step
  const getStepCommandDelay = useCallback((s) => {
    if (!s.commands || s.commands.length === 0) return 100;
    return s.commands.reduce((sum, cmd) => {
      switch (cmd.type) {
        case 'zoom': return sum + (cmd.payload?.duration || 750);
        case 'fitAll': return sum + (cmd.payload?.duration || 1500);
        case 'traceFlow': return sum + 200;
        case 'highlight':
        case 'annotate':
        case 'clear':
        case 'expand':
        case 'collapse': return sum + 100;
        default: return sum + 300;
      }
    }, 0);
  }, []);

  // Execute a step's commands via the global command handler
  const executeStep = useCallback((s) => {
    const handler = window._dendroVisualizationCommandHandler;
    if (!handler) {
      console.warn('Dendro Tour: No command handler available');
      return;
    }

    // Clear previous state
    handler({ type: 'clear', payload: { clearType: 'all' } });

    // Execute step commands
    if (s.commands) {
      for (const cmd of s.commands) {
        handler(cmd);
      }
    }
  }, []);

  // Navigate to a specific step
  const goToStep = useCallback((newIndex) => {
    if (newIndex < 0 || newIndex >= totalSteps || transitioning) return;

    // Cancel any pending auto-advance
    if (autoAdvanceTimerRef.current) {
      clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }

    setTransitioning(true);
    setStepIndex(newIndex);
    const targetStep = config.steps[newIndex];
    executeStep(targetStep);

    // Re-enable navigation after commands finish
    const commandDelay = getStepCommandDelay(targetStep);
    setTimeout(() => {
      setTransitioning(false);

      // Schedule auto-advance if playing
      if (autoPlaying && targetStep.autoAdvanceMs && newIndex < totalSteps - 1) {
        autoAdvanceTimerRef.current = setTimeout(() => {
          goToStep(newIndex + 1);
        }, targetStep.autoAdvanceMs);
      }
    }, commandDelay);
  }, [totalSteps, transitioning, config.steps, executeStep, getStepCommandDelay, autoPlaying]);

  // Execute first step on mount
  useEffect(() => {
    executeStep(config.steps[0]);

    const commandDelay = getStepCommandDelay(config.steps[0]);
    setTimeout(() => {
      if (autoPlaying && config.steps[0].autoAdvanceMs && totalSteps > 1) {
        autoAdvanceTimerRef.current = setTimeout(() => {
          goToStep(1);
        }, config.steps[0].autoAdvanceMs);
      }
    }, commandDelay);

    return () => {
      if (autoAdvanceTimerRef.current) {
        clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard navigation
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isLastStep) goToStep(stepIndex + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isFirstStep) goToStep(stepIndex - 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleExit();
      } else if (e.key === ' ') {
        e.preventDefault();
        toggleAutoPlay();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [stepIndex, isFirstStep, isLastStep, autoPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleAutoPlay = useCallback(() => {
    setAutoPlaying(prev => {
      const next = !prev;
      if (!next && autoAdvanceTimerRef.current) {
        clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
      if (next && step.autoAdvanceMs && !isLastStep) {
        const commandDelay = getStepCommandDelay(step);
        autoAdvanceTimerRef.current = setTimeout(() => {
          goToStep(stepIndex + 1);
        }, commandDelay + step.autoAdvanceMs);
      }
      return next;
    });
  }, [step, isLastStep, stepIndex, getStepCommandDelay, goToStep]);

  const handleExit = useCallback(() => {
    if (autoAdvanceTimerRef.current) {
      clearTimeout(autoAdvanceTimerRef.current);
    }
    if (config.clearOnExit !== false) {
      const handler = window._dendroVisualizationCommandHandler;
      if (handler) {
        handler({ type: 'clear', payload: { clearType: 'all' } });
      }
    }
    onExit();
  }, [config.clearOnExit, onExit]);

  // Theme-aware colors
  const theme = darkMode ? THEMES.dark : THEMES.light;
  const bgColor = darkMode
    ? 'rgba(26, 31, 46, 0.95)'
    : 'rgba(255, 251, 245, 0.95)';
  const borderColor = darkMode
    ? 'rgba(0, 212, 255, 0.3)'
    : 'rgba(61, 43, 31, 0.3)';
  const textColor = theme.text.primary;
  const secondaryText = darkMode ? PALETTE.auroraGreen : PALETTE.brown;
  const accentColor = darkMode ? PALETTE.stellarCyan : PALETTE.cyanDark;

  return (
    <div style={{
      position: 'fixed',
      bottom: 24,
      left: '50%',
      transform: 'translateX(-50%)',
      maxWidth: 480,
      width: 'calc(100% - 48px)',
      zIndex: 200,
      background: bgColor,
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      border: `1px solid ${borderColor}`,
      borderRadius: 12,
      boxShadow: '0 -4px 24px rgba(0, 0, 0, 0.3)',
      fontFamily: "'Space Grotesk', Inter, 'IBM Plex Sans', sans-serif",
      color: textColor,
      overflow: 'hidden',
    }}>
      {/* Header: nav + step counter + exit */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px 0',
      }}>
        <button
          onClick={() => goToStep(stepIndex - 1)}
          disabled={isFirstStep || transitioning}
          style={navButtonStyle(accentColor, isFirstStep || transitioning)}
          title="Previous step (Left arrow)"
        >
          &#8592;
        </button>

        <span style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.05em',
          color: secondaryText,
        }}>
          {stepIndex + 1} / {totalSteps}
        </span>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {step.autoAdvanceMs ? (
            <button
              onClick={toggleAutoPlay}
              style={navButtonStyle(accentColor, false)}
              title={autoPlaying ? 'Pause (Space)' : 'Play (Space)'}
            >
              {autoPlaying ? '\u23F8' : '\u25B6'}
            </button>
          ) : null}

          <button
            onClick={() => isLastStep ? handleExit() : goToStep(stepIndex + 1)}
            disabled={transitioning}
            style={navButtonStyle(accentColor, transitioning)}
            title={isLastStep ? 'Finish tour' : 'Next step (Right arrow)'}
          >
            {isLastStep ? '\u2713' : '\u2192'}
          </button>

          <button
            onClick={handleExit}
            style={{
              ...navButtonStyle(accentColor, false),
              fontSize: 16,
              opacity: 0.6,
            }}
            title="Exit tour (Escape)"
          >
            &#215;
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 2,
        margin: '8px 16px 0',
        background: darkMode ? PALETTE.darkMatter : '#e0c99e',
        borderRadius: 1,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${((stepIndex + 1) / totalSteps) * 100}%`,
          background: PALETTE.solarGold,
          borderRadius: 1,
          transition: 'width 300ms cubic-bezier(0.4, 0, 0.2, 1)',
        }} />
      </div>

      {/* Content */}
      <div style={{ padding: '12px 16px 16px' }}>
        <h3 style={{
          fontSize: 15,
          fontWeight: 700,
          margin: '0 0 6px',
          color: textColor,
        }}>
          {step.title}
        </h3>
        <p style={{
          fontSize: 12,
          lineHeight: 1.6,
          margin: 0,
          color: secondaryText,
          whiteSpace: 'pre-wrap',
        }}>
          {step.description}
        </p>
      </div>
    </div>
  );
};

function navButtonStyle(accentColor, disabled) {
  return {
    background: 'none',
    border: `1px solid ${disabled ? 'rgba(128,128,128,0.3)' : accentColor}`,
    color: disabled ? 'rgba(128,128,128,0.5)' : accentColor,
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 14,
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: "'Space Grotesk', Inter, sans-serif",
    transition: 'all 200ms cubic-bezier(0.4, 0, 0.2, 1)',
    opacity: disabled ? 0.4 : 1,
  };
}

export default TourPanel;
