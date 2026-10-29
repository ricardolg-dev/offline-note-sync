import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule, configureApp } from '../src/app.ts';
import { DevController } from '../src/dev.controller.ts';
import { MAX_TEXT_BYTES } from '../src/domain/parse-operation.ts';
import type { OperationResult } from '../src/domain/model.ts';
import type { Env } from '../src/env.ts';
import { MAX_OPERATIONS_PER_REQUEST, MAX_REVISIONS_PER_PAGE } from '../src/sync.controller.ts';
import { SyncService } from '../src/sync.service.ts';
import { note, noteId, otherNoteId, uuid } from './fixtures.ts';

let app: NestExpressApplication;
let baseUrl: string;

beforeAll(async () => {
  const testingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(
    testingModule.createNestApplication<NestExpressApplication>({ logger: false }),
  );
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await post('/dev/reset');
});

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function sync(operations: unknown[]): Promise<OperationResult[]> {
  const response = await post('/sync', { operations });
  expect(response.status).toBe(200);
  const { results } = (await response.json()) as { results: OperationResult[] };
  return results;
}

describe('POST /sync', () => {
  it('3: X invalid, X valid, Y valid gives invalid, applied, applied', async () => {
    const [operationX, operationY] = [uuid(1), uuid(2)];

    expect(
      await sync([
        { op_id: operationX, note_id: noteId, base_revision: 0, text: 'bad\u0000' },
        { op_id: operationX, note_id: noteId, base_revision: 0, text: 'good' },
        { op_id: operationY, note_id: otherNoteId, base_revision: 0, text: 'other' },
      ]),
    ).toEqual([
      {
        op_id: operationX,
        status: 'invalid',
        errors: [{ field: 'text', message: 'must not contain U+0000' }],
      },
      { op_id: operationX, status: 'applied', note: note('good', 1) },
      { op_id: operationY, status: 'applied', note: note('other', 1, otherNoteId) },
    ]);
  });

  it('keeps going after an invalid operation in the middle of the queue', async () => {
    const results = await sync([
      { op_id: uuid(1), note_id: noteId, base_revision: 0, text: 'a' },
      { op_id: uuid(2) },
      'not an operation',
      { op_id: uuid(3), note_id: noteId, base_revision: 1, text: 'b' },
    ]);
    expect(results).toEqual([
      { op_id: uuid(1), status: 'applied', note: note('a', 1) },
      { op_id: uuid(2), status: 'invalid', errors: expect.any(Array) as unknown },
      { op_id: null, status: 'invalid', errors: expect.any(Array) as unknown },
      { op_id: uuid(3), status: 'applied', note: note('b', 2) },
    ]);
  });

  it('answers invalid for a stored op_id sent with a bad field, and keeps the stored result', async () => {
    const sent = { op_id: uuid(1), note_id: noteId, base_revision: 0, text: 'a' };
    const [firstResult] = await sync([sent]);

    expect(await sync([{ ...sent, base_revision: -1 }])).toEqual([
      { op_id: uuid(1), status: 'invalid', errors: expect.any(Array) as unknown },
    ]);
    expect(await sync([sent])).toEqual([firstResult]);
  });

  it('ignores extra fields when comparing a resend', async () => {
    const sent = { op_id: uuid(1), note_id: noteId, base_revision: 0, text: 'a' };
    const firstResults = await sync([{ ...sent, device: 'phone' }]);
    expect(await sync([{ ...sent, device: 'laptop', sent_at: 1 }])).toEqual(firstResults);
  });

  it(`accepts ${String(MAX_OPERATIONS_PER_REQUEST)} operations with the largest text`, async () => {
    const operations = Array.from({ length: MAX_OPERATIONS_PER_REQUEST }, (_, index) => ({
      op_id: uuid(index + 1),
      note_id: uuid(1000 + index),
      base_revision: 0,
      text: 'a'.repeat(MAX_TEXT_BYTES),
    }));
    const results = await sync(operations);
    expect(results).toHaveLength(MAX_OPERATIONS_PER_REQUEST);
    expect(results.every((result) => result.status === 'applied')).toBe(true);
  });

  it.each([
    ['no operations field', {}],
    ['an empty list', { operations: [] }],
    [
      'more operations than allowed',
      { operations: Array.from({ length: MAX_OPERATIONS_PER_REQUEST + 1 }, () => ({})) },
    ],
    ['operations that are not a list', { operations: 'all of them' }],
  ])('rejects a request with %s', async (_, body) => {
    const response = await post('/sync', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: 'invalid sync request',
      errors: [{ field: 'operations' }],
    });
  });

  it('rejects a body that is not JSON', async () => {
    const response = await fetch(`${baseUrl}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"operations": [',
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /notes', () => {
  it('lists every note', async () => {
    await sync([
      { op_id: uuid(1), note_id: noteId, base_revision: 0, text: 'a' },
      { op_id: uuid(2), note_id: otherNoteId, base_revision: 0, text: 'b' },
      { op_id: uuid(3), note_id: noteId, base_revision: 1, text: 'c' },
    ]);
    const response = await fetch(`${baseUrl}/notes`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([note('c', 2), note('b', 1, otherNoteId)]);
  });

  it('reads one note at its latest revision', async () => {
    await sync([
      { op_id: uuid(1), note_id: noteId, base_revision: 0, text: 'a' },
      { op_id: uuid(2), note_id: noteId, base_revision: 1, text: 'b' },
    ]);
    const response = await fetch(`${baseUrl}/notes/${noteId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(note('b', 2));
  });

  it('answers 404 for a note that does not exist', async () => {
    expect((await fetch(`${baseUrl}/notes/${noteId}`)).status).toBe(404);
  });

  it('answers 400 for an id that is not a UUID', async () => {
    expect((await fetch(`${baseUrl}/notes/not-a-uuid`)).status).toBe(400);
  });
});

describe('POST /dev/reset', () => {
  it('deletes every note and operation', async () => {
    await sync([{ op_id: uuid(1), note_id: noteId, base_revision: 0, text: 'a' }]);

    expect((await post('/dev/reset')).status).toBe(204);
    expect(await (await fetch(`${baseUrl}/notes`)).json()).toEqual([]);
    expect(await sync([{ op_id: uuid(1), note_id: noteId, base_revision: 0, text: 'b' }])).toEqual([
      { op_id: uuid(1), status: 'applied', note: note('b', 1) },
    ]);
  });

  it('answers 404 when dev routes are off', async () => {
    const config = { get: () => false } as unknown as ConfigService<Env, true>;
    const devController = new DevController(config, app.get(SyncService));
    await expect(devController.resetDatabase()).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GET /notes/:id/revisions', () => {
  async function revisions(query = ''): Promise<Response> {
    return fetch(`${baseUrl}/notes/${noteId}/revisions${query}`);
  }

  it('pages the revisions of a note in order', async () => {
    await sync([
      { op_id: uuid(1), note_id: noteId, base_revision: 0, text: 'a' },
      { op_id: uuid(2), note_id: noteId, base_revision: 1, text: 'b' },
      { op_id: uuid(3), note_id: noteId, base_revision: 2, text: 'c' },
    ]);
    const response = await revisions('?limit=2');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      note_id: noteId,
      revisions: [
        { revision: 1, text: 'a' },
        { revision: 2, text: 'b' },
      ],
      next_after: 2,
      has_more: true,
    });
  });

  it('keeps revisions of other notes out', async () => {
    await sync([
      { op_id: uuid(1), note_id: noteId, base_revision: 0, text: 'a' },
      { op_id: uuid(2), note_id: otherNoteId, base_revision: 0, text: 'b' },
    ]);
    const response = await revisions();
    expect(await response.json()).toEqual({
      note_id: noteId,
      revisions: [{ revision: 1, text: 'a' }],
      next_after: 1,
      has_more: false,
    });
  });

  it('answers 404 for a note that does not exist', async () => {
    expect((await revisions()).status).toBe(404);
  });

  it(`answers 400 for a limit above ${String(MAX_REVISIONS_PER_PAGE)} or a negative after`, async () => {
    expect((await revisions(`?limit=${String(MAX_REVISIONS_PER_PAGE + 1)}`)).status).toBe(400);
    expect((await revisions('?after=-1')).status).toBe(400);
  });
});
