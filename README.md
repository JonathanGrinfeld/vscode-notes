# VSCODE Notes

Local-only code notes for VS Code. Select code, right-click **Create Note**, write the note, then hover over that code later to see the note in the editor hover.

## Features

- Adds **Create Note** to the editor context menu when code is selected.
- Stores notes in a local SQLite database under VS Code's extension global storage directory.
- Shows notes through a hover provider when the cursor is over marked code.
- Shares the same local database across VS Code windows and sessions for the same user profile.
- Keeps notes outside the workspace so they are not committed or uploaded with the repository.

## Usage

1. Select code in a saved file.
2. Right-click the selection and choose **Create Note**.
3. Enter the note text.
4. Hover over the marked code to view the note.

The command is also available from the Command Palette as **vscode-notes: Create Note** when text is selected.

Use **vscode-notes: Remove Note at Cursor** to delete a note from the code under the cursor.

## Local Storage

Notes are written to `notes.sqlite` in VS Code's global storage directory for this extension. That directory is outside your workspace, which means the database is not tracked by the workspace Git repository.

Use **vscode-notes: Open Notes Storage Location** to reveal the SQLite file on disk.

The extension watches the database file for changes and reloads it when another VS Code window updates notes, so separate VS Code sessions stay in sync through the same local database.

## Settings

- `vscodenotes.hover.enabled`: Enables or disables note hovers.
- `vscodenotes.hover.maxNotes`: Maximum number of notes shown in a single hover.

## Development

Install dependencies and compile:

```bash
npm install
npm run compile
```

Launch the extension development host with `F5` in VS Code.

## Notes On Matching Code

Each note is stored with the file URI, selected range, and selected text. The stored range is used first. If code moves within the same file, the extension also tries to match the original selected text so the note can still appear on hover.
