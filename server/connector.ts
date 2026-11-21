import sql from 'mssql';
import type {
  ConnectionEngine,
  DynamicFilters,
  FilterOptionsPayload,
  SchemaColumn,
  SchemaObject,
  SqlExecutionResult,
  WidgetConfig,
  WidgetQueryResult,
} from '../src/types/bi.ts';
import type Database from 'better-sqlite3';
import { dispatchAgentJob } from './agentRelay.ts';
import { getSandboxReadOnlyDb } from './sandboxDb.ts';
import { validateReadOnlySql, validateSqlServerHost } from './security.ts';
import { getImportedReadOnlyDb } from './sqlImporter.ts';
import {
  getAgentRecordById,
  getDecryptedConnectionPassword,
  type InternalConnectionRecord,
} from './store.ts';

function isSqliteEngine(engine: ConnectionEngine): boolean {
  return engine === 'sandbox_erp' || engine === 'imported_sqlite';
}

function getSqliteHandle(conn: InternalConnectionRecord): Database.Database {
  if (conn.engine === 'sandbox_erp') {
    return getSandboxReadOnlyDb();
  }
  if (!conn.importFileName) {
    throw new Error('Fichier de base SQLite importée introuvable pour cette connexion.');
  }
  return getImportedReadOnlyDb(conn.importFileName);
}

const schemaCache = new Map<string, { expiresAt: number; objects: SchemaObject[] }>();

export function invalidateSchemaCache(connectionId: string): void {
  schemaCache.delete(connectionId);
}

function formatMssqlError(err: unknown, conn: InternalConnectionRecord): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string; originalError?: { code?: string } })?.code
    || (err as { originalError?: { code?: string } })?.originalError?.code
    || '';
  const lower = raw.toLowerCase();

  if (lower.includes('enotfound') || lower.includes('eai_again') || code === 'ENOTFOUND') {
    return new Error(
      `Impossible de résoudre le nom de serveur « ${conn.host} » (ENOTFOUND). Un nom de poste Windows local ne peut pas être joint depuis le serveur cloud : utilisez une adresse IP/DNS publique, un tunnel TCP (ex. ngrok tcp ${conn.port}), ou exécutez SQL BI Studio directement sur votre réseau local.`
    );
  }
  if (lower.includes('etimedout') || lower.includes('failed to connect') || lower.includes('timeout')) {
    return new Error(
      `Délai de connexion dépassé vers ${conn.host}:${conn.port}. Vérifiez que TCP/IP est activé sur SQL Server (port fixe ${conn.port}) et que le pare-feu Windows autorise les connexions entrantes.`
    );
  }
  if (lower.includes('econnrefused') || code === 'ECONNREFUSED') {
    return new Error(
      `Connexion refusée par ${conn.host}:${conn.port}. Vérifiez que le service SQL Server est démarré et écoute sur le port TCP ${conn.port}.`
    );
  }
  if (lower.includes('login failed') || code === 'ELOGIN') {
    return new Error(
      `Échec d'authentification SQL Server pour l'utilisateur « ${conn.username} ». Vérifiez le mot de passe et activez le mode d'authentification mixte (SQL Server et Windows).`
    );
  }
  if (lower.includes('ssl') || lower.includes('tls') || lower.includes('econnreset')) {
    return new Error(
      `Échec de négociation TLS/SSL avec SQL Server (${raw}). Pour SQL Server 2022, utilisez TDS 7.4 avec Chiffrement activé + Accepter le certificat auto-signé. Pour SQL Server 2008 R2, utilisez TDS 7.3A et décochez Chiffrement TLS/SSL.`
    );
  }
  return new Error(raw);
}

function buildMssqlConfig(conn: InternalConnectionRecord, passwordOverride?: string): sql.config {
  const hostCheck = validateSqlServerHost(conn.host, conn.port);
  if (!hostCheck.valid) {
    throw new Error(hostCheck.reason || 'Paramètres réseau invalides.');
  }

  const password = passwordOverride !== undefined ? passwordOverride : getDecryptedConnectionPassword(conn);
  const isLegacy2008 = conn.tdsVersion === '7_2' || conn.tdsVersion === '7_3_A' || conn.tdsVersion === '7_3_B';

  const options: sql.IOptions = {
    encrypt: conn.encrypt,
    trustServerCertificate: conn.trustServerCertificate,
    readOnlyIntent: true,
    enableArithAbort: true,
    tdsVersion: conn.tdsVersion || '7_3_A',
    useUTC: false,
    ...(isLegacy2008
      ? {
          cryptoCredentialsDetails: {
            minVersion: 'TLSv1' as unknown as 'TLSv1.2',
            ciphers: 'DEFAULT@SECLEVEL=0',
          },
        }
      : {}),
  };

  const hasInstance = Boolean(conn.instanceName && conn.instanceName.trim().length > 0);
  if (hasInstance) {
    options.instanceName = conn.instanceName!.trim();
  }

  return {
    server: conn.host.trim(),
    port: hasInstance ? undefined : conn.port,
    database: conn.database.trim(),
    user: conn.username.trim(),
    password,
    connectionTimeout: 8000,
    requestTimeout: 15000,
    options,
  };
}

