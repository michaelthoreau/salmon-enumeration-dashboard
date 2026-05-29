import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export type Role = 'read' | 'read-write' | 'admin'
export type Split = 'train' | 'val' | 'test'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  role: text('role').$type<Role>().notNull().default('read'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  role: text('role').$type<Role>().notNull().default('read'),
  invitedBy: text('invited_by').notNull(), // userId of admin
  sentAt: integer('sent_at', { mode: 'timestamp' }).notNull(),
  acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
})

export const otps = sqliteTable('otps', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── Data management ──────────────────────────────────────────────────────────

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(), // used in S3 path
  description: text('description'),
  timezone: text('timezone').notNull().default('America/Anchorage'), // IANA timezone name
  createdBy: text('created_by').notNull(), // userId
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }), // soft delete
})

export const flightPlans = sqliteTable('flight_plans', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(), // FK → projects.id (no cascade)
  name: text('name').notNull(), // unique within project, used in S3 path
  description: text('description'),
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
})

export const flights = sqliteTable('flights', {
  id: text('id').primaryKey(), // UUID used in S3 path
  flightPlanId: text('flight_plan_id').notNull(), // FK → flight_plans.id (no cascade)
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(), // used in S3 path
  notes: text('notes'),
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
})

// ─── Files ────────────────────────────────────────────────────────────────────

export const files = sqliteTable('files', {
  id: text('id').primaryKey(), // UUID
  flightId: text('flight_id').notNull(), // FK → flights.id
  key: text('key').notNull().unique(), // S3 object key
  etag: text('etag').notNull(), // S3 ETag (MD5 hex, quotes stripped)
  split: text('split').$type<Split>(), // train | val | test; null = unallocated
  uploadedAt: integer('uploaded_at', { mode: 'timestamp' }).notNull(),
  uploadedBy: text('uploaded_by').notNull(), // userId
})

// ─── File Points ──────────────────────────────────────────────────────────────

export const filePoints = sqliteTable('file_points', {
  id: text('id').primaryKey(), // UUID
  fileId: text('file_id').notNull(), // FK → files.id
  x: real('x').notNull(),
  y: real('y').notNull(),
  frame: integer('frame').notNull().default(0), // 0 for images; frame number for videos
})

// ─── Labeling Tasks ───────────────────────────────────────────────────────────

export const labelingTasks = sqliteTable('labeling_tasks', {
  id: text('id').primaryKey(), // UUID
  fileId: text('file_id').notNull(), // FK → files.id
  x1: real('x1').notNull(), // crop region in source pixels
  y1: real('y1').notNull(),
  x2: real('x2').notNull(),
  y2: real('y2').notNull(),
  frame: integer('frame').notNull().default(0), // 0 for images; frame number for videos
  completedBy: text('completed_by'), // userId; null = incomplete
  createdBy: text('created_by').notNull(), // userId
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── Labeling Task Points ─────────────────────────────────────────────────────

export const labelingTaskPoints = sqliteTable('labeling_task_points', {
  id: text('id').primaryKey(), // UUID
  taskId: text('task_id').notNull(), // FK → labeling_tasks.id
  x: real('x').notNull(), // pixels from left edge of task tile
  y: real('y').notNull(), // pixels from top edge of task tile
  createdBy: text('created_by').notNull(), // userId
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ─── ODM Processing Tasks ─────────────────────────────────────────────────────

export type OdmTaskStatus = 'uploading' | 'queued' | 'running' | 'failed' | 'completed' | 'canceled'

export const odmTasks = sqliteTable('odm_tasks', {
  id: text('id').primaryKey(), // UUID (our internal ID)
  flightId: text('flight_id').notNull(), // FK → flights.id
  odmUuid: text('odm_uuid').notNull(), // UUID assigned by NodeODM
  status: text('status').$type<OdmTaskStatus>().notNull().default('uploading'),
  totalImages: integer('total_images'), // number of images to upload; set at creation
  outputKey: text('output_key'), // S3 key of the collected GeoTIFF; null until complete
  reportKey: text('report_key'), // S3 key of the ODM PDF report; null until complete
  createdBy: text('created_by').notNull(), // userId
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
})

// ─── API Keys ──────────────────────────────────────────────────────────────────

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(), // UUID
  name: text('name').notNull(), // human label
  keyHash: text('key_hash').notNull().unique(), // SHA-256 hex of the raw key
  createdBy: text('created_by').notNull(), // userId of admin
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
})
