import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  AgentInfo,
  ConnectionEngine,
  DashboardConfig,
  RefreshLogEntry,
  SqlConnectionConfig,
  UserProfile,
  UserRole,
  WidgetConfig,
} from '../src/types/bi.ts';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from './security.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_DB_PATH = path.join(DATA_DIR, 'bi-studio.db');

export interface InternalConnectionRecord extends SqlConnectionConfig {
  passwordEncrypted: string;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  allowed_connection_ids: string;
  allowed_companies: string;
  can_export: number;
  can_run_sql: number;
  can_edit_dashboards: number;
  active: number;
  created_at: string;
}

interface ConnectionRow {
  id: string;
  name: string;
  engine: ConnectionEngine;
  agent_id: string | null;
  import_file_name: string | null;
  host: string;
  port: number;
  instance_name: string | null;
  database_name: string;
  username: string;
  password_encrypted: string;
  encrypt: number;
  trust_server_certificate: number;
  tds_version: '7_2' | '7_3_A' | '7_3_B' | '7_4';
  read_only_enforced: number;
  description: string | null;
  last_tested_at: string | null;
  last_status: 'connected' | 'error' | 'untested' | null;
  last_error: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  token_hash: string;
  hostname: string | null;
  last_seen_at: string | null;
  created_at: string;
}

interface DashboardRow {
  id: string;
  name: string;
  description: string;
  connection_id: string;
  widgets_json: string;
  updated_at: string;
  created_by: string;
}

let storeDb: Database.Database | null = null;

