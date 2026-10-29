import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import type { Note, OperationResult, RevisionPage } from './domain/model.ts';
import { parseOperation } from './domain/parse-operation.ts';
import { SyncService } from './sync.service.ts';

export const MAX_OPERATIONS_PER_REQUEST = 100;
export const MAX_REVISIONS_PER_PAGE = 100;
const DEFAULT_REVISIONS_PER_PAGE = 20;

const syncRequestSchema = z.object({
  operations: z.array(z.unknown()).min(1).max(MAX_OPERATIONS_PER_REQUEST),
});

const revisionsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().max(MAX_REVISIONS_PER_PAGE).default(DEFAULT_REVISIONS_PER_PAGE),
});

@Controller()
export class SyncController {
  constructor(@Inject(SyncService) private readonly syncService: SyncService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async syncOperations(@Body() body: unknown): Promise<{ results: OperationResult[] }> {
    const request = syncRequestSchema.safeParse(body);
    if (!request.success) {
      throw new BadRequestException({
        message: 'invalid sync request',
        errors: request.error.issues.map((issue) => ({
          field: issue.path.length > 0 ? issue.path.join('.') : null,
          message: issue.message,
        })),
      });
    }
    const results: OperationResult[] = [];
    for (const input of request.data.operations) {
      const parsed = parseOperation(input);
      results.push(
        parsed.valid ? await this.syncService.syncOperation(parsed.operation) : parsed.result,
      );
    }
    return { results };
  }

  @Get('notes')
  listNotes(): Promise<Note[]> {
    return this.syncService.listNotes();
  }

  @Get('notes/:id')
  async readNote(@Param('id', ParseUUIDPipe) noteId: string): Promise<Note> {
    const note = await this.syncService.readNote(noteId);
    if (!note) {
      throw new NotFoundException(`note ${noteId} not found`);
    }
    return note;
  }

  @Get('notes/:id/revisions')
  async readRevisions(
    @Param('id', ParseUUIDPipe) noteId: string,
    @Query() query: unknown,
  ): Promise<RevisionPage> {
    const request = revisionsQuerySchema.safeParse(query);
    if (!request.success) {
      throw new BadRequestException({
        message: 'invalid revisions query',
        errors: request.error.issues.map((issue) => ({
          field: issue.path.length > 0 ? issue.path.join('.') : null,
          message: issue.message,
        })),
      });
    }
    const page = await this.syncService.readRevisions(
      noteId,
      request.data.after,
      request.data.limit,
    );
    if (page.revisions.length === 0) {
      throw new NotFoundException(`note ${noteId} not found`);
    }
    return page;
  }
}
