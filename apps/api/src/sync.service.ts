import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database, type Transaction } from './db/database.module.ts';
import type {
  Note,
  Operation,
  OperationResult,
  RevisionPage,
  SavedResult,
  StoredOperation,
} from './domain/model.ts';
import { SyncRepository } from './sync.repository.ts';

const BASE_REVISION_OF_NEW_NOTE = 0;
const FIRST_REVISION = 1;

@Injectable()
export class SyncService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SyncRepository) private readonly repository: SyncRepository,
  ) {}

  syncOperation(operation: Operation): Promise<OperationResult> {
    return this.database.transaction(
      async (transaction) => {
        await this.repository.lockOperationId(transaction, operation.op_id);
        await this.repository.lockNoteId(transaction, operation.note_id);
        const stored = await this.repository.findStoredOperation(transaction, operation.op_id);
        if (stored) {
          return answerResentOperation(operation, stored);
        }
        return this.saveNewOperation(transaction, operation);
      },
      { isolationLevel: 'read committed' },
    );
  }

  readNote(noteId: string): Promise<Note | undefined> {
    return this.repository.findNote(this.database, noteId);
  }

  listNotes(): Promise<Note[]> {
    return this.repository.listNotes(this.database);
  }

  async readRevisions(noteId: string, after: number, limit: number): Promise<RevisionPage> {
    const rows = await this.repository.listRevisions(this.database, noteId, after, limit + 1);
    const revisions = rows.slice(0, limit);
    return {
      note_id: noteId,
      revisions,
      next_after: revisions.at(-1)?.revision ?? after,
      has_more: rows.length > limit,
    };
  }

  deleteAllNotesAndOperations(): Promise<void> {
    return this.repository.deleteAllNotesAndOperations(this.database);
  }

  private async saveNewOperation(
    transaction: Transaction,
    operation: Operation,
  ): Promise<SavedResult> {
    const currentNote = await this.repository.findNote(transaction, operation.note_id);
    const result = decideNewOperation(operation, currentNote);
    await this.repository.insertOperation(transaction, operation, result);
    if (result.status !== 'applied') {
      return result;
    }
    if (currentNote) {
      await this.repository.updateNote(transaction, result.note);
    } else {
      await this.repository.insertNote(transaction, result.note);
    }
    return result;
  }
}

function answerResentOperation(resent: Operation, stored: StoredOperation): OperationResult {
  return hasSameContent(resent, stored.operation)
    ? stored.result
    : { op_id: resent.op_id, status: 'op_id_reused' };
}

function hasSameContent(resent: Operation, original: Operation): boolean {
  return (
    resent.note_id === original.note_id &&
    resent.base_revision === original.base_revision &&
    resent.text === original.text
  );
}

function decideNewOperation(operation: Operation, currentNote?: Note): SavedResult {
  const { op_id, note_id, base_revision, text } = operation;
  if (!currentNote && base_revision === BASE_REVISION_OF_NEW_NOTE) {
    return { op_id, status: 'applied', note: { id: note_id, text, revision: FIRST_REVISION } };
  }
  if (!currentNote) {
    return { op_id, status: 'note_not_found', note_id, rejected_text: text };
  }
  if (base_revision !== currentNote.revision) {
    return { op_id, status: 'conflict', note: currentNote, rejected_text: text };
  }
  return {
    op_id,
    status: 'applied',
    note: { id: note_id, text, revision: currentNote.revision + 1 },
  };
}
