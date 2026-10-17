// High complexity - many state variables, multiple effects, complex JSX
import React, { useState, useEffect, useCallback, useMemo, useReducer, useRef } from 'react';

interface FormField {
  name: string;
  value: string;
  error: string | null;
  touched: boolean;
}

interface FormState {
  fields: Record<string, FormField>;
  isSubmitting: boolean;
  submitError: string | null;
}

type FormAction =
  | { type: 'SET_FIELD'; name: string; value: string }
  | { type: 'SET_ERROR'; name: string; error: string | null }
  | { type: 'SET_TOUCHED'; name: string }
  | { type: 'SUBMIT_START' }
  | { type: 'SUBMIT_SUCCESS' }
  | { type: 'SUBMIT_ERROR'; error: string }
  | { type: 'RESET' };

interface Props {
  initialValues: Record<string, string>;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  onCancel: () => void;
  validateField: (name: string, value: string) => string | null;
  title: string;
  description: string;
  submitLabel: string;
  cancelLabel: string;
  showHelp: boolean;
  autoSave: boolean;
  autoSaveDelay: number;
}

const formReducer = (state: FormState, action: FormAction): FormState => {
  switch (action.type) {
    case 'SET_FIELD':
      return {
        ...state,
        fields: {
          ...state.fields,
          [action.name]: {
            ...state.fields[action.name],
            value: action.value,
          },
        },
      };
    case 'SET_ERROR':
      return {
        ...state,
        fields: {
          ...state.fields,
          [action.name]: {
            ...state.fields[action.name],
            error: action.error,
          },
        },
      };
    case 'SET_TOUCHED':
      return {
        ...state,
        fields: {
          ...state.fields,
          [action.name]: {
            ...state.fields[action.name],
            touched: true,
          },
        },
      };
    case 'SUBMIT_START':
      return { ...state, isSubmitting: true, submitError: null };
    case 'SUBMIT_SUCCESS':
      return { ...state, isSubmitting: false };
    case 'SUBMIT_ERROR':
      return { ...state, isSubmitting: false, submitError: action.error };
    case 'RESET':
      return {
        fields: {},
        isSubmitting: false,
        submitError: null,
      };
    default:
      return state;
  }
};

