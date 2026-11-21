import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ConnectionEngine,
  DashboardConfig,
  DynamicFilters,
  SchemaObject,
  UserProfile,
  WidgetConfig,
} from './src/types/bi.ts';
import {
  buildAgentScriptContent,
  handleAgentPoll,
  isAgentOnline,
  submitAgentJobResult,
} from './server/agentRelay.ts';
import {
  executeReadOnlyCustomSql,
  executeWidgetQuery,
  getFilterOptionsForSource,
  introspectSchema,
  invalidateSchemaCache,
  testConnectionEngine,
} from './server/connector.ts';
import { signAuthToken, verifyAuthToken } from './server/security.ts';
import {
  importSpreadsheetToSqlite,
  importSqlDumpToSqlite,
  importSqliteBinary,
  removeImportedDbFile,
} from './server/sqlImporter.ts';
import {
  authenticateUser,
  claimInitialAdmin,
  createAgentRecord,
  createUserAccount,
  deleteAgentRecord,
  deleteConnection,
  deleteDashboard,
  deleteUserAccount,
  getConnectionById,
  getUserById,
  hasAdminPasscodeEnv,
  isFirstRunSetupRequired,
  listAgentRecords,
  listConnections,
  listDashboards,
  listRefreshLogs,
  listUsers,
  recordRefreshLog,
  rotateAgentToken,
  sanitizeConnectionForClient,
  saveConnection,
  saveDashboard,
  updateAgentHeartbeat,
  updateConnectionStatus,
  updateUserAccount,
  verifyAgentBearerToken,
} from './server/store.ts';

interface AuthenticatedRequest extends Request {
  user?: UserProfile;
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentification requise.' });
    return;
  }
  const token = authHeader.slice(7).trim();
  const payload = verifyAuthToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Session expirée ou invalide.' });
    return;
  }
  const user = getUserById(payload.sub);
  if (!user || !user.active) {
    res.status(401).json({ error: 'Compte utilisateur introuvable ou désactivé.' });
    return;
  }
  req.user = user;
  next();
}

function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Action réservée aux administrateurs.' });
    return;
  }
  next();
}

function canAccessConnection(user: UserProfile, connectionId: string): boolean {
  if (user.role === 'admin') return true;
  return user.allowedConnectionIds.includes(connectionId);
}

