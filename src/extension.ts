import * as vscode from 'vscode';

import { DocumentUriRemap, NoteStore } from './noteStore';
import { registerNotesChatParticipant, shareNotesAsChatContext } from './notesChat';
import { NotesInlayHintsProvider } from './notesInlayHintsProvider';
import { NotesHoverProvider } from './notesHoverProvider';
import { noteMatchesPosition, selectionToNoteRange } from './rangeSerializer';
import { StoredNote } from './types';
import {
    FileNotesTreeItem,
    getDocumentUriFromTreeItem,
    getNoteFromTreeItem,
    revealNoteInEditor,
    WorkspaceNoteTreeItem,
    WorkspaceNotesTreeProvider
} from './workspaceNotesTreeProvider';

const hoverDocumentSelector: vscode.DocumentSelector = [{ scheme: 'file' }, { scheme: 'vscode-remote' }];
const noteAtCursorContextKey = 'vscodenotes.hasNoteAtCursor';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const noteStore = new NoteStore(context);
    await noteStore.initialize();
    const notesTreeProvider = new WorkspaceNotesTreeProvider(noteStore);
    const inlayHintsProvider = new NotesInlayHintsProvider(noteStore);
    const chatParticipant = registerNotesChatParticipant(noteStore);

    context.subscriptions.push(
        noteStore,
        notesTreeProvider,
        inlayHintsProvider,
        vscode.window.createTreeView('vscodenotes.workspaceNotes', {
            treeDataProvider: notesTreeProvider,
            showCollapseAll: true
        }),
        vscode.window.createTreeView('vscodenotes.panelNotes', {
            treeDataProvider: notesTreeProvider,
            showCollapseAll: true
        }),
        vscode.languages.registerHoverProvider(hoverDocumentSelector, new NotesHoverProvider(noteStore)),
        vscode.languages.registerInlayHintsProvider(hoverDocumentSelector, inlayHintsProvider),
        vscode.commands.registerCommand('vscodenotes.createNote', () => createNoteFromSelection(noteStore)),
        vscode.commands.registerCommand('vscodenotes.removeNoteAtCursor', () => removeNoteAtCursor(noteStore)),
        vscode.commands.registerCommand('vscodenotes.openStorageLocation', () => openStorageLocation(noteStore)),
        vscode.commands.registerCommand('vscodenotes.refreshNotesPanel', () => notesTreeProvider.showAllFiles()),
        vscode.commands.registerCommand('vscodenotes.closeNotesFile', (element: FileNotesTreeItem | string | undefined) => {
            const documentUri = getDocumentUriFromTreeItem(element);

            if (documentUri) {
                notesTreeProvider.hideFile(documentUri);
            }
        }),
        vscode.commands.registerCommand('vscodenotes.openNotesFile', (element: FileNotesTreeItem | string | undefined) => {
            const documentUri = getDocumentUriFromTreeItem(element);

            if (documentUri) {
                notesTreeProvider.showFile(documentUri);
            }
        }),
        vscode.commands.registerCommand('vscodenotes.openNoteLocation', (note: StoredNote | WorkspaceNoteTreeItem) => {
            const resolvedNote = getNoteFromTreeItem(note);
            return resolvedNote ? revealNoteInEditor(resolvedNote) : undefined;
        }),
        vscode.commands.registerCommand('vscodenotes.editNote', (note: string | StoredNote | WorkspaceNoteTreeItem) =>
            editNote(noteStore, note)
        ),
        vscode.commands.registerCommand('vscodenotes.deleteNote', (note: string | StoredNote | WorkspaceNoteTreeItem) =>
            deleteNote(noteStore, note)
        ),
        vscode.commands.registerCommand(
            'vscodenotes.implementNoteWithCopilot',
            (note: string | StoredNote | WorkspaceNoteTreeItem) => implementNoteWithCopilot(noteStore, note)
        ),
        vscode.commands.registerCommand('vscodenotes.configure', () => configureNotes(noteStore)),
        vscode.commands.registerCommand('vscodenotes.shareNotesAsChatContext', () => shareNotesAsChatContext(noteStore)),
        ...(chatParticipant ? [chatParticipant] : [])
    );

    context.subscriptions.push(
        vscode.workspace.onDidRenameFiles((event) => {
            void remapNotesForRenamedFiles(noteStore, notesTreeProvider, event).catch((error) => {
                console.warn('vscodenotes failed to remap notes for renamed files', error);
            });
        }),
        vscode.workspace.onDidDeleteFiles(() => notesTreeProvider.refresh()),
        vscode.workspace.onDidCreateFiles(() => notesTreeProvider.refresh())
    );

    registerNoteAtCursorContext(context, noteStore);
    await noteStore.pruneExpiredNotes();
}

export function deactivate(): void {}

