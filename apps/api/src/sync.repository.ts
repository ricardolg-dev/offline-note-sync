import { Injectable } from '@nestjs/common';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database, Transaction } from './db/database.module.ts';
import { notes, operations } from './db/schema.ts';
import type {
  Note,
  NoteRevision,
  Operation,
  SavedResult,
  StoredOperation,
} from './domain/model.ts';

const OPERATION_LOCK_CLASS = 1;
const NOTE_LOCK_CLASS = 2;

const appliedOperations = alias(operations, 'applied_operations');

@Injectable()
export class SyncRepository {
  async lockOperationId(transaction: Transaction, operationId: string): Promise<void> {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${OPERATION_LOCK_CLASS}, hashtext(${operationId}))`,
    );
  }

  async lockNoteId(transaction: Transaction, noteId: string): Promise<void> {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${NOTE_LOCK_CLASS}, hashtext(${noteId}))`,
    );
  }

  async findStoredOperation(
    transaction: Transaction,
    operationId: string,
  ): Promise<StoredOperation | undefined> {
    const [row] = await transaction
      .select({ operation: operations, noteTextAtRevision: appliedOperations.text })
      .from(operations)
      .leftJoin(
        appliedOperations,
        and(
          eq(appliedOperations.noteId, operations.noteId),
          eq(appliedOperations.revision, operations.revision),
          eq(appliedOperations.status, 'applied'),
        ),
      )
      .where(eq(operations.opId, operationId));
    if (!row) {
      return undefined;
    }
    const { opId, noteId, baseRevision, text, status, revision } = row.operation;
    const operation = { op_id: opId, note_id: noteId, base_revision: baseRevision, text };
    return {
      operation,
      result: resultOfStoredOperation(operation, status, revision, row.noteTextAtRevision),
    };
  }

  async findNote(executor: Database | Transaction, noteId: string): Promise<Note | undefined> {
    const [note] = await executor.select().from(notes).where(eq(notes.id, noteId));
    return note;
  }

  listNotes(database: Database): Promise<Note[]> {
    return database.select().from(notes).orderBy(notes.id);
  }

  async listRevisions(
    database: Database,
    noteId: string,
    after: number,
    limit: number,
  ): Promise<NoteRevision[]> {
    const rows = await database
      .select({ revision: operations.revision, text: operations.text })
      .from(operations)
      .where(
        and(
          eq(operations.noteId, noteId),
          isNotNull(operations.revision),
          gte(operations.revision, after),
        ),
      )
      .orderBy(operations.opId)
      .limit(limit);
    return rows.flatMap(({ revision, text }) => (revision === null ? [] : [{ revision, text }]));
  }

  async deleteAllNotesAndOperations(database: Database): Promise<void> {
    await database.execute(sql`truncate ${notes}, ${operations}`);
  }

  async insertOperation(
    transaction: Transaction,
    operation: Operation,
    result: SavedResult,
  ): Promise<void> {
    await transaction.insert(operations).values({
      opId: operation.op_id,
      noteId: operation.note_id,
      baseRevision: operation.base_revision,
      text: operation.text,
      status: result.status,
      revision: result.status === 'note_not_found' ? null : result.note.revision,
    });
  }

  async insertNote(transaction: Transaction, note: Note): Promise<void> {
    await transaction.insert(notes).values(note).onConflictDoNothing();
  }

  async updateNote(transaction: Transaction, note: Note): Promise<void> {
    await transaction
      .update(notes)
      .set({ text: note.text, revision: note.revision })
      .where(eq(notes.id, note.id));
  }
}

function resultOfStoredOperation(
  operation: Operation,
  status: SavedResult['status'],
  revision: number | null,
  noteTextAtRevision: string | null,
): SavedResult {
  if (status === 'note_not_found') {
    return {
      op_id: operation.op_id,
      status,
      note_id: operation.note_id,
      rejected_text: operation.text,
    };
  }
  if (revision === null || noteTextAtRevision === null) {
    throw new Error(`operation ${operation.op_id} has no applied operation at its revision`);
  }
  const note = { id: operation.note_id, text: noteTextAtRevision, revision };
  return status === 'applied'
    ? { op_id: operation.op_id, status, note }
    : { op_id: operation.op_id, status, note, rejected_text: operation.text };
}
