import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as vscode from 'vscode';

import { NoteDatabase } from './noteDatabase';
import { CreateNoteInput, StoredNote } from './types';

export interface DocumentUriRemap {
    readonly fromDocumentUri: string;
    readonly toDocumentUri: string;
    readonly isDirectory: boolean;
}

export class NoteStore implements vscode.Disposable {
    private readonly databaseFileName = 'notes.sqlite';
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    private readonly storageUri: vscode.Uri;
    private sql: SqlJsStatic | undefined;
    private database: Database | undefined;
    private noteDatabase: NoteDatabase | undefined;
    private watcher: fs.FSWatcher | undefined;
    private ready: Promise<void> | undefined;
    private operationQueue: Promise<unknown> = Promise.resolve();
    private lastLoadedMtimeMs = 0;

    public readonly onDidChange = this.onDidChangeEmitter.event;

    public constructor(private readonly context: vscode.ExtensionContext) {
        this.storageUri = context.globalStorageUri;
    }

    public get databasePath(): string {
        return path.join(this.storageUri.fsPath, this.databaseFileName);
    }

    public get storageDirectory(): vscode.Uri {
        return this.storageUri;
    }

    public async initialize(): Promise<void> {
        if (!this.ready) {
            this.ready = this.open();
        }

        await this.ready;
    }

    public async createNote(input: CreateNoteInput): Promise<StoredNote> {
        await this.initialize();

        return this.runSerialized(async () => {
            await this.refreshFromDiskIfChanged();
            await this.deleteExpiredNotesIfNeeded();

            const note = this.getNoteDatabase().createNote(input);

            await this.persist();
            this.onDidChangeEmitter.fire();

            return note;
        });
    }

    public async getNote(noteId: string): Promise<StoredNote | undefined> {
        await this.initialize();

        return this.runSerialized(async () => {
            await this.refreshFromDiskIfChanged();
            await this.deleteExpiredNotesIfNeeded();

            return this.getNoteDatabase().getNote(noteId);
        });
    }

    public async getNotesForDocument(documentUri: string): Promise<StoredNote[]> {
        await this.initialize();

        return this.runSerialized(async () => {
            await this.refreshFromDiskIfChanged();
            await this.deleteExpiredNotesIfNeeded();

            return this.getNoteDatabase().getNotesForDocument(documentUri);
        });
    }

