# Contributing

Thanks for working on `VSCODE Notes`.

## Setup

```bash
npm install
npm run compile
```

Press `F5` in VS Code to start an Extension Development Host.

## Project Structure

- `src/extension.ts`: Activation, command registration, and user-facing command flow.
- `src/noteStore.ts`: SQLite database setup, persistence, and cross-session reloads.
- `src/notesHoverProvider.ts`: Hover rendering.
- `src/rangeSerializer.ts`: Conversion between VS Code selections and stored ranges, plus code-position matching.
- `src/types.ts`: Shared note data types.

## Guidelines

- Keep note data local-only. Do not move the database into the workspace.
- Prefer stable VS Code APIs over proposed APIs.
- Keep SQLite schema changes backward compatible and bump `PRAGMA user_version` when migrations are added.
- Avoid logging note contents because notes may contain private context.

## Verification

Before opening a pull request or sharing changes, run:

```bash
npm run compile
```

Then test manually in the Extension Development Host:

1. Select code in a file.
2. Run **Create Note** from the context menu.
3. Hover over the selected code and confirm the note appears.
4. Run **vscode-notes: Remove Note at Cursor** and confirm the note is deleted.
5. Open another VS Code window with the extension and confirm notes load from the same local database.
