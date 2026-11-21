export type UserRole = 'admin' | 'analyste' | 'lecteur';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  allowedConnectionIds: string[];
  allowedCompanies: string[];
  canExport: boolean;
  canRunSql: boolean;
  canEditDashboards: boolean;
  active: boolean;
  createdAt: string;
}

export type ConnectionEngine = 'sqlserver2008r2' | 'agent_relay' | 'imported_sqlite' | 'sandbox_erp';
export type TdsVersion = '7_2' | '7_3_A' | '7_3_B' | '7_4';

export interface AgentInfo {
  id: string;
  name: string;
  hostname?: string;
  online: boolean;
  lastSeenAt?: string;
  createdAt: string;
}

export interface SqlConnectionConfig {
  id: string;
  name: string;
  engine: ConnectionEngine;
  agentId?: string;
  importFileName?: string;
  host: string;
  port: number;
  instanceName?: string;
  database: string;
  username: string;
  hasPassword: boolean;
  encrypt: boolean;
  trustServerCertificate: boolean;
  tdsVersion: TdsVersion;
  readOnlyEnforced: boolean;
  description?: string;
  lastTestedAt?: string;
  lastStatus?: 'connected' | 'error' | 'untested';
  lastError?: string;
}

export interface SchemaColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  referencesTable?: string;
}

export interface SchemaObject {
  schema: string;
  name: string;
  fullName: string;
  type: 'TABLE' | 'VIEW';
  rowCount: number;
  columns: SchemaColumn[];
}

export interface DynamicFilters {
  dateFrom: string;
  dateTo: string;
  client: string;
  article: string;
  company: string;
  search: string;
}

export interface FilterOptionsPayload {
  clients: string[];
  articles: string[];
  companies: string[];
  minDate: string;
  maxDate: string;
}

export type WidgetType = 'kpi' | 'bar' | 'line' | 'pie' | 'table';
export type AggregationType = 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX';

export interface WidgetConfig {
  id: string;
  title: string;
  type: WidgetType;
  connectionId: string;
  sourceObject: string;
  dimensionColumn?: string;
  measureColumn: string;
  aggregation: AggregationType;
  dateColumn?: string;
  clientColumn?: string;
  articleColumn?: string;
  companyColumn?: string;
  limit?: number;
  sortDirection?: 'DESC' | 'ASC';
  valuePrefix?: string;
  valueSuffix?: string;
  colSpan?: 1 | 2 | 3;
  tableColumns?: string[];
}

export interface DashboardConfig {
  id: string;
  name: string;
  description: string;
  connectionId: string;
  widgets: WidgetConfig[];
  updatedAt: string;
  createdBy: string;
}

export interface WidgetQueryResult {
  widgetId: string;
  rows: Record<string, string | number | null>[];
  summaryValue: number | null;
  rowCount: number;
  durationMs: number;
  sqlPreview: string;
  refreshedAt: string;
}

export interface SqlExecutionResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
  readOnlyVerified: boolean;
}

export interface RefreshLogEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  userName: string;
  action: string;
  durationMs: number;
  status: 'success' | 'blocked' | 'error';
  createdAt: string;
}