    public async getNotesForWorkspace(): Promise<StoredNote[]> {
        await this.initialize();

        return this.runSerialized(async () => {
            await this.refreshFromDiskIfChanged();
            await this.deleteExpiredNotesIfNeeded();

            const notes = this.getNoteDatabase().getAllNotes();
            const workspaceFolderUris = new Set(vscode.workspace.workspaceFolders?.map((folder) => folder.uri.toString()) ?? []);

            if (workspaceFolderUris.size === 0) {
                return notes;
            }

            return notes.filter((note) => {
                if (note.workspaceFolderUri) {
                    return workspaceFolderUris.has(note.workspaceFolderUri);
                }

                return vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(note.documentUri, true)) !== undefined;
            });
        });
    }

    public async updateNoteBody(noteId: string, body: string): Promise<StoredNote | undefined> {
        await this.initialize();

        return this.runSerialized(async () => {
            await this.refreshFromDiskIfChanged();
            await this.deleteExpiredNotesIfNeeded();

            const updatedNote = this.getNoteDatabase().updateNoteBody(noteId, body, Date.now());

            if (updatedNote) {
                await this.persist();
                this.onDidChangeEmitter.fire();
            }

            return updatedNote;
        });
    }

    public async deleteNote(noteId: string): Promise<boolean> {
        await this.initialize();

        return this.runSerialized(async () => {
            await this.refreshFromDiskIfChanged();
            await this.deleteExpiredNotesIfNeeded();

            const deleted = this.getNoteDatabase().deleteNote(noteId);

            if (deleted) {
                await this.persist();
                this.onDidChangeEmitter.fire();
            }

            return deleted;
        });
    }

    public async deleteNotes(noteIds: readonly string[]): Promise<number> {
        await this.initialize();

        return this.runSerialized(async () => {
            await this.refreshFromDiskIfChanged();
            await this.deleteExpiredNotesIfNeeded();

            const deletedCount = this.getNoteDatabase().deleteNotes(noteIds);

            if (deletedCount > 0) {
                await this.persist();
                this.onDidChangeEmitter.fire();
            }

            return deletedCount;
        });
    }

    public async deleteNotesForDocument(documentUri: string): Promise<number> {
        await this.initialize();

        return this.runSerialized(async () => {
            await this.refreshFromDiskIfChanged();
            await this.deleteExpiredNotesIfNeeded();

            const deletedCount = this.getNoteDatabase().deleteNotesForDocument(documentUri);

            if (deletedCount > 0) {
                await this.persist();
                this.onDidChangeEmitter.fire();
            }

            return deletedCount;
        });
    }

    public async remapDocumentUris(remaps: readonly DocumentUriRemap[]): Promise<number> {
        if (remaps.length === 0) {
            return 0;
        }

        await this.initialize();

        return this.runSerialized(async () => {
            await this.refreshFromDiskIfChanged();
            await this.deleteExpiredNotesIfNeeded();

            let movedCount = 0;
            const noteDatabase = this.getNoteDatabase();
            const updatedAt = Date.now();

            for (const remap of remaps) {
                movedCount += noteDatabase.moveNotesToDocument(remap.fromDocumentUri, remap.toDocumentUri, updatedAt);

                if (remap.isDirectory) {
                    movedCount += noteDatabase.moveNotesToDocumentPrefix(
                        toDirectoryDocumentUriPrefix(remap.fromDocumentUri),
                        toDirectoryDocumentUriPrefix(remap.toDocumentUri),
                        updatedAt
                    );
                }
            }

            if (movedCount > 0) {
                await this.persist();
                this.onDidChangeEmitter.fire();
            }

            return movedCount;
        });
    }

    public async pruneExpiredNotes(): Promise<number> {
        await this.initialize();

        return this.runSerialized(async () => {
            await this.refreshFromDiskIfChanged();
            return this.deleteExpiredNotesIfNeeded();
        });
    }

    public dispose(): void {
        this.watcher?.close();
        this.database?.close();
        this.onDidChangeEmitter.dispose();
    }

    private async open(): Promise<void> {
        await vscode.workspace.fs.createDirectory(this.storageUri);
        this.sql = await initSqlJs({
            locateFile: (fileName) => path.join(this.context.extensionPath, 'dist', fileName)
        });

        await this.loadFromDisk();
        await this.deleteExpiredNotesIfNeeded();
        this.watchForExternalChanges();
    }

    private async loadFromDisk(): Promise<void> {
        const bytes = await this.readDatabaseFile();
        const DatabaseConstructor = this.getSql().Database;

        this.database?.close();
        this.database = bytes ? new DatabaseConstructor(bytes) : new DatabaseConstructor();
        this.noteDatabase = new NoteDatabase(this.database);
        this.getNoteDatabase().applySchema();

        if (!bytes) {
            await this.persist();
            return;
        }

        this.lastLoadedMtimeMs = await this.getDatabaseMtimeMs();
    }

    private async readDatabaseFile(): Promise<Uint8Array | undefined> {
        try {
            return await fsPromises.readFile(this.databasePath);
        } catch (error) {
            if (isNodeError(error) && error.code === 'ENOENT') {
                return undefined;
            }

            throw error;
        }
    }

    private async persist(): Promise<void> {
        const data = Buffer.from(this.getDatabase().export());
        await fsPromises.writeFile(this.databasePath, data);
        this.lastLoadedMtimeMs = await this.getDatabaseMtimeMs();
    }

    private async refreshFromDiskIfChanged(): Promise<void> {
        const mtimeMs = await this.getDatabaseMtimeMs();

        if (mtimeMs > this.lastLoadedMtimeMs + 1) {
            await this.loadFromDisk();
        }
    }

    private async getDatabaseMtimeMs(): Promise<number> {
        try {
            const stat = await fsPromises.stat(this.databasePath);
            return stat.mtimeMs;
        } catch (error) {
            if (isNodeError(error) && error.code === 'ENOENT') {
                return 0;
            }

            throw error;
        }
    }

    private watchForExternalChanges(): void {
        this.watcher?.close();
        this.watcher = fs.watch(this.storageUri.fsPath, { persistent: false }, (_eventType, fileName) => {
            if (fileName && fileName.toString() !== this.databaseFileName) {
                return;
            }

            void this.runSerialized(async () => {
                await this.refreshFromDiskIfChanged();
                await this.deleteExpiredNotesIfNeeded();
                this.onDidChangeEmitter.fire();
            }).catch((error) => {
                console.warn('vscodenotes failed to refresh notes from disk', error);
            });
        });
    }

    private async deleteExpiredNotesIfNeeded(): Promise<number> {
        const expiryMs = getNoteExpiryMs();

        if (expiryMs === undefined) {
            return 0;
        }

        const deletedCount = this.getNoteDatabase().deleteExpiredNotes(Date.now() - expiryMs);

        if (deletedCount > 0) {
            await this.persist();
            this.onDidChangeEmitter.fire();
        }

        return deletedCount;
    }

    private async runSerialized<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationQueue.then(operation, operation);
        this.operationQueue = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    private getDatabase(): Database {
        if (!this.database) {
            throw new Error('The notes database has not been initialized.');
        }

        return this.database;
    }

    private getNoteDatabase(): NoteDatabase {
        if (!this.noteDatabase) {
            throw new Error('The notes database has not been initialized.');
        }

        return this.noteDatabase;
    }

    private getSql(): SqlJsStatic {
        if (!this.sql) {
            throw new Error('SQL.js has not been initialized.');
        }

        return this.sql;
    }
}

function getNoteExpiryMs(): number | undefined {
    const expiry = vscode.workspace.getConfiguration('vscodenotes').get<string>('expiry', 'none');

    switch (expiry) {
        case '1h':
            return 60 * 60 * 1000;
        case '1d':
            return 24 * 60 * 60 * 1000;
        case '7d':
            return 7 * 24 * 60 * 60 * 1000;
        case '30d':
            return 30 * 24 * 60 * 60 * 1000;
        case '90d':
            return 90 * 24 * 60 * 60 * 1000;
        default:
            return undefined;
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}

function toDirectoryDocumentUriPrefix(documentUri: string): string {
    return documentUri.endsWith('/') ? documentUri : `${documentUri}/`;
}
