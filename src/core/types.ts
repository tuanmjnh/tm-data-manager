/** Canonical DTOs shared by CLI, API server, GUI and providers. */

export const CANONICAL_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'timestamp',
  'date',
  'json',
  'binary',
  'unknown',
] as const;
export type CanonicalType = (typeof CANONICAL_TYPES)[number];

export type Environment = 'local' | 'development' | 'staging' | 'production' | 'custom';
export const ENVIRONMENTS: Environment[] = ['local', 'development', 'staging', 'production', 'custom'];

/** A single row. Nested values keep their JSON shape; binary becomes base64. */
export type Row = Record<string, unknown>;
export type RowBatch = Row[];

export interface ColumnSchema {
  name: string;
  type: CanonicalType;
  /** Provider-declared type string, e.g. `varchar(255)`, `int4`, `bson`. */
  nativeType?: string;
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface ResourceSchema {
  resource: string;
  columns: ColumnSchema[];
  rowCountEstimate?: number | null;
  /** `sampled` when inferred from documents (MongoDB), `declared` for SQL. */
  source: 'declared' | 'sampled' | 'inferred';
}

/** Hard ceiling for the interactive browse view (never a full table scan). */
export const PREVIEW_ROW_LIMIT = 100;

export interface RowsPreview {
  resource: string;
  columns: ColumnSchema[];
  rows: RowBatch;
  limit: number;
  /** True when the resource holds at least `limit` rows. */
  truncated: boolean;
  latency_ms: number;
}

export interface ResourceDescriptor {
  /** Stable provider-scoped id, e.g. `main.users`, `app.customers`. */
  id: string;
  /** Namespace used to address the resource in operations. */
  namespace: string;
  name: string;
  type: 'table' | 'view' | 'collection' | 'database' | 'schema';
  metadata?: Record<string, unknown>;
}

export type CapabilityId =
  | 'test_connection'
  | 'discover_resources'
  | 'read_data'
  | 'write_data'
  | 'schema_read'
  | 'schema_write'
  | 'bulk_write'
  | 'transactions'
  | 'consistent_snapshot'
  | 'query'
  | 'native_backup'
  | 'native_restore';

export interface CapabilityDescriptor {
  id: CapabilityId;
  supported: boolean;
  /** Human-readable limits, e.g. "append/truncate only, no partial upsert". */
  constraints?: string[];
}

export interface ServiceProfile {
  id: string;
  display_name: string;
  /** Notes shown in the UI, e.g. Supabase connection pooler advice. */
  notes?: string[];
}

export interface ProviderDescriptor {
  provider_id: string;
  display_name: string;
  version: string;
  built_in: boolean;
  capabilities: CapabilityDescriptor[];
  service_profiles: ServiceProfile[];
  /** JSON-schema-ish description used by the GUI to render the connection form. */
  config_fields: ProviderConfigField[];
  /** Secret fields never rendered with their stored value. */
  secret_fields: string[];
}

export interface ProviderConfigField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'path';
  required: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface ConnectionRecord {
  id: string;
  name: string;
  provider_id: string;
  service_profile: string | null;
  config: Record<string, unknown>;
  credential_ref: string | null;
  environment: Environment;
  description: string | null;
  default_storage_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  last_tested_at: string | null;
  last_test_status: 'success' | 'failed' | null;
  /** Sanitized endpoint summary for list views. */
  endpoint_hint: string | null;
}

export interface ConnectionTestResult {
  success: boolean;
  provider_id: string;
  service_profile: string | null;
  server_version: string | null;
  latency_ms: number;
  database: string | null;
  diagnostics: string[];
  detected_capabilities: CapabilityId[];
  tested_at: string;
  error?: { code: string; message: string };
}

export interface ArtifactRecord {
  id: string;
  run_id: string;
  artifact_type: string;
  provider_id: string | null;
  storage_backend_id: string;
  object_key: string;
  absolute_path: string;
  manifest: ArtifactManifest;
  size_bytes: number;
  checksum_algorithm: 'sha256';
  checksum_value: string;
  verification_status: 'unverified' | 'verified' | 'failed';
  verified_at: string | null;
  restore_test_status: string | null;
  created_at: string;
  expires_at: string | null;
  pinned: boolean;
}

export interface ArtifactManifest {
  manifest_version: '1';
  artifact_id: string;
  operation_type: OperationType;
  provider_id: string;
  service_profile: string | null;
  source_connection_id: string | null;
  source_label: string | null;
  target_connection_id?: string | null;
  target_label?: string | null;
  resource: string | null;
  created_at: string;
  tool_name: 'udmt';
  tool_version: string;
  format: ExportFormat;
  compression: 'none' | 'gzip';
  columns: ColumnSchema[];
  row_count: number;
  batch_size: number;
  files: Array<{ name: string; size_bytes: number; checksum_sha256: string }>;
  resource_count?: number;
  status: 'completed' | 'completed_with_warnings' | 'partial';
  warnings: string[];
  /** Managed artifacts live under the app data dir; external paths were explicitly chosen. */
  output_mode?: 'managed' | 'external';
}

export type ExportFormat = 'jsonl' | 'csv' | 'json';
export const EXPORT_FORMATS: ExportFormat[] = ['jsonl', 'csv', 'json'];
export type Compression = 'none' | 'gzip';

export type OperationType = 'export' | 'import' | 'verify';
export type OperationStatus =
  | 'queued'
  | 'preparing'
  | 'preflight'
  | 'running'
  | 'finalizing'
  | 'verifying'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted'
  | 'retry_waiting';

export interface OperationRun {
  id: string;
  job_id: string | null;
  operation_type: OperationType;
  status: OperationStatus;
  source_connection_id: string | null;
  target_connection_id: string | null;
  source_label: string | null;
  target_label: string | null;
  resource: string | null;
  stage: string | null;
  progress: RunProgress | null;
  config: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message_safe: string | null;
  retry_of_run_id: string | null;
  worker_instance_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface RunProgress {
  percent: number;
  stage: string;
  message?: string;
  rows_read?: number;
  rows_written?: number;
  bytes_written?: number;
  warnings?: string[];
}

export interface OperationLogEntry {
  id: number;
  run_id: string;
  sequence: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  stage: string | null;
  message: string;
  created_at: string;
}

export interface ExportRequest {
  connection_id: string;
  resource: string;
  format: ExportFormat;
  compression: Compression;
  output_dir?: string;
  limit?: number;
  batch_size?: number;
  columns?: string[];
  /** Explicit local filter is provider-specific and therefore opt-in. */
  storage_backend_id?: string;
  label?: string;
}

export interface ImportRequest {
  connection_id: string;
  resource: string;
  /** Artifact id from the catalog, or an absolute/relative file path. */
  source: { artifact_id?: string; path?: string };
  format?: ExportFormat;
  mode: 'append' | 'upsert' | 'truncate_and_load';
  key_columns?: string[];
  batch_size?: number;
  dry_run?: boolean;
  /** Explicit confirmation for destructive targets (roadmap 7.3). */
  confirm?: string;
  create_resource?: boolean;
}

export interface ScheduleRecord {
  id: string;
  job_id: string;
  schedule_type: 'once' | 'interval' | 'daily' | 'weekly' | 'monthly';
  schedule_config: Record<string, unknown>;
  timezone: string;
  misfire_policy: 'skip' | 'run_once_on_recovery';
  overlap_policy: 'forbid' | 'allow';
  next_run_at: string | null;
  last_run_at: string | null;
  enabled: boolean;
}

export interface JobRecord {
  id: string;
  name: string;
  operation_type: OperationType;
  source_connection_id: string | null;
  target_connection_id: string | null;
  storage_backend_id: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface StorageBackendRecord {
  id: string;
  name: string;
  backend_type: 'local';
  config: Record<string, unknown>;
  credential_ref: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkerInstance {
  id: string;
  pid: number;
  hostname: string;
  version: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';
  started_at: string;
  heartbeat_at: string;
  last_error: string | null;
  tasks_running: number;
}

export interface DoctorReport {
  app_version: string;
  data_dir: string;
  db_path: string;
  artifacts_dir: string;
  node_version: string;
  platform: string;
  secret_backend: string;
  secret_warning: string | null;
  db_integrity: 'ok' | 'failed';
  providers: ProviderDescriptor[];
  worker: { running: boolean; instance: WorkerInstance | null };
  counts: { connections: number; runs: number; artifacts: number; schedules: number };
}
