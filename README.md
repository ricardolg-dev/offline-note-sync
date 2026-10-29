# offline-note-sync

My solution to [case 05 of Alvorada Dev's technical challenge](https://github.com/Alvorada-Dev/desafios-tecnicos/blob/main/casos/05-sincronizacao-de-notas.md): the server side of syncing notes edited on devices that are often offline. A device sends its queue of edits, and the server applies each one or answers with a conflict that keeps the rejected text, so nobody's work is overwritten without them knowing. The full rules, decisions and phases are in [docs/implementation-plan.md](docs/implementation-plan.md).

- **Focus:** back-end.
- **Time spent:** about four hours, split into short sessions.
- **Video:** [walkthrough on Google Drive](https://drive.google.com/file/d/1QXS_YdHCk0fIMc7zHRTf3I-JuYN6QMMR/view?usp=sharing).

## Install and run

You need Node 22.12 or newer and Docker.

```sh
npm install
cp apps/api/.env.example apps/api/.env
docker compose up -d
npm run db:migrate
npm run dev:api
```

Postgres listens on port 54329 and the API on port 3000. `npm run dev:api` turns on `POST /dev/reset`, which deletes every note and operation, and the demo below uses it to start clean.

## Demo

The case's example, one step at a time, with curl against the API started above. Run the steps in order in a second terminal (bash or zsh).

**1. Set up.** `N` is the note and `O1` to `O4` are the operations, each one an edit with its own id. `send` posts one operation to `POST /sync` with its id, the revision the device last saw and the new text, and the reset at the end starts the demo clean.

```sh
N=6f1c2a4e-8b3d-4c5e-9a7f-1d2e3f4a5b6c
O1=11111111-1111-4111-8111-111111111111
O2=22222222-2222-4222-8222-222222222222
O3=33333333-3333-4333-8333-333333333333
O4=44444444-4444-4444-8444-444444444444

send() {
  curl -s -X POST localhost:3000/sync -H 'content-type: application/json' \
    -d "{\"operations\":[{\"op_id\":\"$1\",\"note_id\":\"$N\",\"base_revision\":$2,\"text\":\"$3\"}]}"
  echo
}

curl -s -X POST localhost:3000/dev/reset
```

**2. Create and read a note.** Base revision 0 means a new note, so the create is `applied` at revision 1, and `GET /notes/:id` reads it back.

```sh
send $O1 0 'início'
curl -s localhost:3000/notes/$N; echo
```

**3. Edit it.** O2 edits from revision 1, the current one, so it is `applied` at revision 2.

```sh
send $O2 1 'edição A'
```

**4. Edit from an old revision.** O3 was also written offline from revision 1, so it gets a `conflict` showing the server's note at revision 2 and its own text as `rejected_text`, and nothing is overwritten.

```sh
send $O3 1 'edição B'
```

**5. Resend after a lost answer.** O2's answer got lost, so it is sent again and gets the same saved result, and the note stays at revision 2.

```sh
send $O2 1 'edição A'
```

**6. Resolve the conflict.** O4 merges both texts and is sent from revision 2, which is `applied` at revision 3.

```sh
send $O4 2 'A + B'
curl -s localhost:3000/notes/$N; echo
```

## Test

```sh
npm test
```

The tests need Postgres up. They run on their own database, `offline_note_sync_test`, which they create and migrate on the same server, so they never touch the API's data.

There are three test files in `apps/api/test`:

- **`parse-operation.spec.ts`** checks which operations are valid, with no database.
- **`sync.service.spec.ts`** checks the sync rules on Postgres, including the case's example, resends and requests that arrive at the same moment.
- **`sync.e2e.spec.ts`** sends real HTTP requests to the app and checks its answers.

## The API

- `POST /sync` takes `{ "operations": [...] }` with 1-100 operations and answers `{ "results": [...] }`, one result per operation, in the order sent.
- `GET /notes` lists every note, and `GET /notes/:id` reads one at its latest revision.
- `GET /notes/:id/revisions?after=&limit=` pages the history of a note, so a device that was offline can catch up revision by revision. See below.
- `POST /dev/reset` deletes everything, and only exists when `ENABLE_DEV_ROUTES=true`.

An operation is `{ op_id, note_id, base_revision, text }`, where the device creates both UUIDs and sends base 0 to create a note. Each result has one of these statuses:

- `applied`: the edit was accepted, and the result shows the note right after it.
- `conflict`: the edit started from an old revision, so the result shows the server's note and the `rejected_text`.
- `note_not_found`: an edit with base above 0 names a note the server doesn't have, so the result keeps the `rejected_text`.
- `op_id_reused`: the `op_id` already belongs to a different edit.
- `invalid`: a field is wrong, and `errors` lists which ones.

The first three are saved with the operation, so resending the same operation returns the same result without applying anything. The last two are not saved, which leaves an invalid operation's `op_id` free to be fixed and sent again.

## Revision history

A device that was offline for a while only knows the last revision it saw. `GET /notes/:id/revisions` lets it catch up with what happened to a note since then, one page at a time:

- `after` (default `0`) is the last revision the device already has. The page holds the revisions **after** it, oldest first, so `after=0` starts from the creation.
- `limit` (default `20`) is how many revisions fit in a page, from 1 to 100.
- Each item is a revision the note went through, with its number and the text it had at that revision.
- `next_after` is the `after` to send for the next page, and `has_more` says whether there is one.
- `404` means the note does not exist. A device that is already up to date gets `200` with an empty page.

## Three tests worth reading

1. **A `note_not_found` edit stays `note_not_found` after the note exists** (`apps/api/test/sync.service.spec.ts`). An edit with base 1 reaches the server before its note exists, another operation then creates the note, and the edit is resent. Its base now matches, but it must still get `note_not_found`, and the test fails if the server decides a resend again instead of returning the saved result.
2. **Base 0 on an existing note is a conflict, and an unchanged edit raises the revision** (`apps/api/test/sync.service.spec.ts`). It fails if a create overwrites an existing note, or if an edit whose text didn't change is skipped instead of counted.
3. **An invalid operation followed by valid ones in the same request** (`apps/api/test/sync.e2e.spec.ts`). One request sends an invalid operation, the fixed version under the same `op_id`, and another operation, and gets `invalid`, `applied`, `applied`. It fails if the invalid operation takes its `op_id` so the fixed one can't use it, or if one bad operation stops the rest of the queue.

The concurrency tests in the service spec are also worth a look: they send two creates of the same note, two edits from the same revision, the same operation twice, and one `op_id` on two notes at the same moment, and each must end with exactly one winner.

## Two decisions

**Advisory locks instead of retries.** Each operation runs in its own transaction that locks the `op_id` and then the `note_id`, so requests touching the same operation or note wait in line instead of racing. Advisory locks work before a row exists, which a row lock can't, and the unique keys stay as a safety net. I would switch to serializable transactions with retries if lock waits started to hurt latency.

**Store every valid operation with its result.** Applied, conflict and `note_not_found` operations are saved, and a resend rebuilds its result from the saved row instead of deciding again, which is why a resent O3 still shows revision 2. Invalid operations aren't saved, so the device can fix one and resend it under the same `op_id`. The cost is that the `operations` table only grows.

## Not built, and why

- **A two-device UI simulator:** it doesn't fit the time budget, and the curl walkthrough above already shows two devices step by step.
- **Live updates (SSE):** only useful with a UI showing two devices.
- **Real-time co-editing:** it needs automatic merging, which the case forbids.
- **Cleanup of old operations:** not needed at this size, and applied operations can never be deleted, since they hold each note's history.
- **Users and auth:** not part of the case, so an `op_id` is unique across all devices where a real product would scope it per user.

## How AI was used

I wrote the plan in `docs/implementation-plan.md` with Claude before any code existed, and Claude Code then built it one phase per session. I checked its work in three ways:

- **Against the case.** I compared each proposal with the case text to confirm it followed the rules and stayed within scope.
- **By reading every diff.** I reviewed each phase's changes before moving on, and asked for rewrites when names, types or structure were hard to follow.
- **With tests that must fail.** For the key rules, I broke the code on purpose and confirmed the tests caught it.
