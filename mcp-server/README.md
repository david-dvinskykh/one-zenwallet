# One-Zenwallet MCP server

An [MCP](https://modelcontextprotocol.io) server that exposes the same operations as the
One-Zenwallet web app, so an assistant can manage ZenMoney savings goals directly.

It shares the app's logic — goal attribution, targets, hidden-data storage, reminders,
backup/restore all come from `src/utils`, not from a copy — so both surfaces always agree.

## Run it

No clone or build needed — `npx` fetches and starts the server:

```bash
npx -y one-zenwallet-mcp                                  # from npm, once published
npx -y github:david-dvinskykh/one-zenwallet               # straight from the repo
```

The GitHub form builds the bundle during install (`prepare`), so it always runs the
current state of the branch. Add `#branch-name` to pin one.

Register it with an MCP client (Claude Desktop, Claude Code, …):

```json
{
  "mcpServers": {
    "one-zenwallet": {
      "command": "npx",
      "args": ["-y", "one-zenwallet-mcp"],
      "env": { "ZENMONEY_TOKEN": "your-zenmoney-api-token" }
    }
  }
}
```

`ZENMONEY_TOKEN` is optional — `zen_login` can supply the token instead, and a token
stored that way takes precedence.

## Develop it

```bash
npm install --legacy-peer-deps   # also builds the server (prepare script)
npm run mcp:build                # bundles to mcp-server/dist/server.js
npm run mcp:start                # stdio server
npm run mcp:test                 # end-to-end run against a fake ZenMoney API
```

From a checkout, an MCP client can point straight at the bundle:

```json
{
  "mcpServers": {
    "one-zenwallet": {
      "command": "node",
      "args": ["/absolute/path/to/one-zenwallet/mcp-server/dist/server.js"]
    }
  }
}
```

### Publishing

`mcp-server/` is its own npm package. `npm publish ./mcp-server` rebuilds the bundle
(`prepack`) and ships only `dist/server.js` plus this README; the app's sources are
compiled into the bundle. Set a `license` field before the first publish.

## Local state

Mirrors the browser's localStorage + IndexedDB tiers, in
`~/.one-zenwallet-mcp` (override with `ONE_ZENWALLET_MCP_STATE_DIR`):

| File | Contents |
| --- | --- |
| `state.json` | token, selected wallet, server timestamp, pinned goals, unsaved changes (mode 0600) |
| `cache.json` | the ZenMoney snapshot, refreshed incrementally |
| `backups/` | default destination of `zen_create_backup` |

## Tools

### Session
| Tool | What it does |
| --- | --- |
| `zen_login` | Stores a token and pulls a full snapshot |
| `zen_logout` | Clears token, cache and staged changes |
| `zen_status` | Auth, selected wallet, cache counts, unsaved changes |
| `zen_sync` | Incremental (or `full`) sync with ZenMoney |

### Wallets and categories
| Tool | What it does |
| --- | --- |
| `zen_list_wallets` | Accounts grouped by type, with balances |
| `zen_select_wallet` | Picks the wallet all goal tools work on |
| `zen_list_categories` | ZenMoney categories (tags), optionally filtered |

### Goals
| Tool | What it does |
| --- | --- |
| `zen_list_goals` | Saved amount, target, monthly need and reminder per goal |
| `zen_get_goal` | One goal with its attributed transactions |
| `zen_set_goal_target` | Stages a `one_time` / `recurring` / `fixed_monthly` target |
| `zen_pin_goal_category` | Shows a category with no transactions as a goal |
| `zen_unpin_goal_category` | Undoes the above |

### Transactions
| Tool | What it does |
| --- | --- |
| `zen_list_feed` | Wallet feed with goal attribution; filter by goal, text, direction, dates |
| `zen_assign_transactions` | Stages a goal for transactions (or clears it) |
| `zen_suggest_bulk_assignment` | Other unassigned transactions from the same recurring reminder |
| `zen_pending_changes` | Everything staged but not yet pushed |
| `zen_save` | Pushes staged assignments, targets and category changes, then re-syncs |
| `zen_discard_changes` | Drops the staged changes |

### Reminders
| Tool | What it does |
| --- | --- |
| `zen_list_goal_reminders` | Linked, suggested and unlinked monthly reminders |
| `zen_create_goal_reminder` | Monthly transfer or income reminder funding a goal |
| `zen_update_goal_reminder` | Changes amount, day of month or source account |
| `zen_delete_goal_reminder` | Deletes it — or only unlinks a display-only transfer link |
| `zen_link_goal_reminder` | Associates an existing reminder with a goal |

### Backup
| Tool | What it does |
| --- | --- |
| `zen_create_backup` | Writes a full snapshot to a JSON file |
| `zen_restore_backup` | Re-uploads a backup. Destructive, requires `confirm: true` |

## Behaviour worth knowing

- **Staged vs immediate.** Assignments, targets and category changes are staged locally
  until `zen_save`, exactly like the app's "Save Data" button. Reminder and backup tools
  write to ZenMoney immediately.
- **Transfers cannot carry a category** in ZenMoney, so assigning one is recorded in the
  app's own map instead; other transactions get their real category changed.
- **Where the app's data lives.** Manual assignments, targets and goal↔reminder links are
  stored inside ZenMoney in a hidden archived account named `[One-Zenwallet Data]`, so the
  MCP server and the web app see the same state without any backend.
- **Category and account arguments** accept either an id or an exact title.
