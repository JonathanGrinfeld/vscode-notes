import { randomUUID } from 'crypto';

import { asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import { drizzle } from 'drizzle-orm/sql-js';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Database } from 'sql.js';

import { CreateNoteInput, NoteRange, StoredNote } from './types';

export const notesTable = sqliteTable(
    'notes',
    {
        id: text('id').primaryKey(),
        documentUri: text('document_uri').notNull(),
        workspaceFolderUri: text('workspace_folder_uri'),
        startLine: integer('start_line').notNull(),
        startCharacter: integer('start_character').notNull(),
        endLine: integer('end_line').notNull(),
        endCharacter: integer('end_character').notNull(),
        selectedText: text('selected_text').notNull(),
        body: text('body').notNull(),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull()
    },
    (table) => [
        index('idx_notes_document_uri').on(table.documentUri),
        index('idx_notes_document_range').on(table.documentUri, table.startLine, table.endLine),
        index('idx_notes_workspace_folder_uri').on(table.workspaceFolderUri),
        index('idx_notes_updated_at').on(table.updatedAt)
    ]
);

const schema = {
    notes: notesTable
};

type NotesDatabase = SQLJsDatabase<typeof schema>;
type NoteRow = typeof notesTable.$inferSelect;
type NewNoteRow = typeof notesTable.$inferInsert;

export class NoteDatabase {
    private readonly orm: NotesDatabase;

    public constructor(database: Database) {
        this.orm = drizzle(database, { schema });
    }

    public applySchema(): void {
        this.orm.run(sql`
            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                document_uri TEXT NOT NULL,
                workspace_folder_uri TEXT,
                start_line INTEGER NOT NULL,
                start_character INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                end_character INTEGER NOT NULL,
                selected_text TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        `);
        this.orm.run(sql`CREATE INDEX IF NOT EXISTS idx_notes_document_uri ON notes(document_uri)`);
        this.orm.run(sql`CREATE INDEX IF NOT EXISTS idx_notes_document_range ON notes(document_uri, start_line, end_line)`);
        this.orm.run(sql`CREATE INDEX IF NOT EXISTS idx_notes_workspace_folder_uri ON notes(workspace_folder_uri)`);
        this.orm.run(sql`CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at)`);
        this.orm.run(sql`PRAGMA user_version = 1`);
    }

    public createNote(input: CreateNoteInput): StoredNote {
        const now = Date.now();
        const note: StoredNote = {
            ...input,
            id: randomUUID(),
            createdAt: now,
            updatedAt: now
        };

        this.orm.insert(notesTable).values(noteToRow(note)).run();
        return note;
    }

    public getNote(noteId: string): StoredNote | undefined {
        const row = this.orm.select().from(notesTable).where(eq(notesTable.id, noteId)).get();
        return row ? rowToNote(row) : undefined;
    }

    public getNotesForDocument(documentUri: string): StoredNote[] {
        return this.orm
            .select()
            .from(notesTable)
            .where(eq(notesTable.documentUri, documentUri))
            .orderBy(asc(notesTable.createdAt))
            .all()
            .map(rowToNote);
    }

    public getAllNotes(): StoredNote[] {
        return this.orm
            .select()
            .from(notesTable)
            .orderBy(asc(notesTable.documentUri), asc(notesTable.startLine), asc(notesTable.createdAt))
            .all()
            .map(rowToNote);
    }

    public updateNoteBody(noteId: string, body: string, updatedAt: number): StoredNote | undefined {
        const row = this.orm
            .update(notesTable)
            .set({ body, updatedAt })
            .where(eq(notesTable.id, noteId))
            .returning()
            .get();

        return row ? rowToNote(row) : undefined;
    }

    public deleteNote(noteId: string): boolean {
        return this.deleteNotes([noteId]) > 0;
    }

    public deleteNotes(noteIds: readonly string[]): number {
        if (noteIds.length === 0) {
            return 0;
        }

        return this.orm
            .delete(notesTable)
            .where(inArray(notesTable.id, [...noteIds]))
            .returning({ id: notesTable.id })
            .all().length;
    }

    public deleteNotesForDocument(documentUri: string): number {
        return this.orm
            .delete(notesTable)
            .where(eq(notesTable.documentUri, documentUri))
            .returning({ id: notesTable.id })
            .all().length;
    }

    public moveNotesToDocument(fromDocumentUri: string, toDocumentUri: string, updatedAt: number): number {
        return this.orm
            .update(notesTable)
            .set({ documentUri: toDocumentUri, updatedAt })
            .where(eq(notesTable.documentUri, fromDocumentUri))
            .returning({ id: notesTable.id })
            .all().length;
    }

    public moveNotesToDocumentPrefix(fromDocumentUriPrefix: string, toDocumentUriPrefix: string, updatedAt: number): number {
        const escapedPrefix = escapeLikePattern(fromDocumentUriPrefix);
        const likePattern = `${escapedPrefix}%`;
        const prefixLength = fromDocumentUriPrefix.length;

        return this.orm
            .update(notesTable)
            .set({
                documentUri: sql`${toDocumentUriPrefix} || substr(${notesTable.documentUri}, ${prefixLength + 1})`,
                updatedAt
            })
            .where(sql`${notesTable.documentUri} LIKE ${likePattern} ESCAPE '\\'`)
            .returning({ id: notesTable.id })
            .all().length;
    }

    public deleteExpiredNotes(expiresAtOrBefore: number): number {
        return this.orm
            .delete(notesTable)
            .where(lte(notesTable.updatedAt, expiresAtOrBefore))
            .returning({ id: notesTable.id })
            .all().length;
    }
}

function escapeLikePattern(value: string): string {
    return value.replace(/([%_\\])/g, '\\$1');
}

function noteToRow(note: StoredNote): NewNoteRow {
    return {
        id: note.id,
        documentUri: note.documentUri,
        workspaceFolderUri: note.workspaceFolderUri,
        startLine: note.range.startLine,
        startCharacter: note.range.startCharacter,
        endLine: note.range.endLine,
        endCharacter: note.range.endCharacter,
        selectedText: note.selectedText,
        body: note.body,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt
    };
}

function rowToNote(row: NoteRow): StoredNote {
    const range: NoteRange = {
        startLine: row.startLine,
        startCharacter: row.startCharacter,
        endLine: row.endLine,
        endCharacter: row.endCharacter
    };

    return {
        id: row.id,
        documentUri: row.documentUri,
        workspaceFolderUri: row.workspaceFolderUri,
        range,
        selectedText: row.selectedText,
        body: row.body,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    };
}
