import * as path from 'path';
import * as vscode from 'vscode';

import { noteRangeToVsCodeRange } from './rangeSerializer';
import { StoredNote } from './types';

export interface NoteFileGroup {
    readonly documentUri: string;
    readonly resourceUri: vscode.Uri;
    readonly relativePath: string;
    readonly notes: readonly StoredNote[];
}

export function groupNotesByDocument(notes: readonly StoredNote[]): NoteFileGroup[] {
    const groupsByDocument = new Map<string, StoredNote[]>();

    for (const note of notes) {
        const documentNotes = groupsByDocument.get(note.documentUri) ?? [];
        documentNotes.push(note);
        groupsByDocument.set(note.documentUri, documentNotes);
    }

    return [...groupsByDocument.entries()]
        .map(([documentUri, documentNotes]) => {
            const resourceUri = vscode.Uri.parse(documentUri, true);

            return {
                documentUri,
                resourceUri,
                relativePath: getRelativePath(resourceUri),
                notes: [...documentNotes].sort((firstNote, secondNote) => firstNote.createdAt - secondNote.createdAt)
            };
        })
        .sort((firstGroup, secondGroup) => firstGroup.relativePath.localeCompare(secondGroup.relativePath));
}

export function getRelativePath(resourceUri: vscode.Uri): string {
    const relativePath = vscode.workspace.asRelativePath(resourceUri, false);
    return relativePath === resourceUri.toString() ? path.basename(resourceUri.fsPath || resourceUri.path) : relativePath;
}

export function trimForDisplay(value: string, maxLength = 80): string {
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatRangeDescription(note: StoredNote): string {
    const range = noteRangeToVsCodeRange(note.range);
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;

    return startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}-${endLine}`;
}

export function formatTimestamp(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(new Date(timestamp));
}

export function formatNoteTimestamps(note: StoredNote): string {
    const createdAt = `Created ${formatTimestamp(note.createdAt)}`;

    if (note.updatedAt <= note.createdAt) {
        return createdAt;
    }

    return `${createdAt} | Updated ${formatTimestamp(note.updatedAt)}`;
}

export function createNoteTooltip(note: StoredNote): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString('', true);
    markdown.supportThemeIcons = true;
    markdown.appendMarkdown(`$(note) **${formatRangeDescription(note)}**\n\n`);
    markdown.appendText(note.body);
    markdown.appendMarkdown(`\n\n_${formatNoteTimestamps(note)}._`);
    markdown.appendMarkdown(`\n\n_Selected text:_\n\n`);
    markdown.appendCodeblock(note.selectedText, 'text');
    return markdown;
}
