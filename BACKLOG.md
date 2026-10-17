# Dendro Backlog

## Fixed (Session 57)

### ~~Highlight label text clips behind child nodes~~ — FIXED
Moved highlight labels from individual node groups to a separate top-level SVG layer rendered after all nodes. Labels now include a background pill for readability and always render above child nodes.

### ~~Annotations (`visualize_annotate`) not rendering~~ — FIXED
Added explicit inline styles for all annotation visual properties (rect fill/stroke/corners, line stroke, text fill/font). Previously relied on CSS class selectors which could fail in the webview context.

### ~~`visualize_highlight` silently succeeds when nodes aren't in the tree~~ — FIXED
Changed `highlightedCount` → `requestedCount` in MCP tool response with an explanatory `note` field. Webview now logs warnings with available node names when highlights target nodes not in the tree. Command queue relays actual results via postMessage for diagnostics.
