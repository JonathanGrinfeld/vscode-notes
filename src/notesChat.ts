import * as vscode from 'vscode';

import { NoteStore } from './noteStore';
import { formatNoteTimestamps, formatRangeDescription, groupNotesByDocument, trimForDisplay } from './noteFormatting';
import { noteRangeToVsCodeRange } from './rangeSerializer';
import { StoredNote } from './types';

const chatParticipantId = 'vscodenotes.notes';
const sharedNotesContextMetadataKey = 'sharedNotesContext';

export function registerNotesChatParticipant(noteStore: NoteStore): vscode.Disposable | undefined {
    if (!vscode.chat?.createChatParticipant) {
        return undefined;
    }

    const participant = vscode.chat.createChatParticipant(chatParticipantId, async (request, context, response, token) => {
        if (request.command && request.command !== 'sharenotes') {
            response.markdown('Use `/sharenotes` to share workspace notes as context.');
            return;
        }

        const notes = await noteStore.getNotesForWorkspace();
        const currentNotesContext = buildNotesContext(notes);
        const notesContext = currentNotesContext || findSharedNotesContext(context);

        if (!notesContext) {
            response.markdown('No workspace notes found.');
            return;
        }

        addNoteReferences(response, notes);

        if (request.command === 'sharenotes' && request.prompt.trim().length === 0) {
            response.markdown(
                `Shared ${notes.length} workspace ${notes.length === 1 ? 'note' : 'notes'} as context. Ask @notes a follow-up question to use them.`
            );
            return { metadata: { [sharedNotesContextMetadataKey]: notesContext } };
        }

        await answerWithNotesContext(request, context, response, token, notesContext);
        return { metadata: { [sharedNotesContextMetadataKey]: notesContext } };
    });

    participant.iconPath = new vscode.ThemeIcon('note');
    return participant;
}

export async function shareNotesAsChatContext(noteStore: NoteStore): Promise<void> {
    const contextText = buildNotesContext(await noteStore.getNotesForWorkspace()) || 'No workspace notes found.';
    await vscode.env.clipboard.writeText(contextText);

    await vscode.commands.executeCommand('workbench.action.chat.open').then(undefined, () => undefined);
}

function buildNotesContext(notes: readonly StoredNote[]): string {
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

async function answerWithNotesContext(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    notesContext: string
): Promise<void> {
    const messages = buildLanguageModelMessages(context, request.prompt, notesContext);
    const modelResponse = await request.model.sendRequest(messages, {}, token);

    for await (const chunk of modelResponse.text) {
        response.markdown(chunk);
    }
}

function buildLanguageModelMessages(
    context: vscode.ChatContext,
    prompt: string,
    notesContext: string
): vscode.LanguageModelChatMessage[] {
    const messages = [
        vscode.LanguageModelChatMessage.User(
            [
                'You are answering inside VS Code with access to the user\'s local VSCODE Notes.',
                'Use the notes below as context for the user\'s coding questions.',
                'Do not repeat the full notes unless the user explicitly asks for them.',
                '',
                notesContext
            ].join('\n')
        )
    ];

    for (const turn of context.history.slice(-8)) {
        if (turn instanceof vscode.ChatRequestTurn) {
            if (turn.command === 'sharenotes' || turn.prompt.trim().length === 0) {
                continue;
            }

            messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            continue;
        }

        if (turn instanceof vscode.ChatResponseTurn) {
            const responseText = getResponseText(turn);

            if (responseText.length > 0) {
                messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
            }
        }
    }

    messages.push(vscode.LanguageModelChatMessage.User(prompt));
    return messages;
}

function getResponseText(turn: vscode.ChatResponseTurn): string {
    return turn.response
        .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
        .map((part) => part.value.value)
        .join('\n')
        .trim();
}

function findSharedNotesContext(context: vscode.ChatContext): string | undefined {
    for (const turn of [...context.history].reverse()) {
        if (!(turn instanceof vscode.ChatResponseTurn)) {
            continue;
        }

        const sharedNotesContext = turn.result.metadata?.[sharedNotesContextMetadataKey];

        if (typeof sharedNotesContext === 'string' && sharedNotesContext.length > 0) {
            return sharedNotesContext;
        }
    }

    return undefined;
}

function addNoteReferences(response: vscode.ChatResponseStream, notes: readonly StoredNote[]): void {
    const referencedDocumentUris = new Set<string>();

    for (const note of notes) {
        if (referencedDocumentUris.has(note.documentUri)) {
            continue;
        }

        referencedDocumentUris.add(note.documentUri);
        response.reference(
            new vscode.Location(vscode.Uri.parse(note.documentUri, true), noteRangeToVsCodeRange(note.range)),
            new vscode.ThemeIcon('note')
        );
    }
}