function getDb(): Database.Database {
  if (storeDb) return storeDb;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const db = new Database(STORE_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      allowed_connection_ids TEXT NOT NULL DEFAULT '["conn-sandbox-erp"]',
      allowed_companies TEXT NOT NULL DEFAULT '[]',
      can_export INTEGER NOT NULL DEFAULT 1,
      can_run_sql INTEGER NOT NULL DEFAULT 1,
      can_edit_dashboards INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      engine TEXT NOT NULL,
      agent_id TEXT,
      import_file_name TEXT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 1433,
      instance_name TEXT,
      database_name TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      password_encrypted TEXT NOT NULL DEFAULT '',
      encrypt INTEGER NOT NULL DEFAULT 0,
      trust_server_certificate INTEGER NOT NULL DEFAULT 1,
      tds_version TEXT NOT NULL DEFAULT '7_3_A',
      read_only_enforced INTEGER NOT NULL DEFAULT 1,
      description TEXT,
      last_tested_at TEXT,
      last_status TEXT DEFAULT 'untested',
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      hostname TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dashboards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      widgets_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refresh_logs (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      connection_name TEXT NOT NULL,
      user_name TEXT NOT NULL,
      action TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const connCols = db.prepare('PRAGMA table_info(connections)').all() as { name: string }[];
  if (!connCols.some((c) => c.name === 'agent_id')) {
    db.exec('ALTER TABLE connections ADD COLUMN agent_id TEXT');
  }
  if (!connCols.some((c) => c.name === 'import_file_name')) {
    db.exec('ALTER TABLE connections ADD COLUMN import_file_name TEXT');
  }

  seedInitialWorkspace(db);
  storeDb = db;
  return storeDb;
}

function seedInitialWorkspace(db: Database.Database): void {
  const connCount = (db.prepare('SELECT COUNT(*) AS c FROM connections').get() as { c: number }).c;
  if (connCount === 0) {
    db.prepare(`
      INSERT INTO connections (
        id, name, engine, host, port, instance_name, database_name, username,
        password_encrypted, encrypt, trust_server_certificate, tds_version,
        read_only_enforced, description, last_tested_at, last_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'conn-sandbox-erp',
      'ERP Gestion Commerciale (Base locale SQL 2008 R2)',
      'sandbox_erp',
      'localhost',
      1433,
      'SQLEXPRESS',
      'GESTION_COM_ERP',
      'bi_readonly',
      '',
      0,
      1,
      '7_3_A',
      1,
      'Base de démonstration multi-sociétés (Clients, Articles, Factures et Vues analytiques) en lecture seule stricte.',
      new Date().toISOString(),
      'connected'
    );
  }

  const dashCount = (db.prepare('SELECT COUNT(*) AS c FROM dashboards').get() as { c: number }).c;
  if (dashCount === 0) {
    const now = new Date().toISOString();
    const commercialWidgets: WidgetConfig[] = [
      {
        id: 'w-kpi-ca',
        title: "Chiffre d'affaires HT",
        type: 'kpi',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_ANALYSE_VENTES',
        measureColumn: 'CA_HT',
        aggregation: 'SUM',
        dateColumn: 'DATE_FACTURE',
        clientColumn: 'CLIENT',
        articleColumn: 'ARTICLE',
        companyColumn: 'SOCIETE',
        valueSuffix: ' €',
        colSpan: 1,
      },
      {
        id: 'w-kpi-marge',
        title: 'Marge brute HT',
        type: 'kpi',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_ANALYSE_VENTES',
        measureColumn: 'MARGE_HT',
        aggregation: 'SUM',
        dateColumn: 'DATE_FACTURE',
        clientColumn: 'CLIENT',
        articleColumn: 'ARTICLE',
        companyColumn: 'SOCIETE',
        valueSuffix: ' €',
        colSpan: 1,
      },
      {
        id: 'w-kpi-qte',
        title: 'Unités facturées',
        type: 'kpi',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_ANALYSE_VENTES',
        measureColumn: 'QUANTITE',
        aggregation: 'SUM',
        dateColumn: 'DATE_FACTURE',
        clientColumn: 'CLIENT',
        articleColumn: 'ARTICLE',
        companyColumn: 'SOCIETE',
        colSpan: 1,
      },
      {
        id: 'w-trend-mois',
        title: 'Évolution mensuelle du chiffre d’affaires HT',
        type: 'line',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_ANALYSE_VENTES',
        dimensionColumn: 'MOIS',
        measureColumn: 'CA_HT',
        aggregation: 'SUM',
        dateColumn: 'DATE_FACTURE',
        clientColumn: 'CLIENT',
        articleColumn: 'ARTICLE',
        companyColumn: 'SOCIETE',
        sortDirection: 'ASC',
        limit: 12,
        valueSuffix: ' €',
        colSpan: 2,
      },
      {
        id: 'w-pie-famille',
        title: 'Répartition du CA par famille d’articles',
        type: 'pie',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_ANALYSE_VENTES',
        dimensionColumn: 'FAMILLE_ARTICLE',
        measureColumn: 'CA_HT',
        aggregation: 'SUM',
        dateColumn: 'DATE_FACTURE',
        clientColumn: 'CLIENT',
        articleColumn: 'ARTICLE',
        companyColumn: 'SOCIETE',
        sortDirection: 'DESC',
        limit: 8,
        valueSuffix: ' €',
        colSpan: 1,
      },
      {
        id: 'w-bar-clients',
        title: 'Top 8 Clients par CA HT',
        type: 'bar',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_ANALYSE_VENTES',
        dimensionColumn: 'CLIENT',
        measureColumn: 'CA_HT',
        aggregation: 'SUM',
        dateColumn: 'DATE_FACTURE',
        clientColumn: 'CLIENT',
        articleColumn: 'ARTICLE',
        companyColumn: 'SOCIETE',
        sortDirection: 'DESC',
        limit: 8,
        valueSuffix: ' €',
        colSpan: 2,
      },
      {
        id: 'w-bar-societes',
        title: 'Performance par société',
        type: 'bar',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_ANALYSE_VENTES',
        dimensionColumn: 'SOCIETE',
        measureColumn: 'MARGE_HT',
        aggregation: 'SUM',
        dateColumn: 'DATE_FACTURE',
        clientColumn: 'CLIENT',
        articleColumn: 'ARTICLE',
        companyColumn: 'SOCIETE',
        sortDirection: 'DESC',
        limit: 6,
        valueSuffix: ' €',
        colSpan: 1,
      },
      {
        id: 'w-table-ventes',
        title: 'Journal détaillé des factures filtrées',
        type: 'table',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_ANALYSE_VENTES',
        measureColumn: 'CA_HT',
        aggregation: 'SUM',
        dateColumn: 'DATE_FACTURE',
        clientColumn: 'CLIENT',
        articleColumn: 'ARTICLE',
        companyColumn: 'SOCIETE',
        sortDirection: 'DESC',
        limit: 40,
        tableColumns: [
          'NUM_FACTURE',
          'DATE_FACTURE',
          'SOCIETE',
          'CLIENT',
          'ARTICLE',
          'QUANTITE',
          'CA_HT',
          'MARGE_HT',
          'STATUT_PAIEMENT',
        ],
        colSpan: 3,
      },
    ];

    const stockWidgets: WidgetConfig[] = [
      {
        id: 'w2-kpi-articles',
        title: 'Stock physique total',
        type: 'kpi',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_STOCK_ET_MARGES',
        measureColumn: 'STOCK_ACTUEL',
        aggregation: 'SUM',
        articleColumn: 'ARTICLE',
        colSpan: 1,
      },
      {
        id: 'w2-kpi-marge-moy',
        title: 'Taux de marge catalogue moyen',
        type: 'kpi',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_STOCK_ET_MARGES',
        measureColumn: 'TAUX_MARGE_PCT',
        aggregation: 'AVG',
        articleColumn: 'ARTICLE',
        valueSuffix: ' %',
        colSpan: 1,
      },
      {
        id: 'w2-kpi-ca-gen',
        title: 'CA généré par catalogue',
        type: 'kpi',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_STOCK_ET_MARGES',
        measureColumn: 'CA_GENERE_HT',
        aggregation: 'SUM',
        articleColumn: 'ARTICLE',
        valueSuffix: ' €',
        colSpan: 1,
      },
      {
        id: 'w2-bar-articles',
        title: 'Articles les plus rentables (CA généré HT)',
        type: 'bar',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_STOCK_ET_MARGES',
        dimensionColumn: 'ARTICLE',
        measureColumn: 'CA_GENERE_HT',
        aggregation: 'SUM',
        articleColumn: 'ARTICLE',
        sortDirection: 'DESC',
        limit: 10,
        valueSuffix: ' €',
        colSpan: 2,
      },
      {
        id: 'w2-pie-commerciaux',
        title: 'CA HT par commercial',
        type: 'pie',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_ANALYSE_VENTES',
        dimensionColumn: 'COMMERCIAL',
        measureColumn: 'CA_HT',
        aggregation: 'SUM',
        dateColumn: 'DATE_FACTURE',
        clientColumn: 'CLIENT',
        articleColumn: 'ARTICLE',
        companyColumn: 'SOCIETE',
        sortDirection: 'DESC',
        limit: 6,
        valueSuffix: ' €',
        colSpan: 1,
      },
      {
        id: 'w2-table-stock',
        title: 'Synthèse marges et stocks par article',
        type: 'table',
        connectionId: 'conn-sandbox-erp',
        sourceObject: 'VW_STOCK_ET_MARGES',
        measureColumn: 'CA_GENERE_HT',
        aggregation: 'SUM',
        articleColumn: 'ARTICLE',
        sortDirection: 'DESC',
        limit: 30,
        tableColumns: [
          'REF_ARTICLE',
          'ARTICLE',
          'FAMILLE_ARTICLE',
          'PRIX_ACHAT',
          'PRIX_VENTE',
          'TAUX_MARGE_PCT',
          'QTE_VENDUE',
          'CA_GENERE_HT',
        ],
        colSpan: 3,
      },
    ];

    const insertDash = db.prepare(`
      INSERT INTO dashboards (id, name, description, connection_id, widgets_json, updated_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertDash.run(
      'dash-commercial',
      'Pilotage Commercial & Marges',
      'Suivi du chiffre d’affaires, de la marge brute et des meilleurs clients multi-sociétés.',
      'conn-sandbox-erp',
      JSON.stringify(commercialWidgets),
      now,
      'Système'
    );
    insertDash.run(
      'dash-catalogue',
      'Catalogue Articles, Stocks & Équipes',
      'Analyse des taux de marge par référence, rotation des ventes et performance commerciale.',
      'conn-sandbox-erp',
      JSON.stringify(stockWidgets),
      now,
      'Système'
    );
  }
}

function mapUserRow(row: UserRow): UserProfile {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    allowedConnectionIds: JSON.parse(row.allowed_connection_ids || '[]') as string[],
    allowedCompanies: JSON.parse(row.allowed_companies || '[]') as string[],
    canExport: row.can_export === 1,
    canRunSql: row.can_run_sql === 1,
    canEditDashboards: row.can_edit_dashboards === 1,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

function mapConnectionRow(row: ConnectionRow): InternalConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    agentId: row.agent_id || undefined,
    importFileName: row.import_file_name || undefined,
    host: row.host,
    port: row.port,
    instanceName: row.instance_name || undefined,
    database: row.database_name,
    username: row.username,
    hasPassword: Boolean(row.password_encrypted),
    passwordEncrypted: row.password_encrypted,
    encrypt: row.encrypt === 1,
    trustServerCertificate: row.trust_server_certificate === 1,
    tdsVersion: row.tds_version,
    readOnlyEnforced: row.read_only_enforced === 1,
    description: row.description || undefined,
    lastTestedAt: row.last_tested_at || undefined,
    lastStatus: row.last_status || 'untested',
    lastError: row.last_error || undefined,
  };
}

export function sanitizeConnectionForClient(conn: InternalConnectionRecord): SqlConnectionConfig {
  const { passwordEncrypted: _ignored, ...safe } = conn;
  return safe;
}

export function hasAdminPasscodeEnv(): boolean {
  return Boolean(process.env.ADMIN_PASSCODE && process.env.ADMIN_PASSCODE.trim().length > 0);
}

export function hasAnyAdminUser(): boolean {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get() as { c: number };
  return row.c > 0;
}

export function isFirstRunSetupRequired(): boolean {
  return !hasAdminPasscodeEnv() && !hasAnyAdminUser();
}

export function claimInitialAdmin(name: string, email: string, password: string): UserProfile {
  const db = getDb();
  const tx = db.transaction(() => {
    if (hasAdminPasscodeEnv() || hasAnyAdminUser()) {
      throw new Error('SETUP_LOCKED');
    }
    const id = `usr-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const allConnections = (db.prepare('SELECT id FROM connections').all() as { id: string }[]).map((r) => r.id);
    db.prepare(`
      INSERT INTO users (
        id, name, email, password_hash, role, allowed_connection_ids,
        allowed_companies, can_export, can_run_sql, can_edit_dashboards, active, created_at
      ) VALUES (?, ?, ?, ?, 'admin', ?, '[]', 1, 1, 1, 1, ?)
    `).run(id, name.trim(), email.trim().toLowerCase(), hashPassword(password), JSON.stringify(allConnections), now);

    const created = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
    return mapUserRow(created);
  });
  return tx();
}

export function authenticateUser(email: string, password: string): UserProfile | null {
  const db = getDb();
  const normalizedEmail = email.trim().toLowerCase();

  // Optional ADMIN_PASSCODE env override
  if (hasAdminPasscodeEnv()) {
    const expected = process.env.ADMIN_PASSCODE!.trim();
    const a = Buffer.from(password);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      const existingAdmin = db
        .prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1")
        .get() as UserRow | undefined;
      if (existingAdmin) {
        if (existingAdmin.active !== 1) return null;
        return mapUserRow(existingAdmin);
      }
      // Provision env-backed admin row if none exists yet
      const id = `usr-${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const allConnections = (db.prepare('SELECT id FROM connections').all() as { id: string }[]).map((r) => r.id);
      db.prepare(`
        INSERT INTO users (
          id, name, email, password_hash, role, allowed_connection_ids,
          allowed_companies, can_export, can_run_sql, can_edit_dashboards, active, created_at
        ) VALUES (?, 'Administrateur', ?, ?, 'admin', ?, '[]', 1, 1, 1, 1, ?)
      `).run(id, normalizedEmail || 'admin@sqlbi.local', hashPassword(expected), JSON.stringify(allConnections), now);
      return mapUserRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow);
    }
  }

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail) as UserRow | undefined;
  if (!row || row.active !== 1) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return mapUserRow(row);
}

export function getUserById(id: string): UserProfile | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? mapUserRow(row) : null;
}

export function listUsers(): UserProfile[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
  return rows.map(mapUserRow);
}

export function createUserAccount(input: {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  allowedConnectionIds: string[];
  allowedCompanies: string[];
  canExport: boolean;
  canRunSql: boolean;
  canEditDashboards: boolean;
}): UserProfile {
  const db = getDb();
  const id = `usr-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (
      id, name, email, password_hash, role, allowed_connection_ids,
      allowed_companies, can_export, can_run_sql, can_edit_dashboards, active, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    id,
    input.name.trim(),
    input.email.trim().toLowerCase(),
    hashPassword(input.password),
    input.role,
    JSON.stringify(input.allowedConnectionIds),
    JSON.stringify(input.allowedCompanies),
    input.canExport ? 1 : 0,
    input.canRunSql ? 1 : 0,
    input.canEditDashboards ? 1 : 0,
    now
  );
  return mapUserRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow);
}

export function updateUserAccount(
  id: string,
  patch: Partial<{
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
): UserProfile | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!existing) return null;

  db.prepare(`
    UPDATE users SET
      name = ?,
      role = ?,
      allowed_connection_ids = ?,
      allowed_companies = ?,
      can_export = ?,
      can_run_sql = ?,
      can_edit_dashboards = ?,
      active = ?,
      password_hash = ?
    WHERE id = ?
  `).run(
    patch.name !== undefined ? patch.name.trim() : existing.name,
    patch.role ?? existing.role,
    patch.allowedConnectionIds !== undefined
      ? JSON.stringify(patch.allowedConnectionIds)
      : existing.allowed_connection_ids,
    patch.allowedCompanies !== undefined
      ? JSON.stringify(patch.allowedCompanies)
      : existing.allowed_companies,
    patch.canExport !== undefined ? (patch.canExport ? 1 : 0) : existing.can_export,
    patch.canRunSql !== undefined ? (patch.canRunSql ? 1 : 0) : existing.can_run_sql,
    patch.canEditDashboards !== undefined ? (patch.canEditDashboards ? 1 : 0) : existing.can_edit_dashboards,
    patch.active !== undefined ? (patch.active ? 1 : 0) : existing.active,
    patch.password && patch.password.length >= 8 ? hashPassword(patch.password) : existing.password_hash,
    id
  );
  return mapUserRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow);
}

export function deleteUserAccount(id: string): boolean {
  const db = getDb();
  const res = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return res.changes > 0;
}

export function listConnections(): InternalConnectionRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM connections ORDER BY engine DESC, name ASC').all() as ConnectionRow[];
  return rows.map(mapConnectionRow);
}

export function getConnectionById(id: string): InternalConnectionRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined;
  return row ? mapConnectionRow(row) : null;
}

export function getDecryptedConnectionPassword(conn: InternalConnectionRecord): string {
  return decryptSecret(conn.passwordEncrypted);
}

export function saveConnection(input: {
  id?: string;
  name: string;
  engine: ConnectionEngine;
  agentId?: string;
  importFileName?: string;
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
  lastStatus?: 'connected' | 'error' | 'untested';
}): InternalConnectionRecord {
  const db = getDb();
  const id = input.id || `conn-${crypto.randomUUID().slice(0, 8)}`;
  const existing = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined;

  const passwordEncrypted =
    input.password && input.password.length > 0
      ? encryptSecret(input.password)
      : existing?.password_encrypted || '';

  if (existing) {
    db.prepare(`
      UPDATE connections SET
        name = ?, engine = ?, agent_id = ?, import_file_name = ?, host = ?, port = ?, instance_name = ?, database_name = ?,
        username = ?, password_encrypted = ?, encrypt = ?, trust_server_certificate = ?,
        tds_version = ?, read_only_enforced = 1, description = ?
      WHERE id = ?
    `).run(
      input.name.trim(),
      input.engine,
      input.agentId?.trim() || null,
      input.importFileName !== undefined ? input.importFileName : existing.import_file_name,
      input.host.trim(),
      input.port,
      input.instanceName?.trim() || null,
      input.database.trim(),
      input.username.trim(),
      passwordEncrypted,
      input.encrypt ? 1 : 0,
      input.trustServerCertificate ? 1 : 0,
      input.tdsVersion,
      input.description?.trim() || null,
      id
    );
  } else {
    const initialStatus = input.lastStatus || 'untested';
    const testedAt = initialStatus === 'connected' ? new Date().toISOString() : null;
    db.prepare(`
      INSERT INTO connections (
        id, name, engine, agent_id, import_file_name, host, port, instance_name, database_name, username,
        password_encrypted, encrypt, trust_server_certificate, tds_version,
        read_only_enforced, description, last_tested_at, last_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id,
      input.name.trim(),
      input.engine,
      input.agentId?.trim() || null,
      input.importFileName || null,
      input.host.trim(),
      input.port,
      input.instanceName?.trim() || null,
      input.database.trim(),
      input.username.trim(),
      passwordEncrypted,
      input.encrypt ? 1 : 0,
      input.trustServerCertificate ? 1 : 0,
      input.tdsVersion,
      input.description?.trim() || null,
      testedAt,
      initialStatus
    );
  }

  return getConnectionById(id)!;
}