async function withMssqlConnection<T>(
  conn: InternalConnectionRecord,
  fn: (pool: sql.ConnectionPool) => Promise<T>,
  passwordOverride?: string
): Promise<T> {
  const cfg = buildMssqlConfig(conn, passwordOverride);
  const pool = new sql.ConnectionPool(cfg);
  try {
    await pool.connect();
    await pool.request().query('SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT 5000;');
    return await fn(pool);
  } catch (err) {
    throw formatMssqlError(err, conn);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

function getAgentPayloadSqlConfig(conn: InternalConnectionRecord, passwordOverride?: string) {
  const password = passwordOverride !== undefined ? passwordOverride : getDecryptedConnectionPassword(conn);
  return {
    host: conn.host.trim(),
    port: conn.port,
    instanceName: conn.instanceName?.trim() || undefined,
    database: conn.database.trim(),
    username: conn.username.trim(),
    password,
    encrypt: conn.encrypt,
    trustServerCertificate: conn.trustServerCertificate,
    tdsVersion: conn.tdsVersion || '7_3_A',
  };
}

function resolveAgent(conn: InternalConnectionRecord) {
  if (!conn.agentId) {
    throw new Error('Aucun Agent Relais Windows associé à cette connexion.');
  }
  const agent = getAgentRecordById(conn.agentId);
  if (!agent) {
    throw new Error('Agent Relais Windows introuvable.');
  }
  return agent;
}

export async function testConnectionEngine(
  conn: InternalConnectionRecord,
  passwordOverride?: string
): Promise<{ ok: boolean; serverVersion: string; latencyMs: number; message: string }> {
  const start = Date.now();
  if (isSqliteEngine(conn.engine)) {
    const db = getSqliteHandle(conn);
    const row = db.prepare("SELECT sqlite_version() AS v, COUNT(*) AS tables FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").get() as {
      v: string;
      tables: number;
    };
    const label =
      conn.engine === 'sandbox_erp'
        ? `SQL Server 2008 R2 ERP Modèle (Moteur local lecture seule · ${row.tables} objets)`
        : `Base SQL importée (${conn.database} · ${row.tables} tables/vues en lecture seule)`;
    return {
      ok: true,
      serverVersion: label,
      latencyMs: Date.now() - start,
      message: 'Connexion lecture seule vérifiée avec succès.',
    };
  }

  if (conn.engine === 'agent_relay') {
    const agent = resolveAgent(conn);
    return dispatchAgentJob<{ ok: boolean; serverVersion: string; latencyMs: number; message: string }>(
      agent.id,
      agent.last_seen_at,
      {
        type: 'test',
        sqlConfig: getAgentPayloadSqlConfig(conn, passwordOverride),
      }
    );
  }

  return withMssqlConnection(
    conn,
    async (pool) => {
      const res = await pool.request().query('SELECT @@VERSION AS version, DB_NAME() AS db_name');
      const record = res.recordset?.[0] as { version?: string; db_name?: string } | undefined;
      const firstLine = (record?.version || 'Microsoft SQL Server').split('\n')[0].trim();
      return {
        ok: true,
        serverVersion: firstLine,
        latencyMs: Date.now() - start,
        message: `Connecté à la base « ${record?.db_name || conn.database} » en mode lecture seule.`,
      };
    },
    passwordOverride
  );
}

export async function introspectSchema(
  conn: InternalConnectionRecord,
  forceRefresh = false
): Promise<SchemaObject[]> {
  const cached = schemaCache.get(conn.id);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.objects;
  }

  let objects: SchemaObject[] = [];

  if (isSqliteEngine(conn.engine)) {
    const db = getSqliteHandle(conn);
    const masters = db
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name ASC"
      )
      .all() as { name: string; type: 'table' | 'view' }[];

    objects = masters.map((m) => {
      const escaped = m.name.replace(/"/g, '""');
      const colsRaw = db.prepare(`PRAGMA table_info("${escaped}")`).all() as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }[];
      const fksRaw =
        m.type === 'table'
          ? (db.prepare(`PRAGMA foreign_key_list("${escaped}")`).all() as {
              from: string;
              table: string;
            }[])
          : [];
      const fkMap = new Map(fksRaw.map((fk) => [fk.from, fk.table]));

      let rowCount = 0;
      try {
        const cnt = db.prepare(`SELECT COUNT(*) AS c FROM "${escaped}"`).get() as { c: number };
        rowCount = cnt?.c ?? 0;
      } catch {
        rowCount = 0;
      }

      const columns: SchemaColumn[] = colsRaw.map((col) => ({
        name: col.name,
        dataType: (col.type || 'TEXT').toUpperCase(),
        nullable: col.notnull === 0,
        isPrimaryKey: col.pk > 0,
        isForeignKey: fkMap.has(col.name),
        referencesTable: fkMap.get(col.name),
      }));

      return {
        schema: 'dbo',
        name: m.name,
        fullName: m.name,
        type: m.type === 'view' ? 'VIEW' : 'TABLE',
        rowCount,
        columns,
      };
    });
  } else if (conn.engine === 'agent_relay') {
    const agent = resolveAgent(conn);
    const rawSchema = await dispatchAgentJob<{
      tables: { TABLE_SCHEMA: string; TABLE_NAME: string; TABLE_TYPE: string; ROW_COUNT: number }[];
      columns: { TABLE_SCHEMA: string; TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string }[];
      keys: {
        TABLE_SCHEMA: string;
        TABLE_NAME: string;
        COLUMN_NAME: string;
        CONSTRAINT_TYPE: string;
        REFERENCED_TABLE: string | null;
      }[];
    }>(agent.id, agent.last_seen_at, {
      type: 'schema',
      sqlConfig: getAgentPayloadSqlConfig(conn),
    });

    const pkSet = new Set<string>();
    const fkMap = new Map<string, string>();
    for (const k of rawSchema.keys || []) {
      const key = `${k.TABLE_SCHEMA}.${k.TABLE_NAME}.${k.COLUMN_NAME}`;
      if (k.CONSTRAINT_TYPE === 'PRIMARY KEY') pkSet.add(key);
      if (k.CONSTRAINT_TYPE === 'FOREIGN KEY' && k.REFERENCED_TABLE) fkMap.set(key, k.REFERENCED_TABLE);
    }

    const colsByTable = new Map<string, SchemaColumn[]>();
    for (const c of rawSchema.columns || []) {
      const tableKey = `${c.TABLE_SCHEMA}.${c.TABLE_NAME}`;
      const list = colsByTable.get(tableKey) || [];
      const colKey = `${tableKey}.${c.COLUMN_NAME}`;
      list.push({
        name: c.COLUMN_NAME,
        dataType: c.DATA_TYPE.toUpperCase(),
        nullable: c.IS_NULLABLE === 'YES',
        isPrimaryKey: pkSet.has(colKey),
        isForeignKey: fkMap.has(colKey),
        referencesTable: fkMap.get(colKey),
      });
      colsByTable.set(tableKey, list);
    }

    objects = (rawSchema.tables || []).map((t) => {
      const fullName = `${t.TABLE_SCHEMA}.${t.TABLE_NAME}`;
      return {
        schema: t.TABLE_SCHEMA,
        name: t.TABLE_NAME,
        fullName,
        type: t.TABLE_TYPE === 'VIEW' ? ('VIEW' as const) : ('TABLE' as const),
        rowCount: Number(t.ROW_COUNT || 0),
        columns: colsByTable.get(fullName) || [],
      };
    });
  } else {
    objects = await withMssqlConnection(conn, async (pool) => {
      const tablesRes = await pool.request().query(`
        SELECT
          t.TABLE_SCHEMA,
          t.TABLE_NAME,
          t.TABLE_TYPE,
          ISNULL((
            SELECT SUM(p.rows)
            FROM sys.partitions p
            INNER JOIN sys.objects o ON o.object_id = p.object_id
            INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
            WHERE s.name = t.TABLE_SCHEMA
              AND o.name = t.TABLE_NAME
              AND p.index_id IN (0, 1)
          ), 0) AS ROW_COUNT
        FROM INFORMATION_SCHEMA.TABLES t
        WHERE t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
        ORDER BY t.TABLE_TYPE, t.TABLE_SCHEMA, t.TABLE_NAME
      `);

      const colsRes = await pool.request().query(`
        SELECT
          c.TABLE_SCHEMA,
          c.TABLE_NAME,
          c.COLUMN_NAME,
          c.DATA_TYPE,
          c.IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS c
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
      `);

      const keysRes = await pool.request().query(`
        SELECT
          kcu.TABLE_SCHEMA,
          kcu.TABLE_NAME,
          kcu.COLUMN_NAME,
          tc.CONSTRAINT_TYPE,
          kcu2.TABLE_NAME AS REFERENCED_TABLE
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
          AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
        LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
          ON tc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
          AND tc.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
        LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu2
          ON rc.UNIQUE_CONSTRAINT_NAME = kcu2.CONSTRAINT_NAME
          AND rc.UNIQUE_CONSTRAINT_SCHEMA = kcu2.CONSTRAINT_SCHEMA
        WHERE tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY')
      `);

      const pkSet = new Set<string>();
      const fkMap = new Map<string, string>();
      for (const k of keysRes.recordset as {
        TABLE_SCHEMA: string;
        TABLE_NAME: string;
        COLUMN_NAME: string;
        CONSTRAINT_TYPE: string;
        REFERENCED_TABLE: string | null;
      }[]) {
        const key = `${k.TABLE_SCHEMA}.${k.TABLE_NAME}.${k.COLUMN_NAME}`;
        if (k.CONSTRAINT_TYPE === 'PRIMARY KEY') pkSet.add(key);
        if (k.CONSTRAINT_TYPE === 'FOREIGN KEY' && k.REFERENCED_TABLE) {
          fkMap.set(key, k.REFERENCED_TABLE);
        }
      }

      const colsByTable = new Map<string, SchemaColumn[]>();
      for (const c of colsRes.recordset as {
        TABLE_SCHEMA: string;
        TABLE_NAME: string;
        COLUMN_NAME: string;
        DATA_TYPE: string;
        IS_NULLABLE: string;
      }[]) {
        const tableKey = `${c.TABLE_SCHEMA}.${c.TABLE_NAME}`;
        const list = colsByTable.get(tableKey) || [];
        const colKey = `${tableKey}.${c.COLUMN_NAME}`;
        list.push({
          name: c.COLUMN_NAME,
          dataType: c.DATA_TYPE.toUpperCase(),
          nullable: c.IS_NULLABLE === 'YES',
          isPrimaryKey: pkSet.has(colKey),
          isForeignKey: fkMap.has(colKey),
          referencesTable: fkMap.get(colKey),
        });
        colsByTable.set(tableKey, list);
      }

      return (
        tablesRes.recordset as {
          TABLE_SCHEMA: string;
          TABLE_NAME: string;
          TABLE_TYPE: string;
          ROW_COUNT: number;
        }[]
      ).map((t) => {
        const fullName = `${t.TABLE_SCHEMA}.${t.TABLE_NAME}`;
        return {
          schema: t.TABLE_SCHEMA,
          name: t.TABLE_NAME,
          fullName,
          type: t.TABLE_TYPE === 'VIEW' ? ('VIEW' as const) : ('TABLE' as const),
          rowCount: Number(t.ROW_COUNT || 0),
          columns: colsByTable.get(fullName) || [],
        };
      });
    });
  }

  schemaCache.set(conn.id, { expiresAt: Date.now() + 60_000, objects });
  return objects;
}

