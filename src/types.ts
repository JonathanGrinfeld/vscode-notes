export interface NoteRange {
    readonly startLine: number;
    readonly startCharacter: number;
    readonly endLine: number;
    readonly endCharacter: number;
}

export interface CreateNoteInput {
    readonly documentUri: string;
    readonly workspaceFolderUri: string | null;
    readonly range: NoteRange;
    readonly selectedText: string;
    readonly body: string;
}

export interface StoredNote extends CreateNoteInput {
    readonly id: string;
    readonly createdAt: number;
    readonly updatedAt: number;
}
