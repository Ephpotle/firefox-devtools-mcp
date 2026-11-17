# Zen Browser and uBlock Origin tools (the `zen-tools` branch)

This branch of a fork of [mozilla/firefox-devtools-mcp](https://github.com/mozilla/firefox-devtools-mcp) adds tools for [Zen Browser](https://zen-browser.app). It is unofficial: not made or endorsed by Mozilla, the Zen Browser team or the uBlock Origin project. It exists mainly as the optional companion of [Claude for Zen](https://github.com/Ephpotle/claude-for-zen), but works with any MCP client.

All of these run in Zen's privileged browser window, because a WebExtension cannot reach Spaces, split views or another add-on.

| Tools                                                                                                                                                           | What they do                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `zen_list_spaces`, `zen_list_tabs`                                                                                                                              | List Spaces (workspaces), folders and tabs, including unloaded tabs               |
| `zen_create_space`, `zen_move_tabs`, `zen_move_to_folder`, `zen_close_tabs`                                                                                     | Reorganise tabs; closing archives the tabs to a file first and supports a dry run |
| `zen_view`, `zen_split_view`, `zen_unsplit_view`                                                                                                                | See what shares the screen (split view, Glance) and open or end split views       |
| `ublock_status`, `ublock_list_filters`                                                                                                                          | What uBlock Origin is doing on a tab; the lines in "My filters"                   |
| `ublock_set_switch`, `ublock_set_rule`, `ublock_set_advanced_mode`, `ublock_keep_changes`, `ublock_undo_changes`, `ublock_add_filters`, `ublock_remove_filters` | Tune uBlock Origin for the site in a tab                                          |

They are in `src/tools/zen.ts`, `src/tools/zen-view.ts` and `src/tools/ublock.ts`, and are selected with `--tool-preset zen`.

## Build

```
npm ci
npm run build:moz      # writes dist.moz/index.js
```

## Use

Zen has to be started with remote control on. That lets any program on the computer drive the browser (two local ports, no password) and lets websites detect that it is automatable, so start Zen normally when you do not need this.

```
set MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1
zen.exe --marionette --remote-debugging-port 9222
```

Setting the pref `remote.prefs.recommended` to `false` in the profile is recommended; without it a remote-control start switches off things like password saving and add-on updates for that session.

Then attach to the running browser:

```
node dist.moz/index.js --connect-existing --marionette-port 2828 --tool-preset zen
```

Only one client can hold the connection at a time.

Set `ZEN_TOOLS_FIXED_OUTPUT=1` when a model may call the read-only tools without asking the user: `zen_list_tabs` then cannot save to a file, and `zen_close_tabs` archives only to the default folder, so no tool writes to a path the model chose.

## Caveats

- The uBlock Origin tools call the message handlers uBlock's own popup and dashboard use. uBlock offers no API to other programs, so an update to it can break them. Per-host and per-type rules only take effect while uBlock's "I am an advanced user" setting is on.
- The Zen tools use Zen internals (`gZenWorkspaces`, `gZenViewSplitter`, `gZenGlanceManager`) and can break with Zen updates. Last checked against Zen 1.24.1b.
- These tools change the user's browser. A client should ask the user before moving or closing tabs and before changing uBlock.