function buildAutoDashboardForSchema(
  connectionId: string,
  connectionName: string,
  objects: SchemaObject[],
  createdBy: string
): DashboardConfig | null {
  if (objects.length === 0) return null;

  const sorted = [...objects].sort((a, b) => {
    const scoreA = (a.type === 'VIEW' ? 1000 : 0) + (a.rowCount > 0 ? a.rowCount : 0);
    const scoreB = (b.type === 'VIEW' ? 1000 : 0) + (b.rowCount > 0 ? b.rowCount : 0);
    return scoreB - scoreA;
  });

  const primary = sorted[0];
  const cols = primary.columns;
  if (cols.length === 0) return null;

  const isNumericType = (dt: string) =>
    /INT|REAL|FLOAT|DOUBLE|DECIMAL|NUMERIC|MONEY|NUMBER/i.test(dt);

  const numericMeasures = cols.filter(
    (c) =>
      isNumericType(c.dataType) &&
      !c.isPrimaryKey &&
      !c.isForeignKey &&
      !/^(id|_id)$/i.test(c.name) &&
      !/_id$|^id_/i.test(c.name)
  );
  const textDims = cols.filter((c) => !isNumericType(c.dataType) && !c.isPrimaryKey);

  const findCol = (patterns: string[]) =>
    cols.find((c) => patterns.some((p) => c.name.toUpperCase().includes(p)))?.name;

  const dateCol = findCol(['DATE', 'MOIS', 'ANNEE', 'CREATED']);
  const clientCol = findCol(['CLIENT', 'CUSTOMER', 'TIERS']);
  const articleCol = findCol(['ARTICLE', 'PRODUIT', 'PRODUCT', 'ITEM', 'LIBELLE']);
  const companyCol = findCol(['SOCIETE', 'COMPANY', 'FILIALE', 'AGENCE']);

  const mainMeasure = numericMeasures[0]?.name || '*';
  const mainAgg = mainMeasure === '*' ? 'COUNT' : 'SUM';
  const mainLabel = mainMeasure === '*' ? 'Nombre de lignes' : `Total ${mainMeasure}`;

  const widgets: WidgetConfig[] = [
    {
      id: `w-${crypto.randomUUID().slice(0, 6)}`,
      title: mainLabel,
      type: 'kpi',
      connectionId,
      sourceObject: primary.fullName,
      measureColumn: mainMeasure,
      aggregation: mainAgg,
      dateColumn: dateCol,
      clientColumn: clientCol,
      articleColumn: articleCol,
      companyColumn: companyCol,
      colSpan: 1,
    },
    {
      id: `w-${crypto.randomUUID().slice(0, 6)}`,
      title: `Nombre d'enregistrements (${primary.name})`,
      type: 'kpi',
      connectionId,
      sourceObject: primary.fullName,
      measureColumn: '*',
      aggregation: 'COUNT',
      dateColumn: dateCol,
      clientColumn: clientCol,
      articleColumn: articleCol,
      companyColumn: companyCol,
      colSpan: 1,
    },
  ];

  if (numericMeasures[1]) {
    widgets.push({
      id: `w-${crypto.randomUUID().slice(0, 6)}`,
      title: `Total ${numericMeasures[1].name}`,
      type: 'kpi',
      connectionId,
      sourceObject: primary.fullName,
      measureColumn: numericMeasures[1].name,
      aggregation: 'SUM',
      dateColumn: dateCol,
      clientColumn: clientCol,
      articleColumn: articleCol,
      companyColumn: companyCol,
      colSpan: 1,
    });
  }

  const dim1 =
    [clientCol, articleCol, companyCol, textDims[0]?.name].find(Boolean) ||
    cols.find((c) => c.name !== mainMeasure)?.name;

  if (dim1) {
    widgets.push({
      id: `w-${crypto.randomUUID().slice(0, 6)}`,
      title: `${mainLabel} par ${dim1}`,
      type: 'bar',
      connectionId,
      sourceObject: primary.fullName,
      dimensionColumn: dim1,
      measureColumn: mainMeasure,
      aggregation: mainAgg,
      dateColumn: dateCol,
      clientColumn: clientCol,
      articleColumn: articleCol,
      companyColumn: companyCol,
      sortDirection: 'DESC',
      limit: 10,
      colSpan: 2,
    });
  }

  const dim2 =
    textDims.find((c) => c.name !== dim1 && c.name !== dateCol)?.name ||
    (dateCol && dateCol !== dim1 ? dateCol : undefined);

  if (dim2) {
    widgets.push({
      id: `w-${crypto.randomUUID().slice(0, 6)}`,
      title: `Répartition par ${dim2}`,
      type: 'pie',
      connectionId,
      sourceObject: primary.fullName,
      dimensionColumn: dim2,
      measureColumn: mainMeasure,
      aggregation: mainAgg,
      dateColumn: dateCol,
      clientColumn: clientCol,
      articleColumn: articleCol,
      companyColumn: companyCol,
      sortDirection: 'DESC',
      limit: 8,
      colSpan: 1,
    });
  }

  widgets.push({
    id: `w-${crypto.randomUUID().slice(0, 6)}`,
    title: `Aperçu des données — ${primary.name}`,
    type: 'table',
    connectionId,
    sourceObject: primary.fullName,
    measureColumn: mainMeasure,
    aggregation: mainAgg,
    dateColumn: dateCol,
    clientColumn: clientCol,
    articleColumn: articleCol,
    companyColumn: companyCol,
    sortDirection: 'DESC',
    limit: 50,
    tableColumns: cols.slice(0, 8).map((c) => c.name),
    colSpan: 3,
  });

  return saveDashboard({
    name: `Analyse · ${connectionName}`,
    description: `Tableau de bord généré automatiquement depuis « ${primary.name} » (${objects.length} objet(s) détecté(s)).`,
    connectionId,
    widgets,
    createdBy,
  });
}