export const ComplexForm: React.FC<Props> = ({
  initialValues,
  onSubmit,
  onCancel,
  validateField,
  title,
  description,
  submitLabel,
  cancelLabel,
  showHelp,
  autoSave,
  autoSaveDelay,
}) => {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [helpExpanded, setHelpExpanded] = useState(false);
  const [activeSection, setActiveSection] = useState(0);

  const formRef = useRef<HTMLFormElement>(null);
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [state, dispatch] = useReducer(formReducer, {
    fields: Object.entries(initialValues).reduce((acc, [name, value]) => ({
      ...acc,
      [name]: { name, value, error: null, touched: false },
    }), {}),
    isSubmitting: false,
    submitError: null,
  });

  // Initialize form on mount
  useEffect(() => {
    Object.entries(initialValues).forEach(([name, value]) => {
      dispatch({ type: 'SET_FIELD', name, value });
    });
  }, [initialValues]);

  // Auto-save effect
  useEffect(() => {
    if (autoSave && isDirty) {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
      autoSaveTimerRef.current = setTimeout(async () => {
        try {
          const values = Object.fromEntries(
            Object.entries(state.fields).map(([k, v]) => [k, v.value])
          );
          await onSubmit(values);
          setLastSaved(new Date());
          setIsDirty(false);
        } catch (err) {
          console.error('Auto-save failed:', err);
        }
      }, autoSaveDelay);
    }
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [autoSave, isDirty, autoSaveDelay, state.fields, onSubmit]);

  // Warn on unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const handleChange = useCallback((name: string, value: string) => {
    dispatch({ type: 'SET_FIELD', name, value });
    setIsDirty(true);
    const error = validateField(name, value);
    dispatch({ type: 'SET_ERROR', name, error });
  }, [validateField]);

  const handleBlur = useCallback((name: string) => {
    dispatch({ type: 'SET_TOUCHED', name });
  }, []);

  const handleSubmit = async () => {
    dispatch({ type: 'SUBMIT_START' });
    try {
      const values = Object.fromEntries(
        Object.entries(state.fields).map(([k, v]) => [k, v.value])
      );
      await onSubmit(values);
      dispatch({ type: 'SUBMIT_SUCCESS' });
      setIsDirty(false);
    } catch (err) {
      dispatch({ type: 'SUBMIT_ERROR', error: String(err) });
    }
  };

  const hasErrors = useMemo(() => {
    return Object.values(state.fields).some(f => f.error !== null);
  }, [state.fields]);

  const fieldNames = useMemo(() => Object.keys(state.fields), [state.fields]);

  return (
    <form ref={formRef} className="complex-form" onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
      <header className="form-header">
        <h1>{title}</h1>
        <p>{description}</p>
        {lastSaved && (
          <span className="last-saved">
            Last saved: {lastSaved.toLocaleTimeString()}
          </span>
        )}
      </header>

      {showHelp && (
        <section className="help-section">
          <button type="button" onClick={() => setHelpExpanded(!helpExpanded)}>
            {helpExpanded ? 'Hide Help' : 'Show Help'}
          </button>
          {helpExpanded && (
            <div className="help-content">
              <p>Fill out all required fields.</p>
              <p>Press Ctrl+S to save, Escape to cancel.</p>
            </div>
          )}
        </section>
      )}

      <nav className="form-sections">
        <button type="button" className={activeSection === 0 ? 'active' : ''} onClick={() => setActiveSection(0)}>
          Basic Info
        </button>
        <button type="button" className={activeSection === 1 ? 'active' : ''} onClick={() => setActiveSection(1)}>
          Details
        </button>
        <button type="button" className={activeSection === 2 ? 'active' : ''} onClick={() => setActiveSection(2)}>
          Review
        </button>
      </nav>

      <main className="form-content">
        {activeSection === 0 && (
          <section className="basic-info">
            {fieldNames.slice(0, 3).map((name) => (
              <div key={name} className="field-group">
                <label htmlFor={name}>{name}</label>
                <input
                  id={name}
                  type="text"
                  value={state.fields[name]?.value || ''}
                  onChange={(e) => handleChange(name, e.target.value)}
                  onBlur={() => handleBlur(name)}
                />
                {state.fields[name]?.touched && state.fields[name]?.error && (
                  <span className="error">{state.fields[name].error}</span>
                )}
              </div>
            ))}
          </section>
        )}

        {activeSection === 1 && (
          <section className="details">
            {fieldNames.slice(3, 6).map((name) => (
              <div key={name} className="field-group">
                <label htmlFor={name}>{name}</label>
                <textarea
                  id={name}
                  value={state.fields[name]?.value || ''}
                  onChange={(e) => handleChange(name, e.target.value)}
                  onBlur={() => handleBlur(name)}
                />
                {state.fields[name]?.touched && state.fields[name]?.error && (
                  <span className="error">{state.fields[name].error}</span>
                )}
              </div>
            ))}
          </section>
        )}

        {activeSection === 2 && (
          <section className="review">
            <h2>Review Your Submission</h2>
            <ul>
              {Object.entries(state.fields).map(([name, field]) => (
                <li key={name}>
                  <strong>{name}:</strong> {field.value}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="advanced-toggle">
          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}>
            {showAdvanced ? 'Hide Advanced Options' : 'Show Advanced Options'}
          </button>
        </div>

        {showAdvanced && (
          <section className="advanced-options">
            <p>Advanced configuration options would go here.</p>
          </section>
        )}
      </main>

      {state.submitError && (
        <div className="submit-error">
          <span>Error: {state.submitError}</span>
        </div>
      )}

      <footer className="form-footer">
        <button type="button" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="submit" disabled={state.isSubmitting || hasErrors}>
          {state.isSubmitting ? 'Submitting...' : submitLabel}
        </button>
      </footer>
    </form>
  );
};
