/**
 * DevTools Connector - Connects to React Native apps via React DevTools protocol
 *
 * Uses react-devtools-core to properly handle the protocol handshake and tree data.
 *
 * @see .dev/research/SESSION-13-RUNTIME-CONNECTION-RESEARCH.md
 */

import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import type {
  ConnectionStatus,
  RuntimeComponent,
  RuntimeTree,
  InspectedElement,
  DevToolsConnectorConfig,
} from './types';
import {
  TREE_OPERATION_ADD,
  TREE_OPERATION_REMOVE,
  TREE_OPERATION_REORDER_CHILDREN,
  TREE_OPERATION_UPDATE_TREE_BASE_DURATION,
  TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS,
  TREE_OPERATION_REMOVE_ROOT,
  TREE_OPERATION_SET_SUBTREE_MODE,
  SUSPENSE_TREE_OPERATION_ADD,
  SUSPENSE_TREE_OPERATION_REMOVE,
  SUSPENSE_TREE_OPERATION_REORDER_CHILDREN,
  SUSPENSE_TREE_OPERATION_RESIZE,
  SUSPENSE_TREE_OPERATION_SUSPENDERS,
  ElementTypeRoot,
  ElementTypeClass,
  ElementTypeFunction,
  ElementTypeHostComponent,
} from './types';

// Dynamic imports
let WebSocketServer: typeof import('ws').WebSocketServer;
let WebSocket: typeof import('ws').WebSocket;

/**
 * DevToolsConnector manages the connection between Dendro and a running RN app
 */
export class DevToolsConnector extends EventEmitter {
  private config: DevToolsConnectorConfig;
  private wss: InstanceType<typeof WebSocketServer> | null = null;
  private socket: InstanceType<typeof WebSocket> | null = null;
  private _status: ConnectionStatus = 'disconnected';
  private tree: RuntimeTree;
  private pendingInspections: Map<number, (element: InspectedElement | null) => void> = new Map();
  private messageListeners: ((event: string, payload: unknown) => void)[] = [];
  private rootIDToRendererID: Map<number, number> = new Map();

  // Connection resilience
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private missedPongs: number = 0;
  private restartAttempts: number = 0;
  private maxRestartAttempts: number = 5;
  private restartTimeout: ReturnType<typeof setTimeout> | null = null;
  private isAlive: boolean = false;
  private _stopped: boolean = false; // true when user explicitly stops
  private _lastErrorMessage: string = ''; // dedup error emissions

  // Android emulator support
  private adbReversed: boolean = false;

  constructor(config: Partial<DevToolsConnectorConfig> = {}) {
    super();
    this.config = {
      port: config.port ?? 8097,
      host: config.host ?? 'localhost',
    };
    this.tree = {
      roots: [],
      elements: new Map(),
      rendererVersion: null,
    };
  }

  /**
   * Current connection status
   */
  get status(): ConnectionStatus {
    return this._status;
  }

  /**
   * Current component tree
   */
  get componentTree(): RuntimeTree {
    return this.tree;
  }

  /**
   * Start the WebSocket server and listen for RN app connections
   */
  async start(): Promise<void> {
    if (this.wss) {
      console.log('DevToolsConnector: Server already running');
      return;
    }

    this._stopped = false;

    try {
      // Dynamically import ws
      const ws = await import('ws');
      WebSocketServer = ws.WebSocketServer;
      WebSocket = ws.WebSocket;
    } catch (error) {
      console.error('DevToolsConnector: Failed to import ws module:', error);
      this.emitError(new Error('WebSocket module not available'));
      return;
    }

    try {
      this.wss = new WebSocketServer({
        port: this.config.port,
        host: this.config.host,
      });

      // Only reset backoff counters when the port actually binds successfully.
      // EADDRINUSE fires asynchronously after the constructor returns, so
      // resetting here would defeat the backoff and dedup logic.
      this.wss.on('listening', () => {
        this.restartAttempts = 0;
        this._lastErrorMessage = '';
        this.setStatus('listening');
        console.log(`DevToolsConnector: Listening on ws://${this.config.host}:${this.config.port}`);
      });

      this.wss.on('connection', (socket) => this.handleConnection(socket));
      this.wss.on('error', (error) => {
        this.emitError(error);
        this.scheduleRestart();
      });
      this.wss.on('close', () => {
        if (!this._stopped) {
          this.scheduleRestart();
        }
      });
    } catch (error) {
      console.error('DevToolsConnector: Failed to start server:', error);
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      this.scheduleRestart();
    }
  }

