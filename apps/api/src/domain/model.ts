export type Note = {
  id: string;
  text: string;
  revision: number;
};

export type Operation = {
  op_id: string;
  note_id: string;
  base_revision: number;
  text: string;
};

export type NoteRevision = {
  revision: number;
  text: string;
};

export type RevisionPage = {
  note_id: string;
  revisions: NoteRevision[];
  next_after: number;
  has_more: boolean;
};

export type FieldError = {
  field: string | null;
  message: string;
};

export type OperationResult =
  | { op_id: string; status: 'applied'; note: Note }
  | { op_id: string; status: 'conflict'; note: Note; rejected_text: string }
  | { op_id: string; status: 'note_not_found'; note_id: string; rejected_text: string }
  | { op_id: string; status: 'op_id_reused' }
  | { op_id: string | null; status: 'invalid'; errors: FieldError[] };

export type InvalidResult = Extract<OperationResult, { status: 'invalid' }>;

export type SavedResult = Extract<
  OperationResult,
  { status: 'applied' | 'conflict' | 'note_not_found' }
>;

export type StoredOperation = {
  operation: Operation;
  result: SavedResult;
};
