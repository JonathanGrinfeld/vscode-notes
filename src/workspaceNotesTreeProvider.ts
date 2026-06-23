import * as vscode from 'vscode';

import { createNoteTooltip, formatRangeDescription, groupNotesByDocument, NoteFileGroup, trimForDisplay } from './noteFormatting';
import { NoteStore } from './noteStore';
import { noteRangeToVsCodeRange } from './rangeSerializer';
import { StoredNote } from './types';

export type NotesTreeElement = FileNotesTreeItem | WorkspaceNoteTreeItem;

export class WorkspaceNotesTreeProvider implements vscode.TreeDataProvider<NotesTreeElement>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<NotesTreeElement | undefined | null | void>();
    private readonly hiddenDocumentUris = new Set<string>();
    private readonly noteStoreSubscription: vscode.Disposable;

    public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    public constructor(private readonly noteStore: NoteStore) {
        this.noteStoreSubscription = this.noteStore.onDidChange(() => this.refresh());
    }

    public refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    public hideFile(documentUri: string): void {
        this.hiddenDocumentUris.add(documentUri);
        this.refresh();
    }

    public showAllFiles(): void {
        this.hiddenDocumentUris.clear();
        this.refresh();
    }

    public getTreeItem(element: NotesTreeElement): vscode.TreeItem {
        return element;
    }

    public async getChildren(element?: NotesTreeElement): Promise<NotesTreeElement[]> {
        if (element instanceof FileNotesTreeItem) {
            return element.notes.map((note) => new WorkspaceNoteTreeItem(note));
        }

        const notes = await this.noteStore.getNotesForWorkspace();
        return groupNotesByDocument(notes)
            .filter((group) => !this.hiddenDocumentUris.has(group.documentUri))
            .map((group) => new FileNotesTreeItem(group));
    }

    public dispose(): void {
        this.noteStoreSubscription.dispose();
        this.onDidChangeTreeDataEmitter.dispose();
    }
}

export class FileNotesTreeItem extends vscode.TreeItem {
    public readonly documentUri: string;
    public readonly notes: readonly StoredNote[];

    public constructor(group: NoteFileGroup) {
        super(group.resourceUri, vscode.TreeItemCollapsibleState.Expanded);

        this.documentUri = group.documentUri;
        this.notes = group.notes;
        this.id = `file:${group.documentUri}`;
        this.resourceUri = group.resourceUri;
        this.iconPath = vscode.ThemeIcon.File;
        this.description = `${group.notes.length} ${group.notes.length === 1 ? 'note' : 'notes'}`;
        this.tooltip = `${group.relativePath}\n${this.description}`;
        this.contextValue = 'notesFile';
    }
}

export class WorkspaceNoteTreeItem extends vscode.TreeItem {
    public constructor(public readonly note: StoredNote) {
        super(trimForDisplay(note.body, 64), vscode.TreeItemCollapsibleState.None);

        this.id = `note:${note.id}`;
        this.iconPath = new vscode.ThemeIcon('note');
        this.description = formatRangeDescription(note);
        this.tooltip = createNoteTooltip(note);
        this.contextValue = 'note';
        this.command = {
            command: 'vscodenotes.openNoteLocation',
            title: 'Open Note',
            arguments: [note]
        };
    }
}

export function getDocumentUriFromTreeItem(item: FileNotesTreeItem | string | undefined): string | undefined {
    return typeof item === 'string' ? item : item?.documentUri;
}

export function getNoteFromTreeItem(item: WorkspaceNoteTreeItem | StoredNote | string | undefined): StoredNote | undefined {
    if (!item || typeof item === 'string') {
        return undefined;
    }

    return item instanceof WorkspaceNoteTreeItem ? item.note : item;
}

export async function revealNoteInEditor(note: StoredNote): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(note.documentUri, true));
    const editor = await vscode.window.showTextDocument(document);
    const range = noteRangeToVsCodeRange(note.range);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}