  /**
   * Schedule a server restart with exponential backoff.
   * Backoff: 1s, 2s, 4s, 8s, 16s, max 30s. Gives up after maxRestartAttempts.
   */
  private scheduleRestart(): void {
    if (this._stopped || this.restartTimeout) return;

    if (this.restartAttempts >= this.maxRestartAttempts) {
      console.log(`DevToolsConnector: Max restart attempts (${this.maxRestartAttempts}) reached, giving up`);
      this.setStatus('disconnected');
      this.emit('max-retries-exhausted', this.restartAttempts);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.restartAttempts), 30000);
    this.restartAttempts++;

    console.log(`DevToolsConnector: Scheduling restart in ${delay}ms (attempt ${this.restartAttempts}/${this.maxRestartAttempts})`);

    this.restartTimeout = setTimeout(async () => {
      this.restartTimeout = null;
      if (this._stopped) return;

      // Clean up old server
      if (this.wss) {
        try {
          this.wss.close();
        } catch { /* ignore */ }
        this.wss = null;
      }

      console.log(`DevToolsConnector: Attempting restart (attempt ${this.restartAttempts}/${this.maxRestartAttempts})`);
      await this.start();
    }, delay);
  }

  /**
   * Set up ADB reverse tunnel for Android emulator.
   * Silently succeeds if adb is not found (auto mode).
   */
  async setupAdbReverse(silent: boolean = false): Promise<boolean> {
    if (this.adbReversed) return true;

    const port = String(Math.floor(this.config.port));

    return new Promise((resolve) => {
      execFile('adb', ['reverse', `tcp:${port}`, `tcp:${port}`], (error, stdout, stderr) => {
        if (error) {
          if (!silent) {
            console.error('DevToolsConnector: ADB reverse failed:', error.message);
            this.emitError(new Error(`ADB reverse failed: ${error.message}. Is adb installed and an emulator running?`));
          } else {
            console.log('DevToolsConnector: ADB not available (silent mode, this is OK for iOS)');
          }
          resolve(false);
        } else {
          this.adbReversed = true;
          console.log(`DevToolsConnector: ADB reverse tunnel set up on port ${port}`);
          resolve(true);
        }
      });
    });
  }

  /**
   * Remove ADB reverse tunnel.
   */
  async removeAdbReverse(): Promise<void> {
    if (!this.adbReversed) return;

    const port = String(Math.floor(this.config.port));

    return new Promise((resolve) => {
      execFile('adb', ['reverse', '--remove', `tcp:${port}`], () => {
        this.adbReversed = false;
        resolve();
      });
    });
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    this._stopped = true;

    // Clear heartbeat
    this.stopHeartbeat();

    // Clear restart timer
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    // Clean up ADB tunnel
    await this.removeAdbReverse();

    this.setStatus('disconnected');
    console.log('DevToolsConnector: Stopped');
  }

  /**
   * Start WebSocket ping/pong heartbeat to detect stale connections.
   * Sends ping every 30s. If 2 pongs are missed, force-disconnects.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedPongs = 0;
    this.isAlive = true;

    this.heartbeatInterval = setInterval(() => {
      if (!this.socket) {
        this.stopHeartbeat();
        return;
      }

      if (!this.isAlive) {
        this.missedPongs++;
        console.log(`DevToolsConnector: Missed pong (${this.missedPongs}/2)`);

        if (this.missedPongs >= 2) {
          console.log('DevToolsConnector: Connection stale (2 missed pongs), disconnecting');
          this.socket.terminate();
          this.stopHeartbeat();
          return;
        }
      }

      this.isAlive = false;
      try {
        this.socket.ping();
      } catch {
        // Socket might already be closing
      }
    }, 30000);
  }

  /**
   * Stop the heartbeat interval.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.missedPongs = 0;
  }

  /**
   * Request inspection of a specific element
   */
  async inspectElement(id: number): Promise<InspectedElement | null> {
    if (!this.socket || this._status !== 'connected') {
      console.log('DevToolsConnector: Cannot inspect - not connected');
      return null;
    }

    // Find the renderer ID for this element
    const rendererID = this.findRendererIDForElement(id);

    return new Promise((resolve) => {
      this.pendingInspections.set(id, resolve);

      this.send('inspectElement', {
        id,
        rendererID,
        forceUpdate: true,
        path: null,
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.pendingInspections.has(id)) {
          this.pendingInspections.delete(id);
          resolve(null);
        }
      }, 5000);
    });
  }

  /**
   * Find the renderer ID for a given element by traversing to its root
   */
  private findRendererIDForElement(elementId: number): number {
    // First check if this element is itself a root
    if (this.rootIDToRendererID.has(elementId)) {
      return this.rootIDToRendererID.get(elementId) ?? 1;
    }

    // Traverse up to find the root
    let currentId = elementId;
    const visited = new Set<number>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const element = this.tree.elements.get(currentId);
      if (!element) break;

      // Check if parent is a root
      if (element.parentId !== null) {
        if (this.rootIDToRendererID.has(element.parentId)) {
          return this.rootIDToRendererID.get(element.parentId) ?? 1;
        }
        currentId = element.parentId;
      } else {
        // No parent, check if current is tracked as root
        for (const rootId of this.tree.roots) {
          if (this.isInSubtree(elementId, rootId)) {
            return this.rootIDToRendererID.get(rootId) ?? 1;
          }
        }
        break;
      }
    }

    // Default to renderer ID 1 if not found
    return this.rootIDToRendererID.values().next().value ?? 1;
  }

  /**
   * Check if an element is in a subtree rooted at rootId
   */
  private isInSubtree(elementId: number, rootId: number): boolean {
    if (elementId === rootId) return true;

    const root = this.tree.elements.get(rootId);
    if (!root) return false;

    const queue = [...root.children];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (id === elementId) return true;
      const element = this.tree.elements.get(id);
      if (element) {
        queue.push(...element.children);
      }
    }
    return false;
  }

  /**
   * Override a value at a path on a component (props, state, hooks, context).
   * Sends the overrideValueAtPath event through the WebSocket to the app's
   * React DevTools backend, which modifies the component at runtime.
   */
  overrideValueAtPath(
    id: number,
    type: 'props' | 'state' | 'hooks' | 'context',
    path: string[],
    value: unknown,
    hookID?: number
  ): boolean {
    if (!this.socket || this._status !== 'connected') {
      console.log('DevToolsConnector: Cannot override - not connected');
      return false;
    }

    const rendererID = this.findRendererIDForElement(id);

    this.send('overrideValueAtPath', {
      id,
      hookID: hookID ?? null,
      path,
      rendererID,
      type,
      value,
    });

    console.log(`DevToolsConnector: Sent overrideValueAtPath for element ${id}, type=${type}, path=[${path.join('.')}]`);
    return true;
  }

  /**
   * Get flat list of all components
   */
  getAllComponents(): RuntimeComponent[] {
    return Array.from(this.tree.elements.values());
  }

  /**
   * Get component by ID
   */
  getComponent(id: number): RuntimeComponent | undefined {
    return this.tree.elements.get(id);
  }

  /**
   * Build hierarchical tree from flat element map
   */
  getTreeHierarchy(): RuntimeComponent[] {
    const roots: RuntimeComponent[] = [];
    for (const rootId of this.tree.roots) {
      const root = this.tree.elements.get(rootId);
      if (root) {
        roots.push(root);
      }
    }
    return roots;
  }

  // --- Private Methods ---

  private handleConnection(socket: InstanceType<typeof WebSocket>): void {
    console.log('DevToolsConnector: App connected');

    // Close any existing connection
    if (this.socket) {
      this.stopHeartbeat();
      this.socket.close();
    }

    this.socket = socket;
    this.restartAttempts = 0; // Reset backoff on successful connection
    this._lastErrorMessage = ''; // Reset error dedup on new connection
    this.setStatus('connected');

    // Reset tree on new connection
    this.tree = {
      roots: [],
      elements: new Map(),
      rendererVersion: null,
    };
    this.messageListeners = [];
    this.rootIDToRendererID.clear();

    // Reject any pending inspections from previous connection
    for (const [, resolve] of this.pendingInspections) {
      resolve(null);
    }
    this.pendingInspections.clear();

    // Start heartbeat monitoring
    this.startHeartbeat();

    // Listen for pong responses (heartbeat)
    socket.on('pong', () => {
      this.isAlive = true;
      this.missedPongs = 0;
    });

    // Create a "wall" for react-devtools protocol
    // The wall is the communication layer between frontend and backend
    const wall = {
      listen: (fn: (msg: { event: string; payload: unknown }) => void) => {
        this.messageListeners.push((event, payload) => fn({ event, payload }));
      },
      send: (event: string, payload: unknown) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ event, payload }));
        }
      },
    };

    // Handle incoming messages
    socket.on('message', (data) => {
      const raw = data.toString();

      try {
        const message = JSON.parse(raw);
        const event = message.event;
        const payload = message.payload;

        if (event) {
          // Notify all listeners (for react-devtools bridge)
          this.messageListeners.forEach(fn => fn(event, payload));

          // Handle specific events ourselves
          this.handleEvent(event, payload);
        }
      } catch (error) {
        console.error('DevToolsConnector: Failed to parse message:', error);
      }
    });

    socket.on('close', () => {
      console.log('DevToolsConnector: App disconnected');
      this.stopHeartbeat();
      this.socket = null;
      this.setStatus('listening');
    });

    socket.on('error', (error) => {
      console.error('DevToolsConnector: Socket error:', error);
      this.emitError(error);
    });

    // Send initial handshake - tell the backend we're ready
    wall.send('getBridgeProtocol', null);
    // Operations arrive automatically from the app as React renders — no request needed
  }

  private handleEvent(event: string, payload: unknown): void {
    switch (event) {
      case 'operations':
        console.log(`DevToolsConnector: Received 'operations' event, payload type: ${typeof payload}, isArray: ${Array.isArray(payload)}, length: ${Array.isArray(payload) ? payload.length : 'N/A'}`);
        this.handleOperations(payload as number[]);
        break;

      case 'inspectedElement':
        this.handleInspectedElement(payload as InspectedElement);
        break;

      case 'bridgeProtocol':
        console.log('DevToolsConnector: Bridge protocol version:', payload);
        break;

      case 'shutdown':
        console.log('DevToolsConnector: Received shutdown from app');
        break;

      default:
        console.log(`DevToolsConnector: Unhandled event: ${event}`,
          typeof payload === 'object' ? JSON.stringify(payload).substring(0, 100) : payload);
    }
  }

  /**
   * Parse and apply operations array from React DevTools protocol
   *
   * Operations array format:
   * [rendererID, rootID, stringTableByteLength, ...stringTableData, ...operations]
   *
   * String table format: [len1, char1, char2, ..., len2, char1, char2, ...]
   * Strings are 1-indexed (index 0 = null)
   *
   * @see https://github.com/facebook/react/blob/main/packages/react-devtools-shared/src/backend/renderer.js
   */
  private handleOperations(operations: number[]): void {
    if (!operations || !Array.isArray(operations)) {
      console.error('DevToolsConnector: Invalid operations - not an array');
      return;
    }

    if (operations.length < 3) {
      console.error('DevToolsConnector: Operations too short:', operations.length);
      return;
    }

    let i = 0;
    const rendererID = operations[i++];
    const rootID = operations[i++];

    // Track renderer ID for this root (for inspectElement)
    if (rootID > 0 && rendererID > 0) {
      this.rootIDToRendererID.set(rootID, rendererID);
    }

    // Read string table
    // stringTableSize is the TOTAL BYTE LENGTH of string data, not count of strings
    const stringTableSize = operations[i++];
    const stringTableEnd = i + stringTableSize;

    // String table is 1-indexed (index 0 = null)
    const stringTable: Array<string | null> = [null];

    while (i < stringTableEnd && i < operations.length) {
      const strLength = operations[i++];
      if (strLength === undefined || strLength < 0) {
        console.warn('DevToolsConnector: Invalid string length at index', i - 1);
        break;
      }
      let str = '';
      for (let k = 0; k < strLength && i < operations.length; k++) {
        str += String.fromCharCode(operations[i++]);
      }
      stringTable.push(str);
    }

    // Ensure we're at the right position after string table
    i = stringTableEnd;

    // Process operations
    let addedCount = 0;
    let removedCount = 0;

    while (i < operations.length) {
      const opCode = operations[i++];

      if (opCode === TREE_OPERATION_ADD) {
        const id = operations[i++];
        const type = operations[i++];

        // Root nodes (type 11) have a different payload format
        if (type === ElementTypeRoot) {
          // Root payload (v7): [isStrictMode, profilingFlags, isProductionBuild, hasOwnerMetadata]
          const _isStrictMode = operations[i++];
          const _profilingFlags = operations[i++];
          const _isProductionBuild = operations[i++];
          const _hasOwnerMetadata = operations[i++];

          // Create a root placeholder element
          const component: RuntimeComponent = {
            id,
            displayName: `Root`,
            type: 'other',
            key: null,
            parentId: null,
            children: [],
            depth: 0,
          };

          this.tree.elements.set(id, component);

          // Add to roots if not already there
          if (!this.tree.roots.includes(id)) {
            this.tree.roots.push(id);
          }

          // Track renderer ID for this root
          this.rootIDToRendererID.set(id, rendererID);

          addedCount++;

        } else {
          // Regular element (v7): [parentId, ownerId, displayNameStringId, keyStringId, namePropStringId]
          const parentId = operations[i++];
          const _ownerID = operations[i++];
          const displayNameId = operations[i++];
          const keyId = operations[i++];
          const _namePropId = operations[i++]; // v7: Suspense/Activity name prop

          // Get display name from string table (1-indexed)
          const displayName = (displayNameId > 0 && displayNameId < stringTable.length)
            ? stringTable[displayNameId] || `Component_${id}`
            : `Component_${id}`;

          // Get key from string table if present
          const key = (keyId > 0 && keyId < stringTable.length)
            ? stringTable[keyId] || null
            : null;

          // Map element type to our simplified type
          let componentType: 'function' | 'class' | 'host' | 'other';
          if (type === ElementTypeClass) {
            componentType = 'class';
          } else if (type === ElementTypeFunction) {
            componentType = 'function';
          } else if (type === ElementTypeHostComponent) {
            componentType = 'host';
          } else {
            componentType = 'other';
          }

          const component: RuntimeComponent = {
            id,
            displayName,
            type: componentType,
            key,
            parentId: parentId > 0 ? parentId : null,
            children: [],
            depth: 0,
          };

          // Calculate depth and add to parent's children
          if (parentId > 0) {
            const parent = this.tree.elements.get(parentId);
            if (parent) {
              component.depth = parent.depth + 1;
              if (!parent.children.includes(id)) {
                parent.children.push(id);
              }
            }
          }

          this.tree.elements.set(id, component);
          addedCount++;
        }

      } else if (opCode === TREE_OPERATION_REMOVE) {
        const removeCount = operations[i++];
        for (let j = 0; j < removeCount; j++) {
          const id = operations[i++];
          const element = this.tree.elements.get(id);
          if (element && element.parentId !== null) {
            const parent = this.tree.elements.get(element.parentId);
            if (parent) {
              parent.children = parent.children.filter(childId => childId !== id);
            }
          }
          this.tree.elements.delete(id);
          removedCount++;
        }

      } else if (opCode === TREE_OPERATION_REORDER_CHILDREN) {
        const parentId = operations[i++];
        const numChildren = operations[i++];
        const children: number[] = [];
        for (let j = 0; j < numChildren; j++) {
          children.push(operations[i++]);
        }
        const parent = this.tree.elements.get(parentId);
        if (parent) {
          parent.children = children;
        }

      } else if (opCode === TREE_OPERATION_UPDATE_TREE_BASE_DURATION) {
        // Profiling data - skip 2 values: [fiberId, duration]
        i += 2;

      } else if (opCode === TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS) {
        // Error/warning counts - skip 3 values: [fiberId, errorCount, warningCount]
        const _fiberId = operations[i++];
        const _errorCount = operations[i++];
        const _warningCount = operations[i++];

      } else if (opCode === TREE_OPERATION_REMOVE_ROOT) {
        // Remove root - the rootID from header is the one being removed
        const index = this.tree.roots.indexOf(rootID);
        if (index > -1) {
          this.tree.roots.splice(index, 1);
        }
        this.rootIDToRendererID.delete(rootID);

      } else if (opCode === TREE_OPERATION_SET_SUBTREE_MODE) {
        // Subtree mode (StrictMode, etc.) - skip 2 values: [subtreeRootId, mode]
        i += 2;

      } else if (opCode === SUSPENSE_TREE_OPERATION_ADD) {
        // v7 Suspense: [fiberID, parentID, nameStringID, isSuspended, numRects, ...rects]
        const _fiberID = operations[i++];
        const _parentID = operations[i++];
        const _nameStringID = operations[i++];
        const _isSuspended = operations[i++];
        const numRects = operations[i++];
        if (numRects !== -1) {
          i += numRects * 4; // each rect: x, y, width, height
        }

      } else if (opCode === SUSPENSE_TREE_OPERATION_REMOVE) {
        // v7 Suspense remove: [removeLength, ...ids]
        const removeLength = operations[i++];
        i += removeLength;

      } else if (opCode === SUSPENSE_TREE_OPERATION_REORDER_CHILDREN) {
        // v7 Suspense reorder: [parentId, numChildren, ...childIds]
        const _parentId = operations[i++];
        const numChildren = operations[i++];
        i += numChildren;

      } else if (opCode === SUSPENSE_TREE_OPERATION_RESIZE) {
        // v7 Suspense resize: [id, numRects, ...rects]
        const _id = operations[i++];
        const numRects = operations[i++];
        if (numRects !== -1) {
          i += numRects * 4;
        }

      } else if (opCode === SUSPENSE_TREE_OPERATION_SUSPENDERS) {
        // v7 Suspense suspenders: [changeLength, ...changes]
        const changeLength = operations[i++];
        for (let j = 0; j < changeLength; j++) {
          i++; // id
          i++; // hasUniqueSuspenders
          i++; // isSuspended
          const envNamesLength = operations[i++];
          i += envNamesLength;
        }

      } else {
        // Unknown operation - log and try to continue
        console.warn('DevToolsConnector: Unknown op code:', opCode, 'at index:', i - 1, '- stopping parse');
        break;
      }
    }

    console.log(`DevToolsConnector: Tree update — ${this.tree.elements.size} components, ${this.tree.roots.length} roots (+${addedCount}/-${removedCount}), rootIDs: [${this.tree.roots.join(', ')}]`);

    // Rebuild parent-child relationships (in case children arrived before parents)
    for (const [id, component] of this.tree.elements) {
      if (component.parentId !== null) {
        const parent = this.tree.elements.get(component.parentId);
        if (parent && !parent.children.includes(id)) {
          parent.children.push(id);
          component.depth = parent.depth + 1;
        }
      }
    }

    // Emit tree update event
    this.emit('tree-update', this.tree);
  }

  private handleInspectedElement(payload: InspectedElement): void {
    const resolve = this.pendingInspections.get(payload.id);
    if (resolve) {
      this.pendingInspections.delete(payload.id);
      resolve(payload);
    }
    this.emit('element-inspected', payload);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status !== status) {
      this._status = status;
      this.emit('status-change', status);
    }
  }

  private send(event: string, payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ event, payload }));
    }
  }

  private emitError(error: Error): void {
    // Deduplicate: don't emit the same error message back-to-back
    // (prevents toast spam on repeated EADDRINUSE retries)
    if (error.message === this._lastErrorMessage) return;
    this._lastErrorMessage = error.message;
    this.emit('error', error);
  }
}

// Singleton instance for the extension
let connectorInstance: DevToolsConnector | null = null;

/**
 * Get the singleton DevToolsConnector instance
 */
export function getDevToolsConnector(): DevToolsConnector {
  if (!connectorInstance) {
    connectorInstance = new DevToolsConnector();
  }
  return connectorInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetDevToolsConnector(): void {
  if (connectorInstance) {
    connectorInstance.stop();
    connectorInstance = null;
  }
}