async function startServer(): Promise<void> {
  const app = express();
  const port = Number(process.env.PORT || 3000);

  app.set('trust proxy', 1);

  // Dedicated 35 MB body parser for database dump/file imports before default 1 MB limit
  app.post(
    '/api/connections/import',
    express.json({ limit: '35mb' }),
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const started = Date.now();
      let importedFileName: string | undefined;
      try {
        const body = req.body as {
          name?: string;
          originalFileName?: string;
          contentBase64?: string;
          description?: string;
          autoCreateDashboard?: boolean;
        };

        if (!body.originalFileName || !body.contentBase64) {
          res.status(400).json({ error: 'Fichier de base SQL requis.' });
          return;
        }

        const originalFileName = path.basename(body.originalFileName).slice(0, 140);
        const ext = path.extname(originalFileName).toLowerCase();
        const allowedExts = new Set(['.sql', '.txt', '.ddl', '.db', '.sqlite', '.sqlite3', '.csv', '.xlsx', '.xls']);
        if (!allowedExts.has(ext)) {
          res.status(400).json({
            error: 'Format non pris en charge. Formats acceptés : .sql, .db, .sqlite, .csv, .xlsx.',
          });
          return;
        }

        const base64Clean = body.contentBase64.includes(',')
          ? body.contentBase64.slice(body.contentBase64.indexOf(',') + 1)
          : body.contentBase64;
        const buffer = Buffer.from(base64Clean, 'base64');

        if (buffer.length === 0) {
          res.status(400).json({ error: 'Le fichier importé est vide.' });
          return;
        }
        if (buffer.length > 25 * 1024 * 1024) {
          res.status(400).json({ error: 'Taille maximale dépassée (25 Mo maximum par importation).' });
          return;
        }

        let summary;
        if (ext === '.sql' || ext === '.txt' || ext === '.ddl') {
          // Handle UTF-16LE BOM (frequent in SSMS "Save as Unicode text" scripts)
          const sqlText =
            buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
              ? buffer.subarray(2).toString('utf16le')
              : buffer.toString('utf8');
          summary = importSqlDumpToSqlite(sqlText);
        } else if (ext === '.db' || ext === '.sqlite' || ext === '.sqlite3') {
          summary = importSqliteBinary(buffer);
        } else {
          summary = importSpreadsheetToSqlite(buffer, originalFileName);
        }

        importedFileName = summary.fileName;

        const baseLabel =
          body.name?.trim() ||
          path.basename(originalFileName, ext).replace(/[_-]+/g, ' ').trim() ||
          'Base SQL importée';

        const saved = saveConnection({
          name: baseLabel,
          engine: 'imported_sqlite',
          importFileName: summary.fileName,
          host: 'import-local',
          port: 0,
          database: originalFileName,
          username: 'lecture_seule',
          encrypt: false,
          trustServerCertificate: true,
          tdsVersion: '7_4',
          description:
            body.description?.trim() ||
            `Base importée depuis « ${originalFileName} » (${summary.tablesCreated} table(s), ${summary.viewsCreated} vue(s), ${summary.rowsInserted} ligne(s)).`,
          lastStatus: 'connected',
        });

        const schema = await introspectSchema(saved, true);
        let dashboard: DashboardConfig | null = null;
        if (body.autoCreateDashboard !== false) {
          dashboard = buildAutoDashboardForSchema(saved.id, saved.name, schema, req.user!.name);
        }

        recordRefreshLog({
          connectionId: saved.id,
          connectionName: saved.name,
          userName: req.user!.name,
          action: `Importation base (${summary.tablesCreated} tables, ${summary.viewsCreated} vues, ${summary.rowsInserted} lignes)`,
          durationMs: Date.now() - started,
          status: 'success',
        });

        res.status(201).json({
          connection: sanitizeConnectionForClient(saved),
          summary,
          schema,
          dashboard: dashboard || undefined,
        });
      } catch (err) {
        if (importedFileName) {
          removeImportedDbFile(importedFileName);
        }
        const msg = err instanceof Error ? err.message : 'Erreur lors de l’importation de la base.';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.use(express.json({ limit: '1mb' }));

  // --- Auth Endpoints ---
  app.get('/api/auth/status', (_req, res) => {
    res.json({
      needsSetup: isFirstRunSetupRequired(),
      hasEnvAdminOverride: hasAdminPasscodeEnv(),
    });
  });

  app.post('/api/auth/setup', (req, res) => {
    try {
      const { name, email, password } = req.body as {
        name?: string;
        email?: string;
        password?: string;
      };
      if (!name || !email || !password) {
        res.status(400).json({ error: 'Nom, e-mail et mot de passe requis.' });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ error: 'Le mot de passe administrateur doit contenir au moins 8 caractères.' });
        return;
      }
      const user = claimInitialAdmin(name, email, password);
      const token = signAuthToken({ sub: user.id, email: user.email, role: user.role });
      res.status(201).json({ token, user });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'SETUP_LOCKED') {
        res.status(409).json({ error: 'Le compte administrateur initial est déjà configuré.' });
        return;
      }
      res.status(500).json({ error: 'Erreur lors de l’initialisation administrateur.' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!password || (!email && !hasAdminPasscodeEnv())) {
      res.status(400).json({ error: 'Identifiants requis.' });
      return;
    }
    const user = authenticateUser(email || '', password);
    if (!user) {
      res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
      return;
    }
    const token = signAuthToken({ sub: user.id, email: user.email, role: user.role });
    res.json({ token, user });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ user: req.user });
  });

  // --- User & Access Control Management ---
  app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
    res.json({ users: listUsers() });
  });

  app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
    try {
      const body = req.body as {
        name?: string;
        email?: string;
        password?: string;
        role?: 'admin' | 'analyste' | 'lecteur';
        allowedConnectionIds?: string[];
        allowedCompanies?: string[];
        canExport?: boolean;
        canRunSql?: boolean;
        canEditDashboards?: boolean;
      };
      if (!body.name || !body.email || !body.password || body.password.length < 8) {
        res.status(400).json({ error: 'Nom, e-mail et mot de passe (min 8 caractères) requis.' });
        return;
      }
      const role = body.role && ['admin', 'analyste', 'lecteur'].includes(body.role) ? body.role : 'lecteur';
      const created = createUserAccount({
        name: body.name,
        email: body.email,
        password: body.password,
        role,
        allowedConnectionIds: Array.isArray(body.allowedConnectionIds) ? body.allowedConnectionIds : ['conn-sandbox-erp'],
        allowedCompanies: Array.isArray(body.allowedCompanies) ? body.allowedCompanies : [],
        canExport: body.canExport !== false,
        canRunSql: role !== 'lecteur' && body.canRunSql !== false,
        canEditDashboards: role !== 'lecteur' && body.canEditDashboards !== false,
      });
      res.status(201).json({ user: created });
    } catch (err) {
      const message = err instanceof Error && err.message.includes('UNIQUE') ? 'Cet e-mail existe déjà.' : 'Création impossible.';
      res.status(400).json({ error: message });
    }
  });

  app.patch('/api/users/:id', requireAuth, requireAdmin, (req: AuthenticatedRequest, res) => {
    const id = req.params.id;
    const body = req.body as Record<string, unknown>;
    if (req.user?.id === id && body.active === false) {
      res.status(400).json({ error: 'Impossible de désactiver votre propre session administrateur.' });
      return;
    }
    const updated = updateUserAccount(id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      role:
        body.role === 'admin' || body.role === 'analyste' || body.role === 'lecteur'
          ? body.role
          : undefined,
      allowedConnectionIds: Array.isArray(body.allowedConnectionIds)
        ? (body.allowedConnectionIds as string[])
        : undefined,
      allowedCompanies: Array.isArray(body.allowedCompanies)
        ? (body.allowedCompanies as string[])
        : undefined,
      canExport: typeof body.canExport === 'boolean' ? body.canExport : undefined,
      canRunSql: typeof body.canRunSql === 'boolean' ? body.canRunSql : undefined,
      canEditDashboards: typeof body.canEditDashboards === 'boolean' ? body.canEditDashboards : undefined,
      active: typeof body.active === 'boolean' ? body.active : undefined,
      password: typeof body.password === 'string' && body.password.length >= 8 ? body.password : undefined,
    });
    if (!updated) {
      res.status(404).json({ error: 'Utilisateur introuvable.' });
      return;
    }
    res.json({ user: updated });
  });

  app.delete('/api/users/:id', requireAuth, requireAdmin, (req: AuthenticatedRequest, res) => {
    if (req.user?.id === req.params.id) {
      res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
      return;
    }
    const deleted = deleteUserAccount(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Utilisateur introuvable.' });
      return;
    }
    res.json({ ok: true });
  });

  // --- SQL Server Connections & Introspection ---
  app.get('/api/connections', requireAuth, (req: AuthenticatedRequest, res) => {
    const all = listConnections()
      .filter((c) => canAccessConnection(req.user!, c.id))
      .map(sanitizeConnectionForClient);
    res.json({ connections: all });
  });

  app.post('/api/connections', requireAuth, requireAdmin, (req, res) => {
    const body = req.body as {
      id?: string;
      name?: string;
      engine?: ConnectionEngine;
      agentId?: string;
      host?: string;
      port?: number;
      instanceName?: string;
      database?: string;
      username?: string;
      password?: string;
      encrypt?: boolean;
      trustServerCertificate?: boolean;
      tdsVersion?: '7_2' | '7_3_A' | '7_3_B' | '7_4';
      description?: string;
    };
    const existing = body.id ? getConnectionById(body.id) : null;
    if (existing?.engine === 'imported_sqlite') {
      const saved = saveConnection({
        id: existing.id,
        name: body.name || existing.name,
        engine: 'imported_sqlite',
        importFileName: existing.importFileName,
        host: existing.host,
        port: existing.port,
        database: body.database || existing.database,
        username: existing.username,
        encrypt: false,
        trustServerCertificate: true,
        tdsVersion: existing.tdsVersion,
        description: body.description,
      });
      invalidateSchemaCache(saved.id);
      res.status(201).json({ connection: sanitizeConnectionForClient(saved) });
      return;
    }

    if (!body.name || !body.database || (!body.host && body.engine !== 'sandbox_erp')) {
      res.status(400).json({ error: 'Nom, serveur et base de données requis.' });
      return;
    }
    const engine: ConnectionEngine =
      body.engine === 'sandbox_erp'
        ? 'sandbox_erp'
        : body.engine === 'agent_relay'
        ? 'agent_relay'
        : 'sqlserver2008r2';

    if (engine === 'agent_relay' && !body.agentId) {
      res.status(400).json({ error: 'Sélectionnez un Agent Relais Windows pour ce mode de connexion.' });
      return;
    }

    const saved = saveConnection({
      id: body.id,
      name: body.name,
      engine,
      agentId: engine === 'agent_relay' ? body.agentId : undefined,
      host: body.host || 'localhost',
      port: Number(body.port) || 1433,
      instanceName: body.instanceName,
      database: body.database,
      username: body.username || '',
      password: body.password,
      encrypt: Boolean(body.encrypt),
      trustServerCertificate: body.trustServerCertificate !== false,
      tdsVersion: body.tdsVersion || '7_3_A',
      description: body.description,
    });
    invalidateSchemaCache(saved.id);
    res.status(201).json({ connection: sanitizeConnectionForClient(saved) });
  });

  app.post('/api/connections/:id/test', requireAuth, async (req: AuthenticatedRequest, res) => {
    const conn = getConnectionById(req.params.id);
    if (!conn || !canAccessConnection(req.user!, conn.id)) {
      res.status(404).json({ error: 'Connexion introuvable.' });
      return;
    }
    try {
      const result = await testConnectionEngine(conn);
      updateConnectionStatus(conn.id, 'connected');
      recordRefreshLog({
        connectionId: conn.id,
        connectionName: conn.name,
        userName: req.user!.name,
        action: 'Test connexion lecture seule',
        durationMs: result.latencyMs,
        status: 'success',
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Échec de connexion au serveur SQL.';
      updateConnectionStatus(conn.id, 'error', msg);
      recordRefreshLog({
        connectionId: conn.id,
        connectionName: conn.name,
        userName: req.user!.name,
        action: 'Test connexion lecture seule',
        durationMs: 0,
        status: 'error',
      });
      res.status(400).json({ ok: false, message: msg });
    }
  });

  app.post('/api/connections/test-draft', requireAuth, requireAdmin, async (req, res) => {
    const body = req.body as {
      engine?: ConnectionEngine;
      agentId?: string;
      host?: string;
      port?: number;
      instanceName?: string;
      database?: string;
      username?: string;
      password?: string;
      encrypt?: boolean;
      trustServerCertificate?: boolean;
      tdsVersion?: '7_2' | '7_3_A' | '7_3_B' | '7_4';
    };
    const engine: ConnectionEngine =
      body.engine === 'sandbox_erp'
        ? 'sandbox_erp'
        : body.engine === 'agent_relay'
        ? 'agent_relay'
        : 'sqlserver2008r2';
    try {
      const result = await testConnectionEngine(
        {
          id: 'draft',
          name: 'Test',
          engine,
          agentId: engine === 'agent_relay' ? body.agentId : undefined,
          host: body.host || 'localhost',
          port: Number(body.port) || 1433,
          instanceName: body.instanceName,
          database: body.database || 'master',
          username: body.username || '',
          hasPassword: Boolean(body.password),
          passwordEncrypted: '',
          encrypt: Boolean(body.encrypt),
          trustServerCertificate: body.trustServerCertificate !== false,
          tdsVersion: body.tdsVersion || '7_3_A',
          readOnlyEnforced: true,
        },
        body.password
      );
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Échec de connexion SQL Server.';
      res.status(400).json({ ok: false, message: msg });
    }
  });

  // --- Windows Local Relay Agents ---
  app.get('/api/agents', requireAuth, requireAdmin, (_req, res) => {
    res.json({ agents: listAgentRecords(isAgentOnline) });
  });

  app.post('/api/agents', requireAuth, requireAdmin, (req, res) => {
    const body = req.body as { name?: string; serverUrl?: string };
    const name = body.name?.trim() || 'Agent PC Windows';
    const { agent, token } = createAgentRecord(name);
    const origin =
      body.serverUrl && /^https?:\/\//i.test(body.serverUrl)
        ? body.serverUrl
        : process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const scriptContent = buildAgentScriptContent(origin, token);
    res.status(201).json({ agent, token, scriptContent });
  });

  app.post('/api/agents/:id/rotate', requireAuth, requireAdmin, (req, res) => {
    const body = req.body as { serverUrl?: string };
    const token = rotateAgentToken(req.params.id);
    if (!token) {
      res.status(404).json({ error: 'Agent introuvable.' });
      return;
    }
    const origin =
      body.serverUrl && /^https?:\/\//i.test(body.serverUrl)
        ? body.serverUrl
        : process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const scriptContent = buildAgentScriptContent(origin, token);
    res.json({ token, scriptContent });
  });

  app.delete('/api/agents/:id', requireAuth, requireAdmin, (req, res) => {
    const ok = deleteAgentRecord(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Agent introuvable.' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/agent/poll', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const agent = token ? verifyAgentBearerToken(token) : null;
    if (!agent) {
      res.status(401).json({ error: 'Jeton agent invalide.' });
      return;
    }
    const hostname = typeof req.query.hostname === 'string' ? req.query.hostname : undefined;
    updateAgentHeartbeat(agent.id, hostname);
    handleAgentPoll(agent.id, res);
  });

  app.post('/api/agent/result', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const agent = token ? verifyAgentBearerToken(token) : null;
    if (!agent) {
      res.status(401).json({ error: 'Jeton agent invalide.' });
      return;
    }
    updateAgentHeartbeat(agent.id);
    const body = req.body as { jobId?: string; ok?: boolean; data?: unknown; errorMessage?: string };
    if (!body.jobId) {
      res.status(400).json({ error: 'jobId manquant.' });
      return;
    }
    submitAgentJobResult(agent.id, body.jobId, Boolean(body.ok), body.data, body.errorMessage);
    res.json({ ok: true });
  });

  app.delete('/api/connections/:id', requireAuth, requireAdmin, (req, res) => {
    if (req.params.id === 'conn-sandbox-erp') {
      res.status(400).json({ error: 'La base de démonstration intégrée ne peut pas être supprimée.' });
      return;
    }
    const existing = getConnectionById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Connexion introuvable.' });
      return;
    }
    const ok = deleteConnection(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Connexion introuvable.' });
      return;
    }
    if (existing.importFileName) {
      removeImportedDbFile(existing.importFileName);
    }
    invalidateSchemaCache(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/connections/:id/schema', requireAuth, async (req: AuthenticatedRequest, res) => {
    const conn = getConnectionById(req.params.id);
    if (!conn || !canAccessConnection(req.user!, conn.id)) {
      res.status(404).json({ error: 'Connexion introuvable ou non autorisée.' });
      return;
    }
    const force = req.query.refresh === '1';
    const started = Date.now();
    try {
      const objects = await introspectSchema(conn, force);
      updateConnectionStatus(conn.id, 'connected');
      recordRefreshLog({
        connectionId: conn.id,
        connectionName: conn.name,
        userName: req.user!.name,
        action: `Détection schéma (${objects.length} tables/vues)`,
        durationMs: Date.now() - started,
        status: 'success',
      });
      res.json({ objects, detectedAt: new Date().toISOString() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Impossible d’analyser le schéma SQL.';
      updateConnectionStatus(conn.id, 'error', msg);
      res.status(400).json({ error: msg });
    }
  });

  // --- Dashboards CRUD ---
  app.get('/api/dashboards', requireAuth, (req: AuthenticatedRequest, res) => {
    const dashboards = listDashboards().filter((d) => canAccessConnection(req.user!, d.connectionId));
    res.json({ dashboards });
  });

  app.post('/api/dashboards', requireAuth, (req: AuthenticatedRequest, res) => {
    if (req.user!.role !== 'admin' && !req.user!.canEditDashboards) {
      res.status(403).json({ error: 'Votre rôle ne permet pas de modifier les tableaux de bord.' });
      return;
    }
    const body = req.body as {
      id?: string;
      name?: string;
      description?: string;
      connectionId?: string;
      widgets?: WidgetConfig[];
    };
    if (!body.name || !body.connectionId || !Array.isArray(body.widgets)) {
      res.status(400).json({ error: 'Nom, connexion et liste de visuels requis.' });
      return;
    }
    if (!canAccessConnection(req.user!, body.connectionId)) {
      res.status(403).json({ error: 'Accès non autorisé à cette source de données.' });
      return;
    }
    const saved = saveDashboard({
      id: body.id,
      name: body.name,
      description: body.description || '',
      connectionId: body.connectionId,
      widgets: body.widgets,
      createdBy: req.user!.name,
    });
    res.json({ dashboard: saved });
  });

  app.delete('/api/dashboards/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    if (req.user!.role !== 'admin' && !req.user!.canEditDashboards) {
      res.status(403).json({ error: 'Suppression réservée aux éditeurs et administrateurs.' });
      return;
    }
    const ok = deleteDashboard(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Tableau de bord introuvable.' });
      return;
    }
    res.json({ ok: true });
  });

  // --- Dynamic Filters & BI Widget Query Execution ---
  app.post('/api/query/filter-options', requireAuth, async (req: AuthenticatedRequest, res) => {
    const body = req.body as {
      connectionId?: string;
      sourceObject?: string;
      dateColumn?: string;
      clientColumn?: string;
      articleColumn?: string;
      companyColumn?: string;
    };
    if (!body.connectionId || !body.sourceObject) {
      res.status(400).json({ error: 'Connexion et objet source requis.' });
      return;
    }
    const conn = getConnectionById(body.connectionId);
    if (!conn || !canAccessConnection(req.user!, conn.id)) {
      res.status(403).json({ error: 'Accès non autorisé à cette connexion.' });
      return;
    }
    try {
      const options = await getFilterOptionsForSource(
        conn,
        body.sourceObject,
        {
          dateColumn: body.dateColumn,
          clientColumn: body.clientColumn,
          articleColumn: body.articleColumn,
          companyColumn: body.companyColumn,
        },
        req.user!.allowedCompanies
      );
      res.json(options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur lors du chargement des filtres.';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/query/dashboard', requireAuth, async (req: AuthenticatedRequest, res) => {
    const body = req.body as {
      connectionId?: string;
      widgets?: WidgetConfig[];
      filters?: DynamicFilters;
      isManualRefresh?: boolean;
    };
    if (!body.connectionId || !Array.isArray(body.widgets)) {
      res.status(400).json({ error: 'Paramètres de requête invalides.' });
      return;
    }
    const conn = getConnectionById(body.connectionId);
    if (!conn || !canAccessConnection(req.user!, conn.id)) {
      res.status(403).json({ error: 'Accès non autorisé à cette connexion.' });
      return;
    }

    const filters: DynamicFilters = {
      dateFrom: body.filters?.dateFrom || '',
      dateTo: body.filters?.dateTo || '',
      client: body.filters?.client || '',
      article: body.filters?.article || '',
      company: body.filters?.company || '',
      search: body.filters?.search || '',
    };

    const started = Date.now();
    try {
      const results = await Promise.all(
        body.widgets.map((widget) => {
          const widgetConn = getConnectionById(widget.connectionId) || conn;
          if (!canAccessConnection(req.user!, widgetConn.id)) {
            throw new Error(`Accès refusé à la connexion ${widgetConn.name}`);
          }
          return executeWidgetQuery(widgetConn, widget, filters, req.user!.allowedCompanies);
        })
      );

      if (body.isManualRefresh) {
        recordRefreshLog({
          connectionId: conn.id,
          connectionName: conn.name,
          userName: req.user!.name,
          action: `Actualisation tableau de bord (${results.length} visuels)`,
          durationMs: Date.now() - started,
          status: 'success',
        });
      }

      res.json({ results, refreshedAt: new Date().toISOString() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur d’exécution BI.';
      res.status(400).json({ error: msg });
    }
  });

  // --- Read-Only SQL Explorer ---
  app.post('/api/query/sql', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (req.user!.role !== 'admin' && !req.user!.canRunSql) {
      res.status(403).json({ error: 'Votre profil n’est pas autorisé à exécuter des requêtes SQL personnalisées.' });
      return;
    }
    if (req.user!.allowedCompanies.length > 0 && req.user!.role !== 'admin') {
      res.status(403).json({
        error: 'L’explorateur SQL libre est désactivé pour les comptes restreints par société afin de préserver l’isolation des données.',
      });
      return;
    }

    const body = req.body as { connectionId?: string; sql?: string; maxRows?: number };
    if (!body.connectionId || !body.sql) {
      res.status(400).json({ error: 'Connexion et requête SQL requises.' });
      return;
    }
    const conn = getConnectionById(body.connectionId);
    if (!conn || !canAccessConnection(req.user!, conn.id)) {
      res.status(403).json({ error: 'Connexion introuvable ou non autorisée.' });
      return;
    }

    try {
      const result = await executeReadOnlyCustomSql(conn, body.sql, body.maxRows || 250);
      recordRefreshLog({
        connectionId: conn.id,
        connectionName: conn.name,
        userName: req.user!.name,
        action: `Requête SQL lecture seule (${result.rowCount} lignes)`,
        durationMs: result.durationMs,
        status: 'success',
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur SQL.';
      const isBlocked = msg.toLowerCase().includes('lecture seule') || msg.toLowerCase().includes('bloquée');
      recordRefreshLog({
        connectionId: conn.id,
        connectionName: conn.name,
        userName: req.user!.name,
        action: isBlocked ? `Tentative bloquée : ${msg}` : `Erreur SQL : ${msg}`,
        durationMs: 0,
        status: isBlocked ? 'blocked' : 'error',
      });
      res.status(400).json({ error: msg, blockedByReadOnly: isBlocked });
    }
  });

  app.get('/api/logs', requireAuth, (req: AuthenticatedRequest, res) => {
    const logs = listRefreshLogs(40);
    if (req.user!.role === 'admin') {
      res.json({ logs });
      return;
    }
    const allowedIds = new Set(req.user!.allowedConnectionIds);
    res.json({ logs: logs.filter((l) => allowedIds.has(l.connectionId)) });
  });

  // --- Vite / Static Assets ---
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Application non compilée.');
      }
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`SQL BI Studio serveur démarré sur http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Échec du démarrage serveur:', err);
  process.exit(1);
});
