-- Outbound image attachments. Base64 is stored on the row; the local sender
-- (outbox / batches) uploads it to Beeper via POST /v1/assets/upload/base64 and
-- references the returned uploadID on send. One image per draft / per batch.
alter table inbox_drafts
  add column if not exists attachment_data text,
  add column if not exists attachment_name text,
  add column if not exists attachment_mime text;

alter table inbox_batches
  add column if not exists attachment_data text,
  add column if not exists attachment_name text,
  add column if not exists attachment_mime text;
