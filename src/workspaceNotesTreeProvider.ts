import * as vscode from 'vscode';

import { createNoteTooltip, groupNotesByDocument, NoteFileGroup, trimForDisplay } from './noteFormatting';
import { DocumentUriRemap, NoteStore } from './noteStore';
import { noteRangeToVsCodeRange } from './rangeSerializer';
import { StoredNote } from './types';

export type NotesTreeElement = NotesSectionTreeItem | FileNotesTreeItem | WorkspaceNoteTreeItem;

export class WorkspaceNotesTreeProvider implements vscode.TreeDataProvider<NotesTreeElement>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<NotesTreeElement | undefined | null | void>();
    private readonly hiddenDocumentUris = new Set<string>();
    private readonly noteStoreSubscription: vscode.Disposable;
    private readonly notesSection = new NotesSectionTreeItem();

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

    public showFile(documentUri: string): void {
        this.hiddenDocumentUris.delete(documentUri);
        this.refresh();
    }

    public remapHiddenFileDocumentUris(remaps: readonly DocumentUriRemap[]): void {
        let changed = false;

        for (const remap of remaps) {
            if (this.hiddenDocumentUris.delete(remap.fromDocumentUri)) {
                this.hiddenDocumentUris.add(remap.toDocumentUri);
                changed = true;
            }

            if (!remap.isDirectory) {
                continue;
            }

            const fromPrefix = toDirectoryDocumentUriPrefix(remap.fromDocumentUri);
            const toPrefix = toDirectoryDocumentUriPrefix(remap.toDocumentUri);

            for (const documentUri of [...this.hiddenDocumentUris]) {
                if (!documentUri.startsWith(fromPrefix)) {
                    continue;
                }

                this.hiddenDocumentUris.delete(documentUri);
                this.hiddenDocumentUris.add(`${toPrefix}${documentUri.slice(fromPrefix.length)}`);
                changed = true;
            }
        }

        if (changed) {
            this.refresh();
        }
    }

    public getTreeItem(element: NotesTreeElement): vscode.TreeItem {
        return element;
    }

    public async getChildren(element?: NotesTreeElement): Promise<NotesTreeElement[]> {
        if (!element) {
            return [this.notesSection];
        }

        if (element instanceof NotesSectionTreeItem) {
            const notes = await this.noteStore.getNotesForWorkspace();
            const groups = await filterGroupsWithExistingResources(groupNotesByDocument(notes));

            return groups.map((group) => new FileNotesTreeItem(group, this.hiddenDocumentUris.has(group.documentUri)));
        }

        if (element instanceof FileNotesTreeItem) {
            if (element.isHidden) {
                return [];
            }

            return element.notes.map((note) => new WorkspaceNoteTreeItem(note));
        }

        return [];
    }

    public dispose(): void {
        this.noteStoreSubscription.dispose();
        this.onDidChangeTreeDataEmitter.dispose();
    }
}

class NotesSectionTreeItem extends vscode.TreeItem {
    public constructor() {
        super('Notes', vscode.TreeItemCollapsibleState.Expanded);

        this.id = 'section:notes';
        this.iconPath = new vscode.ThemeIcon('notebook-template');
        this.contextValue = 'notesSection';
    }
}

export class FileNotesTreeItem extends vscode.TreeItem {
    public readonly documentUri: string;
    public readonly isHidden: boolean;
    public readonly notes: readonly StoredNote[];

    public constructor(group: NoteFileGroup, isHidden: boolean) {
        super(group.resourceUri, isHidden ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);

        this.documentUri = group.documentUri;
        this.isHidden = isHidden;
        this.notes = group.notes;
        this.id = `file:${group.documentUri}`;
        this.resourceUri = group.resourceUri;
        this.iconPath = vscode.ThemeIcon.File;
        this.tooltip = `${group.relativePath}\n${group.notes.length} ${group.notes.length === 1 ? 'note' : 'notes'}`;
        this.contextValue = isHidden ? 'notesFileClosed' : 'notesFileOpen';
    }
}

export class WorkspaceNoteTreeItem extends vscode.TreeItem {
    public constructor(public readonly note: StoredNote) {
        super(`Line ${note.range.startLine + 1}: ${trimForDisplay(note.body, 64)}`, vscode.TreeItemCollapsibleState.None);

        this.id = `note:${note.id}`;
        this.iconPath = new vscode.ThemeIcon('note');
        this.description = undefined;
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

async function filterGroupsWithExistingResources(groups: readonly NoteFileGroup[]): Promise<NoteFileGroup[]> {
    const existence = await Promise.all(groups.map((group) => doesResourceExist(group.resourceUri)));

    return groups.filter((_group, index) => existence[index]);
}

async function doesResourceExist(resourceUri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(resourceUri);
        return true;
    } catch (error) {
        if (error instanceof vscode.FileSystemError) {
            return false;
        }

        return false;
    }
}

function toDirectoryDocumentUriPrefix(documentUri: string): string {
    return documentUri.endsWith('/') ? documentUri : `${documentUri}/`;
}