async function createNoteFromSelection(noteStore: NoteStore): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return;
    }

    const selection = editor.selection;

    if (selection.isEmpty) {
        return;
    }

    const selectedText = editor.document.getText(selection);

    if (selectedText.trim().length === 0) {
        return;
    }

    const body = await vscode.window.showInputBox({
        title: 'Create Note',
        prompt: 'Write a local note for the selected code.',
        placeHolder: 'This is local to your VS Code and wont be shared',
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length === 0 ? 'Enter a note.' : undefined)
    });

    if (body === undefined) {
        return;
    }

    const workspaceFolderUri = vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.toString() ?? null;

    await noteStore.createNote({
        documentUri: editor.document.uri.toString(),
        workspaceFolderUri,
        range: selectionToNoteRange(selection),
        selectedText,
        body: body.trim()
    });
    await refreshVisibleNoteUi(noteStore);
}

async function openStorageLocation(noteStore: NoteStore): Promise<void> {
    await noteStore.initialize();
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(noteStore.databasePath));
}

async function removeNoteAtCursor(noteStore: NoteStore): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return;
    }

    const notes = await noteStore.getNotesForDocument(editor.document.uri.toString());
    const matchingNotes = notes.filter((note) => noteMatchesPosition(note, editor.document, editor.selection.active));

    if (matchingNotes.length === 0) {
        return;
    }

    await noteStore.deleteNotes(matchingNotes.map((note) => note.id));
    await refreshVisibleNoteUi(noteStore);
}

async function editNote(noteStore: NoteStore, noteArgument: string | StoredNote | WorkspaceNoteTreeItem): Promise<void> {
    const noteId = resolveNoteId(noteArgument);
    const note = await noteStore.getNote(noteId);

    if (!note) {
        return;
    }

    const body = await vscode.window.showInputBox({
        title: 'Edit Note',
        value: note.body,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length === 0 ? 'Enter a note.' : undefined)
    });

    if (body === undefined) {
        return;
    }

    const trimmedBody = body.trim();

    if (trimmedBody === note.body) {
        return;
    }

    await noteStore.updateNoteBody(noteId, trimmedBody);
    await refreshVisibleNoteUi(noteStore);
}

async function deleteNote(noteStore: NoteStore, noteArgument: string | StoredNote | WorkspaceNoteTreeItem): Promise<void> {
    await noteStore.deleteNote(resolveNoteId(noteArgument));
    await refreshVisibleNoteUi(noteStore);
}

async function implementNoteWithCopilot(
    noteStore: NoteStore,
    noteArgument: string | StoredNote | WorkspaceNoteTreeItem
): Promise<void> {
    const note = typeof noteArgument === 'string' ? await noteStore.getNote(noteArgument) : getNoteFromTreeItem(noteArgument);

    if (!note) {
        return;
    }

    await revealNoteInEditor(note);

    const prompt = `Implement this note:\n\n${note.body}`;

    try {
        await vscode.commands.executeCommand('vscode.editorChat.start', { message: prompt, autoSend: false });
        return;
    } catch {
        // Fall through to older inline chat command ids.
    }

    try {
        await vscode.commands.executeCommand('inlineChat.start', { message: prompt, autoSend: false });
        return;
    } catch {
        // Inline chat command unavailable.
    }

    await vscode.window.showWarningMessage('Copilot inline chat is unavailable in this VS Code environment.');
}

async function configureNotes(noteStore: NoteStore): Promise<void> {
    const selection = await vscode.window.showQuickPick(
        [
            {
                label: '$(clock) Note Expiry',
                description: formatCurrentExpiry(),
                detail: 'Choose how long notes are kept before auto-delete. None is a possibility.',
                setting: 'expiry' as const
            },
            {
                label: '$(comment) Inline Notes',
                description: vscode.workspace.getConfiguration('vscodenotes.inlineNotes').get<boolean>('enabled', false) ? 'On' : 'Off',
                detail: 'Show notes as inline editor hints.',
                setting: 'inlineNotes' as const
            }
        ],
        {
            title: 'VSCODE Notes Settings',
            placeHolder: 'Choose a setting to update.'
        }
    );

    if (!selection) {
        return;
    }

    if (selection.setting === 'expiry') {
        await configureExpiry(noteStore);
        return;
    }

    await configureInlineNotes();
}

async function configureExpiry(noteStore: NoteStore): Promise<void> {
    const currentExpiry = vscode.workspace.getConfiguration('vscodenotes').get<string>('expiry', 'none');
    const expiry = await vscode.window.showQuickPick(
        [
            { label: '$(circle-slash) None', description: 'Keep notes indefinitely', value: 'none' },
            { label: '$(watch) 1 Hour', description: 'Auto-delete notes after 1 hour', value: '1h' },
            { label: '$(calendar) 1 Day', description: 'Auto-delete notes after 1 day', value: '1d' },
            { label: '$(calendar) 7 Days', description: 'Auto-delete notes after 7 days', value: '7d' },
            { label: '$(calendar) 30 Days', description: 'Auto-delete notes after 30 days', value: '30d' },
            { label: '$(calendar) 90 Days', description: 'Auto-delete notes after 90 days', value: '90d' }
        ].map((item) => ({ ...item, picked: item.value === currentExpiry })),
        {
            title: 'Note Expiry',
            placeHolder: 'None is a possibility.'
        }
    );

    if (!expiry) {
        return;
    }

    await vscode.workspace
        .getConfiguration('vscodenotes')
        .update('expiry', expiry.value, vscode.ConfigurationTarget.Global);
    await noteStore.pruneExpiredNotes();
}

