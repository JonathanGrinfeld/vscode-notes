import * as vscode from 'vscode';

import { NoteRange, StoredNote } from './types';

export function selectionToNoteRange(selection: vscode.Selection): NoteRange {
    return {
        startLine: selection.start.line,
        startCharacter: selection.start.character,
        endLine: selection.end.line,
        endCharacter: selection.end.character
    };
}

export function noteRangeToVsCodeRange(range: NoteRange): vscode.Range {
    return new vscode.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter);
}

export function noteMatchesPosition(
    note: StoredNote,
    document: vscode.TextDocument,
    position: vscode.Position
): boolean {
    const storedRange = noteRangeToVsCodeRange(note.range);

    if (storedRange.contains(position)) {
        return true;
    }

    return findSelectedTextAtPosition(document, note.selectedText, position);
}

function findSelectedTextAtPosition(
    document: vscode.TextDocument,
    selectedText: string,
    position: vscode.Position
): boolean {
    if (selectedText.length === 0) {
        return false;
    }

    const text = document.getText();
    let searchFrom = 0;

    while (searchFrom < text.length) {
        const offset = text.indexOf(selectedText, searchFrom);

        if (offset === -1) {
            return false;
        }

        const range = new vscode.Range(document.positionAt(offset), document.positionAt(offset + selectedText.length));

        if (range.contains(position)) {
            return true;
        }

        searchFrom = offset + Math.max(selectedText.length, 1);
    }

    return false;
}
