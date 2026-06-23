import * as vscode from 'vscode';

import { formatNoteTimestamps } from './noteFormatting';
import { NoteStore } from './noteStore';
import { noteMatchesPosition, noteRangeToVsCodeRange } from './rangeSerializer';

export class NotesHoverProvider implements vscode.HoverProvider {
    public constructor(private readonly noteStore: NoteStore) {}

    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const configuration = vscode.workspace.getConfiguration('vscodenotes.hover');

        if (!configuration.get<boolean>('enabled', true)) {
            return undefined;
        }

        const notes = await this.noteStore.getNotesForDocument(document.uri.toString());
        const matchingNotes = notes.filter((note) => noteMatchesPosition(note, document, position));

        if (matchingNotes.length === 0) {
            return undefined;
        }

        const maxNotes = configuration.get<number>('maxNotes', 5);
        const visibleNotes = matchingNotes.slice(0, Math.max(1, maxNotes));
        const markdown = new vscode.MarkdownString('', true);
        markdown.supportThemeIcons = true;
        markdown.isTrusted = { enabledCommands: ['vscodenotes.editNote', 'vscodenotes.deleteNote'] };
        markdown.appendMarkdown('$(note) **VSCODE Notes**\n\n');

        visibleNotes.forEach((note, index) => {
            if (visibleNotes.length > 1) {
                markdown.appendMarkdown(`**Note ${index + 1}**\n\n`);
            }

            markdown.appendText(note.body);
            markdown.appendMarkdown(`\n\n_${formatNoteTimestamps(note)}._`);
            markdown.appendMarkdown(`\n\n[$(edit) Edit](${createCommandUri('vscodenotes.editNote', note.id)})`);
            markdown.appendMarkdown(` [$(trash) Delete](${createCommandUri('vscodenotes.deleteNote', note.id)})`);

            if (index < visibleNotes.length - 1) {
                markdown.appendMarkdown('\n\n---\n\n');
            }
        });

        return new vscode.Hover(markdown, noteRangeToVsCodeRange(visibleNotes[0].range));
    }
}

function createCommandUri(command: string, noteId: string): string {
    return `command:${command}?${encodeURIComponent(JSON.stringify([noteId]))}`;
}
