import crypto from 'node:crypto';
import type { Response } from 'express';

export interface AgentJobPayload {
  jobId: string;
  type: 'test' | 'schema' | 'sql_query' | 'sql_batch';
  sqlConfig: {
    host: string;
    port: number;
    instanceName?: string;
    database: string;
    username: string;
    password: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
    tdsVersion: '7_2' | '7_3_A' | '7_3_B' | '7_4';
  };
  sql?: string;
  params?: { name: string; value: string }[];
  queries?: { key: string; sql: string; params: { name: string; value: string }[] }[];
}

interface PendingPoller {
  res: Response;
  timer: NodeJS.Timeout;
}

interface InFlightJob {
  agentId: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const pendingPollers = new Map<string, PendingPoller>();
const queuedJobs = new Map<string, AgentJobPayload[]>();
const inFlightJobs = new Map<string, InFlightJob>();

export function isAgentOnline(agentId: string, lastSeenAt?: string | null): boolean {
  if (pendingPollers.has(agentId)) return true;
  if (!lastSeenAt) return false;
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  return ageMs >= 0 && ageMs < 35_000;
}

export function handleAgentPoll(agentId: string, res: Response): void {
  const existingQueue = queuedJobs.get(agentId);
  if (existingQueue && existingQueue.length > 0) {
    const nextJob = existingQueue.shift()!;
    if (existingQueue.length === 0) queuedJobs.delete(agentId);
    res.json({ job: nextJob });
    return;
  }

  // Close any superseded poller for the same agent
  const prev = pendingPollers.get(agentId);
  if (prev) {
    clearTimeout(prev.timer);
    if (!prev.res.headersSent) {
      prev.res.status(204).end();
    }
    pendingPollers.delete(agentId);
  }

  const timer = setTimeout(() => {
    pendingPollers.delete(agentId);
    if (!res.headersSent) {
      res.status(204).end();
    }
  }, 24_000);

  res.on('close', () => {
    clearTimeout(timer);
    const cur = pendingPollers.get(agentId);
    if (cur && cur.res === res) {
      pendingPollers.delete(agentId);
    }
  });

  pendingPollers.set(agentId, { res, timer });
}

export function submitAgentJobResult(
  agentId: string,
  jobId: string,
  ok: boolean,
  data: unknown,
  errorMessage?: string
): boolean {
  const pending = inFlightJobs.get(jobId);
  if (!pending || pending.agentId !== agentId) return false;
  clearTimeout(pending.timer);
  inFlightJobs.delete(jobId);

  if (ok) {
    pending.resolve(data);
  } else {
    pending.reject(new Error(errorMessage || 'Erreur SQL sur le poste Windows local.'));
  }
  return true;
}

export function dispatchAgentJob<T>(
  agentId: string,
  lastSeenAt: string | null | undefined,
  jobInput: Omit<AgentJobPayload, 'jobId'>
): Promise<T> {
  if (!isAgentOnline(agentId, lastSeenAt)) {
    return Promise.reject(
      new Error(
        'Agent Relais Windows hors ligne. Lancez « demarrer-agent.bat » sur votre poste Windows (ex. desktop-3p076mi) puis réessayez.'
      )
    );
  }

  const jobId = `job-${crypto.randomUUID().slice(0, 12)}`;
  const job: AgentJobPayload = { ...jobInput, jobId };

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      inFlightJobs.delete(jobId);
      reject(new Error('Délai dépassé : l’Agent Relais Windows n’a pas répondu dans les 20 secondes.'));
    }, 20_000);

    inFlightJobs.set(jobId, {
      agentId,
      resolve: resolve as (data: unknown) => void,
      reject,
      timer,
    });

    const poller = pendingPollers.get(agentId);
    if (poller) {
      clearTimeout(poller.timer);
      pendingPollers.delete(agentId);
      if (!poller.res.headersSent) {
        poller.res.json({ job });
        return;
      }
    }

    const q = queuedJobs.get(agentId) || [];
    q.push(job);
    queuedJobs.set(agentId, q);
  });
}

