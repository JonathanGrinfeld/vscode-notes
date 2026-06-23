import * as vscode from 'vscode';

import { formatNoteTimestamps, formatRangeDescription, trimForDisplay } from './noteFormatting';
import { NoteStore } from './noteStore';
import { StoredNote } from './types';

export class NotesInlayHintsProvider implements vscode.InlayHintsProvider, vscode.Disposable {
    private readonly onDidChangeInlayHintsEmitter = new vscode.EventEmitter<void>();
    private readonly disposables: vscode.Disposable[] = [];

    public readonly onDidChangeInlayHints = this.onDidChangeInlayHintsEmitter.event;

    public constructor(private readonly noteStore: NoteStore) {
        this.disposables.push(
            this.noteStore.onDidChange(() => this.onDidChangeInlayHintsEmitter.fire()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('vscodenotes.inlineNotes.enabled')) {
                    this.onDidChangeInlayHintsEmitter.fire();
                }
            })
        );
    }

    public async provideInlayHints(
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken
    ): Promise<vscode.InlayHint[]> {
        const enabled = vscode.workspace.getConfiguration('vscodenotes.inlineNotes').get<boolean>('enabled', false);

        if (token.isCancellationRequested || !enabled) {
            return [];
        }

        const notes = await this.noteStore.getNotesForDocument(document.uri.toString());
        const notesByLine = groupNotesByStartLine(notes, document, range);

        return [...notesByLine.entries()].map(([line, lineNotes]) => createInlayHint(document, line, lineNotes));
    }

    public dispose(): void {
        this.disposables.forEach((disposable) => disposable.dispose());
        this.onDidChangeInlayHintsEmitter.dispose();
    }
}

function groupNotesByStartLine(
    notes: readonly StoredNote[],
    document: vscode.TextDocument,
    visibleRange: vscode.Range
): Map<number, StoredNote[]> {
    const notesByLine = new Map<number, StoredNote[]>();

    for (const note of notes) {
        const line = Math.max(0, Math.min(note.range.startLine, document.lineCount - 1));

        if (line < visibleRange.start.line || line > visibleRange.end.line) {
            continue;
        }

        const lineNotes = notesByLine.get(line) ?? [];
        lineNotes.push(note);
        notesByLine.set(line, lineNotes);
    }

    return notesByLine;
}

function createInlayHint(document: vscode.TextDocument, line: number, notes: readonly StoredNote[]): vscode.InlayHint {
    const firstNote = notes[0];
    const extraNotes = notes.length > 1 ? ` +${notes.length - 1}` : '';
    const position = new vscode.Position(line, document.lineAt(line).range.end.character);
    const hint = new vscode.InlayHint(
        position,
        ` note: ${trimForDisplay(firstNote.body, 48)}${extraNotes}`,
        vscode.InlayHintKind.Type
    );
    hint.paddingLeft = true;
    hint.tooltip = createTooltip(notes);
    return hint;
}

function createTooltip(notes: readonly StoredNote[]): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString('', true);
    markdown.supportThemeIcons = true;
    markdown.appendMarkdown('$(note) **VSCODE Notes**\n\n');

    notes.forEach((note, index) => {
        if (notes.length > 1) {
            markdown.appendMarkdown(`**Note ${index + 1}: ${formatRangeDescription(note)}**\n\n`);
        }

        markdown.appendText(note.body);
        markdown.appendMarkdown(`\n\n_${formatNoteTimestamps(note)}._`);

        if (index < notes.length - 1) {
            markdown.appendMarkdown('\n\n---\n\n');
        }
    });

    return markdown;
}