function findValidatedObject(schema: SchemaObject[], sourceObject: string): SchemaObject {
  const found = schema.find(
    (obj) =>
      obj.fullName.toLowerCase() === sourceObject.toLowerCase() ||
      obj.name.toLowerCase() === sourceObject.toLowerCase()
  );
  if (!found) {
    throw new Error(`Objet SQL introuvable dans le schéma détecté : ${sourceObject}`);
  }
  return found;
}

function findValidatedColumn(obj: SchemaObject, columnName?: string): string | null {
  if (!columnName) return null;
  const col = obj.columns.find((c) => c.name.toLowerCase() === columnName.toLowerCase());
  return col ? col.name : null;
}

function quoteId(engine: ConnectionEngine, identifier: string): string {
  if (isSqliteEngine(engine)) {
    return `"${identifier.replace(/"/g, '""')}"`;
  }
  return `[${identifier.replace(/\]/g, ']]')}]`;
}

function quoteObject(engine: ConnectionEngine, obj: SchemaObject): string {
  if (isSqliteEngine(engine)) {
    return quoteId(engine, obj.name);
  }
  return `${quoteId('sqlserver2008r2', obj.schema)}.${quoteId('sqlserver2008r2', obj.name)}`;
}

export async function getFilterOptionsForSource(
  conn: InternalConnectionRecord,
  sourceObject: string,
  mappings: {
    dateColumn?: string;
    clientColumn?: string;
    articleColumn?: string;
    companyColumn?: string;
  },
  allowedCompanies: string[]
): Promise<FilterOptionsPayload> {
  const schema = await introspectSchema(conn);
  const targetObj = findValidatedObject(schema, sourceObject);
  const tableExpr = quoteObject(conn.engine, targetObj);

  const dateCol = findValidatedColumn(targetObj, mappings.dateColumn);
  const clientCol = findValidatedColumn(targetObj, mappings.clientColumn);
  const articleCol = findValidatedColumn(targetObj, mappings.articleColumn);
  const companyCol = findValidatedColumn(targetObj, mappings.companyColumn);

  const result: FilterOptionsPayload = {
    clients: [],
    articles: [],
    companies: [],
    minDate: '',
    maxDate: '',
  };

  if (isSqliteEngine(conn.engine)) {
    const db = getSqliteHandle(conn);
    let scopeClause = '';
    const scopeParams: unknown[] = [];
    if (companyCol && allowedCompanies.length > 0) {
      scopeClause = ` WHERE ${quoteId('sandbox_erp', companyCol)} IN (${allowedCompanies.map(() => '?').join(', ')})`;
      scopeParams.push(...allowedCompanies);
    }

    if (companyCol) {
      const q = quoteId('sandbox_erp', companyCol);
      const rows = db
        .prepare(`SELECT DISTINCT ${q} AS v FROM ${tableExpr}${scopeClause} ORDER BY v ASC LIMIT 200`)
        .all(...scopeParams) as { v: string | null }[];
      result.companies = rows.map((r) => String(r.v ?? '')).filter(Boolean);
    }
    if (clientCol) {
      const q = quoteId('sandbox_erp', clientCol);
      const rows = db
        .prepare(`SELECT DISTINCT ${q} AS v FROM ${tableExpr}${scopeClause} ORDER BY v ASC LIMIT 250`)
        .all(...scopeParams) as { v: string | null }[];
      result.clients = rows.map((r) => String(r.v ?? '')).filter(Boolean);
    }
    if (articleCol) {
      const q = quoteId('sandbox_erp', articleCol);
      const rows = db
        .prepare(`SELECT DISTINCT ${q} AS v FROM ${tableExpr}${scopeClause} ORDER BY v ASC LIMIT 250`)
        .all(...scopeParams) as { v: string | null }[];
      result.articles = rows.map((r) => String(r.v ?? '')).filter(Boolean);
    }
    if (dateCol) {
      const q = quoteId('sandbox_erp', dateCol);
      const row = db
        .prepare(`SELECT MIN(${q}) AS minD, MAX(${q}) AS maxD FROM ${tableExpr}${scopeClause}`)
        .get(...scopeParams) as { minD: string | null; maxD: string | null } | undefined;
      result.minDate = row?.minD ? String(row.minD).slice(0, 10) : '';
      result.maxDate = row?.maxD ? String(row.maxD).slice(0, 10) : '';
    }
    return result;
  }

  if (conn.engine === 'agent_relay') {
    const agent = resolveAgent(conn);
    const scopeParams: { name: string; value: string }[] = [];
    let scopeSql = '';
    if (companyCol && allowedCompanies.length > 0) {
      const placeholders = allowedCompanies.map((comp, idx) => {
        const name = `sc${idx}`;
        scopeParams.push({ name, value: comp });
        return `@${name}`;
      });
      scopeSql = ` WHERE ${quoteId('agent_relay', companyCol)} IN (${placeholders.join(', ')})`;
    }

    const queries: { key: string; sql: string; params: { name: string; value: string }[] }[] = [];
    if (companyCol) {
      const q = quoteId('agent_relay', companyCol);
      queries.push({ key: 'companies', sql: `SELECT DISTINCT TOP 200 ${q} AS v FROM ${tableExpr}${scopeSql} ORDER BY v ASC`, params: scopeParams });
    }
    if (clientCol) {
      const q = quoteId('agent_relay', clientCol);
      queries.push({ key: 'clients', sql: `SELECT DISTINCT TOP 250 ${q} AS v FROM ${tableExpr}${scopeSql} ORDER BY v ASC`, params: scopeParams });
    }
    if (articleCol) {
      const q = quoteId('agent_relay', articleCol);
      queries.push({ key: 'articles', sql: `SELECT DISTINCT TOP 250 ${q} AS v FROM ${tableExpr}${scopeSql} ORDER BY v ASC`, params: scopeParams });
    }
    if (dateCol) {
      const q = quoteId('agent_relay', dateCol);
      queries.push({
        key: 'dates',
        sql: `SELECT CONVERT(VARCHAR(10), MIN(${q}), 23) AS minD, CONVERT(VARCHAR(10), MAX(${q}), 23) AS maxD FROM ${tableExpr}${scopeSql}`,
        params: scopeParams,
      });
    }

    if (queries.length > 0) {
      const out = await dispatchAgentJob<Record<string, Record<string, unknown>[]>>(
        agent.id,
        agent.last_seen_at,
        {
          type: 'sql_batch',
          sqlConfig: getAgentPayloadSqlConfig(conn),
          queries,
        }
      );
      if (out.companies) result.companies = out.companies.map((r) => String(r.v ?? '')).filter(Boolean);
      if (out.clients) result.clients = out.clients.map((r) => String(r.v ?? '')).filter(Boolean);
      if (out.articles) result.articles = out.articles.map((r) => String(r.v ?? '')).filter(Boolean);
      if (out.dates?.[0]) {
        result.minDate = String(out.dates[0].minD || '');
        result.maxDate = String(out.dates[0].maxD || '');
      }
    }
    return result;
  }

  return withMssqlConnection(conn, async (pool) => {
    const bindScope = (req: sql.Request): string => {
      if (companyCol && allowedCompanies.length > 0) {
        const placeholders = allowedCompanies.map((comp, idx) => {
          req.input(`sc${idx}`, sql.NVarChar, comp);
          return `@sc${idx}`;
        });
        return ` WHERE ${quoteId('sqlserver2008r2', companyCol)} IN (${placeholders.join(', ')})`;
      }
      return '';
    };

    if (companyCol) {
      const req = pool.request();
      const scopeSql = bindScope(req);
      const q = quoteId('sqlserver2008r2', companyCol);
      const r = await req.query(`SELECT DISTINCT TOP 200 ${q} AS v FROM ${tableExpr}${scopeSql} ORDER BY v ASC`);
      result.companies = r.recordset.map((row: { v: unknown }) => String(row.v ?? '')).filter(Boolean);
    }
    if (clientCol) {
      const req = pool.request();
      const scopeSql = bindScope(req);
      const q = quoteId('sqlserver2008r2', clientCol);
      const r = await req.query(`SELECT DISTINCT TOP 250 ${q} AS v FROM ${tableExpr}${scopeSql} ORDER BY v ASC`);
      result.clients = r.recordset.map((row: { v: unknown }) => String(row.v ?? '')).filter(Boolean);
    }
    if (articleCol) {
      const req = pool.request();
      const scopeSql = bindScope(req);
      const q = quoteId('sqlserver2008r2', articleCol);
      const r = await req.query(`SELECT DISTINCT TOP 250 ${q} AS v FROM ${tableExpr}${scopeSql} ORDER BY v ASC`);
      result.articles = r.recordset.map((row: { v: unknown }) => String(row.v ?? '')).filter(Boolean);
    }
    if (dateCol) {
      const req = pool.request();
      const scopeSql = bindScope(req);
      const q = quoteId('sqlserver2008r2', dateCol);
      const r = await req.query(`SELECT CONVERT(VARCHAR(10), MIN(${q}), 23) AS minD, CONVERT(VARCHAR(10), MAX(${q}), 23) AS maxD FROM ${tableExpr}${scopeSql}`);
      const row = r.recordset?.[0] as { minD?: string; maxD?: string } | undefined;
      result.minDate = row?.minD || '';
      result.maxDate = row?.maxD || '';
    }
    return result;
  });
}