export function buildAgentScriptContent(serverUrl: string, agentToken: string): string {
  return `// SQL BI Studio — Agent Relais Local (Windows / SQL Server 2008 R2 à 2022)
// Ce script établit une connexion sortante HTTPS vers SQL BI Studio et exécute uniquement des requêtes SELECT locales.
import os from 'node:os';
import sql from 'mssql';

const SERVER_URL = ${JSON.stringify(serverUrl.replace(/\/$/, ''))};
const AGENT_TOKEN = ${JSON.stringify(agentToken)};

const FORBIDDEN = /\\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|EXEC|EXECUTE|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|SHUTDOWN|KILL|BULK|OPENROWSET|OPENDATASOURCE)\\b/i;

function assertReadOnlySql(query) {
  const trimmed = String(query || '').trim();
  if (!/^(SELECT|WITH)\\b/i.test(trimmed) || FORBIDDEN.test(trimmed)) {
    throw new Error('Requête bloquée par l’agent local (mode lecture seule strict).');
  }
}

async function runWithMssql(cfgInput, fn) {
  const isLegacy = cfgInput.tdsVersion === '7_2' || cfgInput.tdsVersion === '7_3_A' || cfgInput.tdsVersion === '7_3_B';
  const hasInstance = Boolean(cfgInput.instanceName && cfgInput.instanceName.trim());
  const cfg = {
    server: cfgInput.host,
    port: hasInstance ? undefined : Number(cfgInput.port || 1433),
    database: cfgInput.database,
    user: cfgInput.username,
    password: cfgInput.password,
    connectionTimeout: 8000,
    requestTimeout: 15000,
    options: {
      encrypt: Boolean(cfgInput.encrypt),
      trustServerCertificate: cfgInput.trustServerCertificate !== false,
      readOnlyIntent: true,
      enableArithAbort: true,
      tdsVersion: cfgInput.tdsVersion || '7_3_A',
      useUTC: false,
      ...(hasInstance ? { instanceName: cfgInput.instanceName.trim() } : {}),
      ...(isLegacy ? { cryptoCredentialsDetails: { minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0' } } : {}),
    },
  };

  const pool = new sql.ConnectionPool(cfg);
  try {
    await pool.connect();
    await pool.request().query('SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT 5000;');
    return await fn(pool);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

async function executeJob(job) {
  const started = Date.now();
  if (job.type === 'test') {
    return runWithMssql(job.sqlConfig, async (pool) => {
      const res = await pool.request().query('SELECT @@VERSION AS version, DB_NAME() AS db_name');
      const rec = res.recordset?.[0] || {};
      const firstLine = String(rec.version || 'Microsoft SQL Server').split('\\n')[0].trim();
      return {
        ok: true,
        serverVersion: firstLine,
        latencyMs: Date.now() - started,
        message: 'Connecté via Agent Local à « ' + (rec.db_name || job.sqlConfig.database) + ' » (lecture seule).',
      };
    });
  }

  if (job.type === 'schema') {
    return runWithMssql(job.sqlConfig, async (pool) => {
      const tablesRes = await pool.request().query(\`
        SELECT t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_TYPE,
          ISNULL((SELECT SUM(p.rows) FROM sys.partitions p INNER JOIN sys.objects o ON o.object_id = p.object_id INNER JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = t.TABLE_SCHEMA AND o.name = t.TABLE_NAME AND p.index_id IN (0, 1)), 0) AS ROW_COUNT
        FROM INFORMATION_SCHEMA.TABLES t
        WHERE t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
        ORDER BY t.TABLE_TYPE, t.TABLE_SCHEMA, t.TABLE_NAME
      \`);
      const colsRes = await pool.request().query(\`
        SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS c
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
      \`);
      const keysRes = await pool.request().query(\`
        SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME, tc.CONSTRAINT_TYPE, kcu2.TABLE_NAME AS REFERENCED_TABLE
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
        LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc ON tc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
        LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu2 ON rc.UNIQUE_CONSTRAINT_NAME = kcu2.CONSTRAINT_NAME AND rc.UNIQUE_CONSTRAINT_SCHEMA = kcu2.CONSTRAINT_SCHEMA
        WHERE tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY')
      \`);
      return { tables: tablesRes.recordset || [], columns: colsRes.recordset || [], keys: keysRes.recordset || [] };
    });
  }

  if (job.type === 'sql_query') {
    assertReadOnlySql(job.sql);
    return runWithMssql(job.sqlConfig, async (pool) => {
      const req = pool.request();
      for (const p of job.params || []) {
        req.input(p.name, sql.NVarChar, p.value);
      }
      const res = await req.query(job.sql);
      return { rows: res.recordset || [] };
    });
  }

  if (job.type === 'sql_batch') {
    for (const q of job.queries || []) assertReadOnlySql(q.sql);
    return runWithMssql(job.sqlConfig, async (pool) => {
      const out = {};
      for (const q of job.queries || []) {
        const req = pool.request();
        for (const p of q.params || []) {
          req.input(p.name, sql.NVarChar, p.value);
        }
        const res = await req.query(q.sql);
        out[q.key] = res.recordset || [];
      }
      return out;
    });
  }

  throw new Error('Type de tâche agent inconnu.');
}

async function pollLoop() {
  const hostName = os.hostname();
  console.log('[SQL BI Agent] Démarré sur', hostName, '-> relais vers', SERVER_URL);

  while (true) {
    try {
      const res = await fetch(\`\${SERVER_URL}/api/agent/poll?hostname=\${encodeURIComponent(hostName)}\`, {
        headers: { Authorization: \`Bearer \${AGENT_TOKEN}\` },
      });

      if (res.status === 204) {
        continue;
      }
      if (!res.ok) {
        console.error('[SQL BI Agent] Erreur serveur HTTP', res.status);
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }

      const payload = await res.json();
      if (!payload?.job) continue;

      const job = payload.job;
      let ok = true;
      let data = null;
      let errorMessage = undefined;
      try {
        data = await executeJob(job);
      } catch (err) {
        ok = false;
        errorMessage = err instanceof Error ? err.message : String(err);
        console.error('[SQL BI Agent] Erreur SQL:', errorMessage);
      }

      await fetch(\`\${SERVER_URL}/api/agent/result\`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: \`Bearer \${AGENT_TOKEN}\`,
        },
        body: JSON.stringify({ jobId: job.jobId, ok, data, errorMessage }),
      });
    } catch (err) {
      console.error('[SQL BI Agent] Connexion au serveur perdue:', err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

pollLoop();
`;
}