async function configureInlineNotes(): Promise<void> {
    const enabled = vscode.workspace.getConfiguration('vscodenotes.inlineNotes').get<boolean>('enabled', false);
    const selection = await vscode.window.showQuickPick(
        [
            { label: '$(check) On', description: 'Show notes inline', value: true },
            { label: '$(circle-slash) Off', description: 'Hide inline notes', value: false }
        ].map((item) => ({ ...item, picked: item.value === enabled })),
        {
            title: 'Inline Notes',
            placeHolder: 'Choose whether notes appear inline.'
        }
    );

    if (!selection) {
        return;
    }

    await vscode.workspace
        .getConfiguration('vscodenotes.inlineNotes')
        .update('enabled', selection.value, vscode.ConfigurationTarget.Global);
}

function registerNoteAtCursorContext(context: vscode.ExtensionContext, noteStore: NoteStore): void {
    let updateVersion = 0;
    const update = () => {
        const version = ++updateVersion;

        void updateNoteAtCursorContext(noteStore).then((hasNoteAtCursor) => {
            if (version === updateVersion) {
                void vscode.commands.executeCommand('setContext', noteAtCursorContextKey, hasNoteAtCursor);
            }
        });
    };

    context.subscriptions.push(
        noteStore.onDidChange(update),
        vscode.window.onDidChangeActiveTextEditor(update),
        vscode.window.onDidChangeTextEditorSelection(update),
        vscode.workspace.onDidCloseTextDocument(update)
    );
    update();
}

async function updateNoteAtCursorContext(noteStore: NoteStore): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return false;
    }

    const notes = await noteStore.getNotesForDocument(editor.document.uri.toString());
    return notes.some((note) => noteMatchesPosition(note, editor.document, editor.selection.active));
}

async function refreshVisibleNoteUi(noteStore: NoteStore): Promise<void> {
    await vscode.commands.executeCommand('editor.action.hideHover').then(undefined, () => undefined);

    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return;
    }

    const notes = await noteStore.getNotesForDocument(editor.document.uri.toString());
    const hasNoteAtCursor = notes.some((note) => noteMatchesPosition(note, editor.document, editor.selection.active));

    if (hasNoteAtCursor) {
        await vscode.commands.executeCommand('editor.action.showHover').then(undefined, () => undefined);
    }
}

function resolveNoteId(noteArgument: string | StoredNote | WorkspaceNoteTreeItem): string {
    if (typeof noteArgument === 'string') {
        return noteArgument;
    }

    const note = getNoteFromTreeItem(noteArgument);

    if (!note) {
        throw new Error('No note was supplied.');
    }

    return note.id;
}

function formatCurrentExpiry(): string {
    switch (vscode.workspace.getConfiguration('vscodenotes').get<string>('expiry', 'none')) {
        case '1h':
            return '1 hour';
        case '1d':
            return '1 day';
        case '7d':
            return '7 days';
        case '30d':
            return '30 days';
        case '90d':
            return '90 days';
        default:
            return 'None';
    }
}

async function remapNotesForRenamedFiles(
    noteStore: NoteStore,
    notesTreeProvider: WorkspaceNotesTreeProvider,
    event: vscode.FileRenameEvent
): Promise<void> {
    const remaps = await Promise.all(
        event.files.map(async (change) => ({
            fromDocumentUri: change.oldUri.toString(),
            toDocumentUri: change.newUri.toString(),
            isDirectory: await isDirectoryUri(change.newUri)
        }))
    );

    const supportedRemaps = remaps.filter((remap) => isSupportedDocumentUriRemap(remap));

    if (supportedRemaps.length === 0) {
        return;
    }

    notesTreeProvider.remapHiddenFileDocumentUris(supportedRemaps);
    await noteStore.remapDocumentUris(supportedRemaps);
}

function isSupportedDocumentUriRemap(remap: DocumentUriRemap): boolean {
    if (remap.fromDocumentUri === remap.toDocumentUri) {
        return false;
    }

    const fromScheme = vscode.Uri.parse(remap.fromDocumentUri, true).scheme;
    const toScheme = vscode.Uri.parse(remap.toDocumentUri, true).scheme;

    return fromScheme === 'file' || fromScheme === 'vscode-remote' ? toScheme === fromScheme : false;
}

async function isDirectoryUri(uri: vscode.Uri): Promise<boolean> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
        return false;
    }
}