export async function executeWidgetQuery(
  conn: InternalConnectionRecord,
  widget: WidgetConfig,
  filters: DynamicFilters,
  allowedCompanies: string[]
): Promise<WidgetQueryResult> {
  const started = Date.now();
  const schema = await introspectSchema(conn);
  const targetObj = findValidatedObject(schema, widget.sourceObject);
  const tableExpr = quoteObject(conn.engine, targetObj);

  const allowedAggs = new Set(['SUM', 'AVG', 'COUNT', 'MIN', 'MAX']);
  const agg = allowedAggs.has(widget.aggregation) ? widget.aggregation : 'SUM';
  const measureCol =
    widget.measureColumn === '*' ? '*' : findValidatedColumn(targetObj, widget.measureColumn);
  if (!measureCol) {
    throw new Error(`Colonne de mesure introuvable : ${widget.measureColumn}`);
  }

  const dimCol = findValidatedColumn(targetObj, widget.dimensionColumn);
  const dateCol = findValidatedColumn(targetObj, widget.dateColumn);
  const clientCol = findValidatedColumn(targetObj, widget.clientColumn);
  const articleCol = findValidatedColumn(targetObj, widget.articleColumn);
  const companyCol = findValidatedColumn(targetObj, widget.companyColumn);
  const limit = Math.min(Math.max(Number(widget.limit) || 20, 1), 200);
  const sortDir = widget.sortDirection === 'ASC' ? 'ASC' : 'DESC';

  const whereParts: string[] = [];
  const params: { name: string; value: string }[] = [];
  const addParam = (val: string) => {
    const name = `p${params.length}`;
    params.push({ name, value: val });
    return isSqliteEngine(conn.engine) ? '?' : `@${name}`;
  };

  if (companyCol && allowedCompanies.length > 0) {
    const q = quoteId(conn.engine, companyCol);
    const placeholders = allowedCompanies.map((c) => addParam(c));
    whereParts.push(`${q} IN (${placeholders.join(', ')})`);
  }

  if (dateCol && filters.dateFrom) {
    if (isSqliteEngine(conn.engine)) {
      whereParts.push(`${quoteId(conn.engine, dateCol)} >= ${addParam(filters.dateFrom)}`);
    } else {
      whereParts.push(
        `CAST(${quoteId(conn.engine, dateCol)} AS DATE) >= CONVERT(DATE, ${addParam(filters.dateFrom)}, 23)`
      );
    }
  }
  if (dateCol && filters.dateTo) {
    if (isSqliteEngine(conn.engine)) {
      whereParts.push(`${quoteId(conn.engine, dateCol)} <= ${addParam(filters.dateTo)}`);
    } else {
      whereParts.push(
        `CAST(${quoteId(conn.engine, dateCol)} AS DATE) <= CONVERT(DATE, ${addParam(filters.dateTo)}, 23)`
      );
    }
  }
  if (clientCol && filters.client) {
    whereParts.push(`${quoteId(conn.engine, clientCol)} = ${addParam(filters.client)}`);
  }
  if (articleCol && filters.article) {
    whereParts.push(`${quoteId(conn.engine, articleCol)} = ${addParam(filters.article)}`);
  }
  if (companyCol && filters.company) {
    whereParts.push(`${quoteId(conn.engine, companyCol)} = ${addParam(filters.company)}`);
  }
  if (filters.search && filters.search.trim().length > 0) {
    const searchableCols = [clientCol, articleCol, companyCol, dimCol].filter(Boolean) as string[];
    if (searchableCols.length > 0) {
      const searchPattern = `%${filters.search.trim()}%`;
      const orParts = searchableCols.map((c) => `${quoteId(conn.engine, c)} LIKE ${addParam(searchPattern)}`);
      whereParts.push(`(${orParts.join(' OR ')})`);
    }
  }

  const whereSql = whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : '';
  const measureExpr =
    measureCol === '*' ? 'COUNT(*)' : `${agg}(${quoteId(conn.engine, measureCol)})`;

  let sqlText = '';
  if (widget.type === 'kpi' || !dimCol) {
    if (widget.type === 'table') {
      const validCols = (widget.tableColumns || [])
        .map((c) => findValidatedColumn(targetObj, c))
        .filter(Boolean) as string[];
      const selectedCols = validCols.length > 0 ? validCols : targetObj.columns.slice(0, 8).map((c) => c.name);
      const selectExpr = selectedCols.map((c) => quoteId(conn.engine, c)).join(', ');
      const orderCol = dateCol || selectedCols[0];
      if (isSqliteEngine(conn.engine)) {
        sqlText = `SELECT ${selectExpr} FROM ${tableExpr}${whereSql} ORDER BY ${quoteId(conn.engine, orderCol)} ${sortDir} LIMIT ${limit}`;
      } else {
        sqlText = `SELECT TOP ${limit} ${selectExpr} FROM ${tableExpr}${whereSql} ORDER BY ${quoteId('sqlserver2008r2', orderCol)} ${sortDir}`;
      }
    } else {
      sqlText = `SELECT ${measureExpr} AS value, COUNT(*) AS row_count FROM ${tableExpr}${whereSql}`;
    }
  } else {
    const dimExpr = quoteId(conn.engine, dimCol);
    const orderExpr = widget.type === 'line' ? `label ${sortDir}` : `value ${sortDir}`;
    if (isSqliteEngine(conn.engine)) {
      sqlText = `SELECT ${dimExpr} AS label, ${measureExpr} AS value, COUNT(*) AS row_count FROM ${tableExpr}${whereSql} GROUP BY ${dimExpr} ORDER BY ${orderExpr} LIMIT ${limit}`;
    } else {
      sqlText = `SELECT TOP ${limit} ${dimExpr} AS label, ${measureExpr} AS value, COUNT(*) AS row_count FROM ${tableExpr}${whereSql} GROUP BY ${dimExpr} ORDER BY ${orderExpr}`;
    }
  }

  let rows: Record<string, string | number | null>[] = [];
  if (isSqliteEngine(conn.engine)) {
    const db = getSqliteHandle(conn);
    rows = db.prepare(sqlText).all(...params.map((p) => p.value)) as Record<string, string | number | null>[];
  } else if (conn.engine === 'agent_relay') {
    const agent = resolveAgent(conn);
    const out = await dispatchAgentJob<{ rows: Record<string, string | number | null>[] }>(
      agent.id,
      agent.last_seen_at,
      {
        type: 'sql_query',
        sqlConfig: getAgentPayloadSqlConfig(conn),
        sql: sqlText,
        params,
      }
    );
    rows = out.rows || [];
  } else {
    rows = await withMssqlConnection(conn, async (pool) => {
      const req = pool.request();
      for (const p of params) {
        req.input(p.name, sql.NVarChar, p.value);
      }
      const res = await req.query(sqlText);
      return (res.recordset || []) as Record<string, string | number | null>[];
    });
  }

  const summaryValue =
    widget.type === 'kpi'
      ? Number(rows[0]?.value ?? 0)
      : widget.type === 'table'
      ? rows.length
      : rows.reduce((acc, r) => acc + Number(r.value ?? 0), 0);

  return {
    widgetId: widget.id,
    rows,
    summaryValue: Number.isFinite(summaryValue) ? Math.round(summaryValue * 100) / 100 : null,
    rowCount: rows.length,
    durationMs: Date.now() - started,
    sqlPreview: sqlText,
    refreshedAt: new Date().toISOString(),
  };
}

