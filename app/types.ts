export interface Capability {
  id: string
  supported: boolean
  constraints?: string[]
}

export interface ServiceProfile {
  id: string
  display_name: string
  notes?: string[]
}

export interface ConfigField {
  name: string
  label: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'path'
  required: boolean
  default?: string | number | boolean
  placeholder?: string
  help?: string
  options?: Array<{ value: string; label: string }>
}

export interface ProviderDescriptor {
  provider_id: string
  display_name: string
  version: string
  built_in: boolean
  capabilities: Capability[]
  service_profiles: ServiceProfile[]
  config_fields: ConfigField[]
  secret_fields: string[]
}

export interface Connection {
  id: string
  name: string
  provider_id: string
  service_profile: string | null
  config: Record<string, unknown>
  credential_ref: string | null
  environment: 'local' | 'development' | 'staging' | 'production' | 'custom'
  description: string | null
  is_active: boolean
  endpoint_hint: string | null
  created_at: string
  updated_at: string
  last_tested_at: string | null
  last_test_status: 'success' | 'failed' | null
}

export interface ColumnSchema {
  name: string
  type: string
  nativeType?: string
  nullable?: boolean
  primaryKey?: boolean
}

export interface ResourceSchema {
  resource: string
  columns: ColumnSchema[]
  rowCountEstimate?: number | null
  source: 'declared' | 'sampled' | 'inferred'
}

export interface ResourcePreview {
  resource: string
  columns: ColumnSchema[]
  rows: Array<Record<string, unknown>>
  limit: number
  truncated: boolean
  latency_ms: number
}

export interface ResourceDescriptor {
  id: string
  namespace: string
  name: string
  type: 'table' | 'view' | 'collection' | 'database' | 'schema'
  metadata?: Record<string, unknown>
}

export interface RunProgress {
  percent: number
  stage: string
  message?: string
  rows_read?: number
  rows_written?: number
  bytes_written?: number
}

export interface OperationRun {
  id: string
  job_id: string | null
  operation_type: 'export' | 'import' | 'verify'
  status: string
  source_connection_id: string | null
  target_connection_id: string | null
  source_label: string | null
  target_label: string | null
  resource: string | null
  stage: string | null
  progress: RunProgress | null
  config: Record<string, unknown>
  result: Record<string, unknown> | null
  error_code: string | null
  error_message_safe: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
}

export interface ArtifactManifest {
  manifest_version: string
  artifact_id: string
  operation_type: string
  provider_id: string
  service_profile: string | null
  source_connection_id: string | null
  source_label: string | null
  resource: string | null
  created_at: string
  tool_name: string
  tool_version: string
  format: 'jsonl' | 'csv' | 'json'
  compression: 'none' | 'gzip'
  columns: ColumnSchema[]
  row_count: number
  batch_size: number
  files: Array<{ name: string; size_bytes: number; checksum_sha256: string }>
  status: string
  warnings: string[]
  output_mode?: 'managed' | 'external'
}

export interface Artifact {
  id: string
  run_id: string
  artifact_type: string
  provider_id: string | null
  storage_backend_id: string
  object_key: string
  absolute_path: string
  manifest: ArtifactManifest
  size_bytes: number
  checksum_value: string
  verification_status: 'unverified' | 'verified' | 'failed'
  created_at: string
  expires_at: string | null
  pinned: boolean
}

export type StorageBackendType = 'local' | 's3'

export interface StorageBackendRecord {
  id: string
  name: string
  backend_type: StorageBackendType
  config: Record<string, unknown>
  credential_ref: string | null
  is_default: boolean
  endpoint_hint: string | null
  last_tested_at: string | null
  last_test_status: 'success' | 'failed' | null
  created_at: string
  updated_at: string
}

export interface StorageTestResult {
  success: boolean
  latency_ms: number
  diagnostics: string[]
  endpoint_hint: string | null
  tested_at: string
}

export interface LogEntry {
  id: number
  run_id: string
  sequence: number
  level: 'debug' | 'info' | 'warn' | 'error'
  stage: string | null
  message: string
  created_at: string
}

export interface ScheduleRow {
  id: string
  job_id: string
  schedule_type: string
  timezone: string
  description: string
  enabled: boolean
  next_run_at: string | null
  last_run_at: string | null
  overlap_policy: string
  misfire_policy: string
  job: { id: string; name: string; operation_type: string } | null
}

export interface WorkerStatus {
  running: boolean
  stale: boolean
  instance: {
    id: string
    pid: number
    hostname: string
    version: string
    status: string
    heartbeat_at: string
    tasks_running: number
    last_error: string | null
  } | null
  heartbeat_age_seconds: number | null
}

export interface DoctorReport {
  app_version: string
  data_dir: string
  db_path: string
  artifacts_dir: string
  node_version: string
  platform: string
  secret_backend: string
  secret_warning: string | null
  db_integrity: string
  providers: ProviderDescriptor[]
  worker: { running: boolean; instance: unknown }
  counts: { connections: number; runs: number; artifacts: number; schedules: number }
}

export interface Health {
  ok: boolean
  time: string
  version: string
  worker: { running: boolean; heartbeat_age_seconds: number | null }
  counts: { connections: number; runs: number; artifacts: number; schedules: number }
}

export interface ConnectionTestResult {
  success: boolean
  provider_id: string
  service_profile: string | null
  server_version: string | null
  latency_ms: number
  database: string | null
  diagnostics: string[]
  detected_capabilities: string[]
  tested_at: string
  error?: { code: string; message: string }
}
