# pi-thinking-prune

Pi extension package. Keep session JSONL untouched; pruning must happen only through the Pi `context` event. Persist original thinking blocks with custom entries and inject compact hidden summaries with custom message entries.

Do not register `context_tree_query`; that belongs to pi-context-prune. This package registers `thinking_tree_query`.
