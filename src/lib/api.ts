import type {
  AgentInfo,
  ConnectionEngine,
  DashboardConfig,
  DynamicFilters,
  FilterOptionsPayload,
  RefreshLogEntry,
  SchemaObject,
  SqlConnectionConfig,
  SqlExecutionResult,
  UserProfile,
  UserRole,
  WidgetConfig,
  WidgetQueryResult,
} from '../types/bi';

let authTokenInMemory: string | null = null;

export function setAuthToken(token: string | null): void {
  authTokenInMemory = token;
}

export function getAuthToken(): string | null {
  return authTokenInMemory;
}

async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (authTokenInMemory) {
    headers.set('Authorization', `Bearer ${authTokenInMemory}`);
  }

  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { error: text };
    }
  }

  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : `Erreur HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

export const biApi = {
  getAuthStatus: () => apiFetch<{ needsSetup: boolean; hasEnvAdminOverride: boolean }>('/api/auth/status'),
  setupAdmin: (payload: { name: string; email: string; password: string }) =>
    apiFetch<{ token: string; user: UserProfile }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  login: (payload: { email: string; password: string }) =>
    apiFetch<{ token: string; user: UserProfile }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  me: () => apiFetch<{ user: UserProfile }>('/api/auth/me'),

  listUsers: () => apiFetch<{ users: UserProfile[] }>('/api/users'),
  createUser: (payload: {
    name: string;
    email: string;
    password: string;
    role: UserRole;
    allowedConnectionIds: string[];
    allowedCompanies: string[];
    canExport: boolean;
    canRunSql: boolean;
    canEditDashboards: boolean;
  }) =>
    apiFetch<{ user: UserProfile }>('/api/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateUser: (
    id: string,
    payload: Partial<{
      name: string;
      role: UserRole;
      allowedConnectionIds: string[];
      allowedCompanies: string[];
      canExport: boolean;
      canRunSql: boolean;
      canEditDashboards: boolean;
      active: boolean;
      password: string;
    }>
  ) =>
    apiFetch<{ user: UserProfile }>(`/api/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteUser: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  listConnections: () => apiFetch<{ connections: SqlConnectionConfig[] }>('/api/connections'),
  saveConnection: (payload: {
    id?: string;
    name: string;
    engine: ConnectionEngine;
    agentId?: string;
    host: string;
    port: number;
    instanceName?: string;
    database: string;
    username: string;
    password?: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
    tdsVersion: '7_2' | '7_3_A' | '7_3_B' | '7_4';
    description?: string;
  }) =>
    apiFetch<{ connection: SqlConnectionConfig }>('/api/connections', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  importDatabase: (payload: {
    name?: string;
    originalFileName: string;
    contentBase64: string;
    description?: string;
    autoCreateDashboard?: boolean;
  }) =>
    apiFetch<{
      connection: SqlConnectionConfig;
      summary: {
        fileName: string;
        tablesCreated: number;
        viewsCreated: number;
        rowsInserted: number;
        warnings: string[];
      };
      schema: SchemaObject[];
      dashboard?: DashboardConfig;
    }>('/api/connections/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  testConnection: (id: string) =>
    apiFetch<{ ok: boolean; serverVersion: string; latencyMs: number; message: string }>(
      `/api/connections/${encodeURIComponent(id)}/test`,
      { method: 'POST' }
    ),
  testDraftConnection: (payload: {
    engine: ConnectionEngine;
    agentId?: string;
    host: string;
    port: number;
    instanceName?: string;
    database: string;
    username: string;
    password?: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
    tdsVersion: '7_2' | '7_3_A' | '7_3_B' | '7_4';
  }) =>
    apiFetch<{ ok: boolean; serverVersion: string; latencyMs: number; message: string }>('/api/connections/test-draft', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteConnection: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listAgents: () => apiFetch<{ agents: AgentInfo[] }>('/api/agents'),
  createAgent: (name: string, serverUrl: string) =>
    apiFetch<{ agent: AgentInfo; token: string; scriptContent: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name, serverUrl }),
    }),
  rotateAgent: (id: string, serverUrl: string) =>
    apiFetch<{ token: string; scriptContent: string }>(`/api/agents/${encodeURIComponent(id)}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ serverUrl }),
    }),
  deleteAgent: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getSchema: (connectionId: string, refresh = false) =>
    apiFetch<{ objects: SchemaObject[]; detectedAt: string }>(
      `/api/connections/${encodeURIComponent(connectionId)}/schema${refresh ? '?refresh=1' : ''}`
    ),

  listDashboards: () => apiFetch<{ dashboards: DashboardConfig[] }>('/api/dashboards'),
  saveDashboard: (payload: {
    id?: string;
    name: string;
    description: string;
    connectionId: string;
    widgets: WidgetConfig[];
  }) =>
    apiFetch<{ dashboard: DashboardConfig }>('/api/dashboards', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteDashboard: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/dashboards/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getFilterOptions: (payload: {
    connectionId: string;
    sourceObject: string;
    dateColumn?: string;
    clientColumn?: string;
    articleColumn?: string;
    companyColumn?: string;
  }) =>
    apiFetch<FilterOptionsPayload>('/api/query/filter-options', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  queryDashboard: (payload: {
    connectionId: string;
    widgets: WidgetConfig[];
    filters: DynamicFilters;
    isManualRefresh?: boolean;
  }) =>
    apiFetch<{ results: WidgetQueryResult[]; refreshedAt: string }>('/api/query/dashboard', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  runReadOnlySql: (payload: { connectionId: string; sql: string; maxRows?: number }) =>
    apiFetch<SqlExecutionResult>('/api/query/sql', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  listLogs: () => apiFetch<{ logs: RefreshLogEntry[] }>('/api/logs'),
};