export function updateConnectionStatus(id: string, status: 'connected' | 'error', errorMsg?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE connections SET last_tested_at = ?, last_status = ?, last_error = ? WHERE id = ?
  `).run(new Date().toISOString(), status, errorMsg || null, id);
}

export function deleteConnection(id: string): boolean {
  const db = getDb();
  const res = db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  return res.changes > 0;
}

function hashAgentToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createAgentRecord(name: string): { agent: AgentInfo; token: string } {
  const db = getDb();
  const id = `agt-${crypto.randomUUID().slice(0, 8)}`;
  const token = `sqbi_${crypto.randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agents (id, name, token_hash, hostname, last_seen_at, created_at)
    VALUES (?, ?, ?, NULL, NULL, ?)
  `).run(id, name.trim(), hashAgentToken(token), now);

  return {
    agent: {
      id,
      name: name.trim(),
      online: false,
      createdAt: now,
    },
    token,
  };
}

export function rotateAgentToken(id: string): string | null {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
  if (!existing) return null;
  const token = `sqbi_${crypto.randomBytes(24).toString('hex')}`;
  db.prepare('UPDATE agents SET token_hash = ? WHERE id = ?').run(hashAgentToken(token), id);
  return token;
}

export function getAgentRecordById(id: string): AgentRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
  return row || null;
}

export function listAgentRecords(isOnlineFn: (id: string, lastSeenAt?: string | null) => boolean): AgentInfo[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as AgentRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    hostname: r.hostname || undefined,
    online: isOnlineFn(r.id, r.last_seen_at),
    lastSeenAt: r.last_seen_at || undefined,
    createdAt: r.created_at,
  }));
}

export function verifyAgentBearerToken(token: string): AgentRow | null {
  const db = getDb();
  const hash = hashAgentToken(token);
  const rows = db.prepare('SELECT * FROM agents').all() as AgentRow[];
  const hashBuf = Buffer.from(hash, 'hex');
  for (const row of rows) {
    const rowBuf = Buffer.from(row.token_hash, 'hex');
    if (rowBuf.length === hashBuf.length && crypto.timingSafeEqual(rowBuf, hashBuf)) {
      return row;
    }
  }
  return null;
}

export function updateAgentHeartbeat(id: string, hostname?: string): void {
  const db = getDb();
  db.prepare('UPDATE agents SET last_seen_at = ?, hostname = COALESCE(?, hostname) WHERE id = ?').run(
    new Date().toISOString(),
    hostname ? hostname.slice(0, 120) : null,
    id
  );
}

export function deleteAgentRecord(id: string): boolean {
  const db = getDb();
  const res = db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  return res.changes > 0;
}

export function listDashboards(): DashboardConfig[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM dashboards ORDER BY updated_at DESC').all() as DashboardRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    connectionId: row.connection_id,
    widgets: JSON.parse(row.widgets_json) as WidgetConfig[],
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  }));
}

export function saveDashboard(input: {
  id?: string;
  name: string;
  description: string;
  connectionId: string;
  widgets: WidgetConfig[];
  createdBy: string;
}): DashboardConfig {
  const db = getDb();
  const id = input.id || `dash-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM dashboards WHERE id = ?').get(id);

  if (existing) {
    db.prepare(`
      UPDATE dashboards SET name = ?, description = ?, connection_id = ?, widgets_json = ?, updated_at = ?
      WHERE id = ?
    `).run(input.name.trim(), input.description.trim(), input.connectionId, JSON.stringify(input.widgets), now, id);
  } else {
    db.prepare(`
      INSERT INTO dashboards (id, name, description, connection_id, widgets_json, updated_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name.trim(),
      input.description.trim(),
      input.connectionId,
      JSON.stringify(input.widgets),
      now,
      input.createdBy
    );
  }

  const row = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(id) as DashboardRow;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    connectionId: row.connection_id,
    widgets: JSON.parse(row.widgets_json) as WidgetConfig[],
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

export function deleteDashboard(id: string): boolean {
  const db = getDb();
  const res = db.prepare('DELETE FROM dashboards WHERE id = ?').run(id);
  return res.changes > 0;
}

export function recordRefreshLog(entry: Omit<RefreshLogEntry, 'id' | 'createdAt'>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO refresh_logs (id, connection_id, connection_name, user_name, action, duration_ms, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `log-${crypto.randomUUID().slice(0, 8)}`,
    entry.connectionId,
    entry.connectionName,
    entry.userName,
    entry.action,
    entry.durationMs,
    entry.status,
    new Date().toISOString()
  );
}

export function listRefreshLogs(limit = 30): RefreshLogEntry[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM refresh_logs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as {
    id: string;
    connection_id: string;
    connection_name: string;
    user_name: string;
    action: string;
    duration_ms: number;
    status: 'success' | 'blocked' | 'error';
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    connectionId: r.connection_id,
    connectionName: r.connection_name,
    userName: r.user_name,
    action: r.action,
    durationMs: r.duration_ms,
    status: r.status,
    createdAt: r.created_at,
  }));
}
