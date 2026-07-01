# pi-thinking-prune

Pi coding-agent extension that mirrors the `pi-context-prune` pattern, but targets assistant `thinking` blocks instead of `toolResult` messages.

It keeps the session JSONL file intact. Pruning only changes future LLM context through Pi's `context` event.

## What it does

1. Detects assistant message content blocks where `type === "thinking"`.
2. Stores the original full thinking text in a persistent local index.
3. Summarizes the thinking blocks with a configured model.
4. Appends a hidden `thinking-prune-summary` custom message that participates in LLM context.
5. Removes indexed raw thinking blocks from future context windows.
6. Registers `thinking_tree_query` so the agent can recover originals by short refs like `th1`.

Before pruning:

```json
{
  "role": "assistant",
  "content": [
    { "type": "thinking", "thinking": "raw reasoning..." },
    { "type": "text", "text": "visible answer" }
  ]
}
```

Future context after pruning:

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "visible answer" }
  ]
}
```

The model also sees a hidden summary message with refs:

```text
Summarized thinking refs: `th1`, `th2`
Use `thinking_tree_query` with these refs to retrieve the original full thinking blocks.
```

## Install

Local validation:

```bash
pi install -l /path/to/pi-thinking-prune
```

From GitHub:

```bash
pi install -l git:github.com/ch0udry/pi-thinking-prune
```

Try without installing:

```bash
pi -e /path/to/pi-thinking-prune
```

## Commands

```text
/thinking-pruner status
/thinking-pruner on
/thinking-pruner off
/thinking-pruner now
/thinking-pruner model [default|provider/model-id]
/thinking-pruner thinking [default|off|minimal|low|medium|high|xhigh]
/thinking-pruner prune-on [every-turn|on-demand|agent-message]
/thinking-pruner batching [turn|agent-message]
/thinking-pruner stats
/thinking-pruner help
```

## Tool

### `thinking_tree_query`

Retrieves original thinking blocks that were summarized and pruned.

Input:

```json
{
  "thinkingIds": ["th1", "th2"]
}
```

## Configuration

Stored globally at:

```text
~/.pi/agent/thinking-prune/settings.json
```

Default:

```json
{
  "enabled": false,
  "showStatusLine": true,
  "summarizerModel": "default",
  "summarizerThinking": "off",
  "pruneOn": "agent-message",
  "batchingMode": "turn",
  "minRawCharsToPrune": 0,
  "skipOversizedSummary": true
}
```

`skipOversizedSummary` defaults to `true`, matching `pi-context-prune`: if a generated summary is larger than the raw thinking it would replace, the extension skips indexing/pruning that batch and advances a local `thinking-prune-frontier` so it is not summarized repeatedly.
`enabled` defaults to `false` for safety. Run:

```text
/thinking-pruner on
```

## Trigger modes

| Mode | Meaning |
|---|---|
| `agent-message` | Summarize/prune when the agent sends a final assistant text response. Recommended default. |
| `every-turn` | Summarize/prune after every assistant message with thinking. Useful for testing. |
| `on-demand` | Never auto-prune. Use `/thinking-pruner now`. |

## Privacy note

Raw thinking is sent once to the configured summarizer model. Future main-model calls receive only the summary plus visible assistant text.

For local-only summarization, set:

```json
{
  "summarizerModel": "local-provider/model-id"
}
```

## Development

```bash
npm install
npm test
npm run check
```

## Relation to pi-context-prune

`pi-context-prune` prunes entire `toolResult` messages.

`pi-thinking-prune` prunes only thinking blocks inside assistant messages and keeps assistant text/tool calls intact.
