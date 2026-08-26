/**
 * Runtime module for Triggered Projection
 *
 * Connects Dendro to running React Native apps via the React DevTools protocol.
 *
 * @see .dev/research/SESSION-13-RUNTIME-CONNECTION-RESEARCH.md
 * @see .dev/tickets/TICKET-030-live-runtime-integration.md
 */

export {
  DevToolsConnector,
  getDevToolsConnector,
  resetDevToolsConnector,
} from './devtools-connector';

export { SourceMapper } from './source-mapper';

export {
  writeRuntimeState,
  clearRuntimeState,
  readRuntimeState,
} from './runtime-state-file';

export type {
  ConnectionStatus,
  RuntimeComponent,
  RuntimeTree,
  InspectedElement,
  HookInfo,
  DevToolsConnectorConfig,
  DevToolsConnectorEvents,
  RuntimeStateSnapshot,
  SerializedRuntimeComponent,
} from './types';