export async function executeReadOnlyCustomSql(
  conn: InternalConnectionRecord,
  rawSql: string,
  maxRows = 250
): Promise<SqlExecutionResult> {
  const started = Date.now();
  const validation = validateReadOnlySql(rawSql);
  if (!validation.valid) {
    throw new Error(validation.reason || 'Requête bloquée par le mode lecture seule.');
  }

  const safeLimit = Math.min(Math.max(maxRows, 1), 500);
  let rows: Record<string, unknown>[] = [];

  if (isSqliteEngine(conn.engine)) {
    const db = getSqliteHandle(conn);
    const stmt = db.prepare(validation.sanitizedSql);
    if (!stmt.readonly) {
      throw new Error('Mode lecture seule : opération non autorisée.');
    }
    const allRows = stmt.all() as Record<string, unknown>[];
    rows = allRows;
  } else if (conn.engine === 'agent_relay') {
    const agent = resolveAgent(conn);
    const out = await dispatchAgentJob<{ rows: Record<string, unknown>[] }>(
      agent.id,
      agent.last_seen_at,
      {
        type: 'sql_query',
        sqlConfig: getAgentPayloadSqlConfig(conn),
        sql: validation.sanitizedSql,
        params: [],
      }
    );
    rows = out.rows || [];
  } else {
    rows = await withMssqlConnection(conn, async (pool) => {
      const res = await pool.request().query(validation.sanitizedSql);
      return (res.recordset || []) as Record<string, unknown>[];
    });
  }

  const truncated = rows.length > safeLimit;
  const sliced = truncated ? rows.slice(0, safeLimit) : rows;
  const columns = sliced.length > 0 ? Object.keys(sliced[0]) : [];

  return {
    columns,
    rows: sliced,
    rowCount: sliced.length,
    durationMs: Date.now() - started,
    truncated,
    readOnlyVerified: true,
  };
}
