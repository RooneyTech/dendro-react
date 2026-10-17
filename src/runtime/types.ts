/**
 * Runtime connection types for Triggered Projection
 *
 * These types define the interface between Dendro and a running React Native app
 * via the React DevTools protocol.
 */

/**
 * Connection status for the runtime connector
 */
export type ConnectionStatus = 'disconnected' | 'listening' | 'connected';

/**
 * A component in the live runtime tree
 */
export interface RuntimeComponent {
  id: number;
  displayName: string;
  type: 'function' | 'class' | 'host' | 'other';
  key: string | null;
  parentId: number | null;
  children: number[];
  depth: number;
}

/**
 * Inspected element details (props, state, hooks)
 */
export interface InspectedElement {
  id: number;
  displayName: string;
  props: Record<string, unknown>;
  state: Record<string, unknown> | null;
  hooks: HookInfo[] | null;
  context: Record<string, unknown> | null;
}

/**
 * Hook information from inspected element
 */
export interface HookInfo {
  id: number;
  name: string;
  value: unknown;
  subHooks: HookInfo[];
}

/**
 * The full runtime tree state
 */
export interface RuntimeTree {
  roots: number[];
  elements: Map<number, RuntimeComponent>;
  rendererVersion: string | null;
}

/**
 * Events emitted by the DevTools connector
 */
export interface DevToolsConnectorEvents {
  'status-change': (status: ConnectionStatus) => void;
  'tree-update': (tree: RuntimeTree) => void;
  'element-inspected': (element: InspectedElement) => void;
  'error': (error: Error) => void;
}

/**
 * Configuration for the DevTools connector
 */
export interface DevToolsConnectorConfig {
  port: number;
  host: string;
}

/**
 * Message from React DevTools backend
 */
export interface DevToolsMessage {
  event: string;
  payload: unknown;
}

/**
 * React DevTools operation codes
 * From: https://github.com/facebook/react/blob/main/packages/react-devtools-shared/src/backend/renderer.js
 */
export const TREE_OPERATION_ADD = 1;
export const TREE_OPERATION_REMOVE = 2;
export const TREE_OPERATION_REORDER_CHILDREN = 3;
export const TREE_OPERATION_UPDATE_TREE_BASE_DURATION = 4;
export const TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS = 5;
export const TREE_OPERATION_REMOVE_ROOT = 6;
export const TREE_OPERATION_SET_SUBTREE_MODE = 7;
export const SUSPENSE_TREE_OPERATION_ADD = 8;
export const SUSPENSE_TREE_OPERATION_REMOVE = 9;
export const SUSPENSE_TREE_OPERATION_REORDER_CHILDREN = 10;
export const SUSPENSE_TREE_OPERATION_RESIZE = 11;
export const SUSPENSE_TREE_OPERATION_SUSPENDERS = 12;

/**
 * Element types in React DevTools
 */
export const ElementTypeClass = 1;
export const ElementTypeContext = 2;
export const ElementTypeFunction = 5;
export const ElementTypeForwardRef = 6;
export const ElementTypeHostComponent = 7;
export const ElementTypeMemo = 8;
export const ElementTypeOtherOrUnknown = 9;
export const ElementTypeProfiler = 10;
export const ElementTypeRoot = 11;
export const ElementTypeSuspense = 12;
export const ElementTypeSuspenseList = 13;

/**
 * Serialized version of RuntimeComponent for JSON persistence.
 * Used in the cross-process runtime state bridge (~/.dendro/runtime-state.json).
 */
export interface SerializedRuntimeComponent {
  id: number;
  displayName: string;
  type: 'function' | 'class' | 'host' | 'other';
  key: string | null;
  parentId: number | null;
  children: number[];
  depth: number;
  sourceFilePath?: string;
}

/**
 * Runtime state snapshot written to disk for MCP server to read.
 * Extension writes this on every tree-update (debounced 500ms).
 * MCP server reads it for runtime tools.
 */
export interface RuntimeStateSnapshot {
  status: 'connected' | 'disconnected';
  timestamp: number;
  componentCount: number;
  roots: number[];
  elements: SerializedRuntimeComponent[];
  sourceMap: Record<string, string>;
}
