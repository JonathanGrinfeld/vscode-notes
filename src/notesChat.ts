import * as vscode from 'vscode';

import { NoteStore } from './noteStore';
import { formatNoteTimestamps, formatRangeDescription, groupNotesByDocument, trimForDisplay } from './noteFormatting';

const chatParticipantId = 'vscodenotes.notes';

export function registerNotesChatParticipant(noteStore: NoteStore): vscode.Disposable | undefined {
    if (!vscode.chat?.createChatParticipant) {
        return undefined;
    }

    const participant = vscode.chat.createChatParticipant(chatParticipantId, async (request, _context, response) => {
        if (request.command && request.command !== 'sharenotes') {
            response.markdown('Use `/sharenotes` to share workspace notes as context.');
            return;
        }

        const contextText = await buildNotesContext(noteStore);
        response.markdown(contextText || 'No workspace notes found.');
    });

    participant.iconPath = new vscode.ThemeIcon('note');
    return participant;
}

export async function shareNotesAsChatContext(noteStore: NoteStore): Promise<void> {
    const contextText = (await buildNotesContext(noteStore)) || 'No workspace notes found.';
    await vscode.env.clipboard.writeText(contextText);

    await vscode.commands.executeCommand('workbench.action.chat.open').then(undefined, () => undefined);
}

async function buildNotesContext(noteStore: NoteStore): Promise<string> {
    const notes = await noteStore.getNotesForWorkspace();

    if (notes.length === 0) {
        return '';
    }

    const lines = ['Use these VSCODE Notes as context for code questions.', ''];

    for (const group of groupNotesByDocument(notes)) {
        lines.push(`## ${group.relativePath}`);

        for (const note of group.notes) {
            lines.push(`- ${formatRangeDescription(note)} (${formatNoteTimestamps(note)})`);
            lines.push(`  Selected: ${trimForDisplay(note.selectedText, 120)}`);
            lines.push(`  Note: ${trimForDisplay(note.body, 240)}`);
        }

        lines.push('');
    }

    return lines.join('\n').trim();
}