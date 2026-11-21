import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  Laptop,
  Lock,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Upload,
} from 'lucide-react';
import { biApi } from '../lib/api';
import type {
  AgentInfo,
  ConnectionEngine,
  SqlConnectionConfig,
  TdsVersion,
} from '../types/bi';

interface ConnectionsViewProps {
  connections: SqlConnectionConfig[];
  activeConnectionId: string;
  isAdmin: boolean;
  onSelectConnection: (id: string) => void;
  onConnectionsChanged: () => Promise<void>;
  onDetectSchema: (id: string) => Promise<void>;
  onImportSuccess?: (connectionId: string, dashboardId?: string) => Promise<void>;
}

function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const WINDOWS_BAT_CONTENT = `@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js est requis. Telechargez-le sur https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules\\mssql (
  echo Installation du pilote SQL Server (mssql)...
  call npm install --no-save mssql
)
echo Demarrage de l'Agent Relais SQL BI Studio...
node sql-bi-agent.mjs
pause
`;

export const ConnectionsView: React.FC<ConnectionsViewProps> = ({
  connections,
  activeConnectionId,
  isAdmin,
  onSelectConnection,
  onConnectionsChanged,
  onDetectSchema,
  onImportSuccess,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImportPanel, setShowImportPanel] = useState(false);

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importName, setImportName] = useState('');
  const [importDesc, setImportDesc] = useState('');
  const [importAutoDashboard, setImportAutoDashboard] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);

  const [engine, setEngine] = useState<ConnectionEngine>('agent_relay');
  const [agentId, setAgentId] = useState<string>('');
  const [name, setName] = useState('');
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState(1433);
  const [instanceName, setInstanceName] = useState('');
  const [database, setDatabase] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tdsVersion, setTdsVersion] = useState<TdsVersion>('7_4');
  const [encrypt, setEncrypt] = useState(true);
  const [trustServerCertificate, setTrustServerCertificate] = useState(true);
  const [description, setDescription] = useState('');

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [newAgentName, setNewAgentName] = useState('PC Windows (desktop-3p076mi)');
  const [agentBundle, setAgentBundle] = useState<{
    agentName: string;
    scriptContent: string;
  } | null>(null);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [testFeedback, setTestFeedback] = useState<{ ok: boolean; message: string; version?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadAgents = async () => {
    if (!isAdmin) return;
    try {
      const res = await biApi.listAgents();
      setAgents(res.agents);
      setAgentId((prev) => (prev && res.agents.some((a) => a.id === prev) ? prev : res.agents[0]?.id || ''));
    } catch {
      // Ignore if non-admin
    }
  };

  useEffect(() => {
    void loadAgents();
    if (!isAdmin) return;
    const timer = window.setInterval(() => {
      void loadAgents();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [isAdmin]);

  const openNewForm = () => {
    setEditingId(null);
    setEngine(agents.length > 0 ? 'agent_relay' : 'sqlserver2008r2');
    setAgentId(agents[0]?.id || '');
    setName('');
    setHost(agents.length > 0 ? 'localhost' : '');
    setPort(1433);
    setInstanceName('');
    setDatabase('');
    setUsername('');
    setPassword('');
    setTdsVersion('7_4');
    setEncrypt(true);
    setTrustServerCertificate(true);
    setDescription('');
    setTestFeedback(null);
    setFormError(null);
    setShowForm(true);
  };

  const openEditForm = (conn: SqlConnectionConfig) => {
    setEditingId(conn.id);
    setEngine(conn.engine === 'agent_relay' ? 'agent_relay' : 'sqlserver2008r2');
    setAgentId(conn.agentId || agents[0]?.id || '');
    setName(conn.name);
    setHost(conn.host);
    setPort(conn.port);
    setInstanceName(conn.instanceName || '');
    setDatabase(conn.database);
    setUsername(conn.username);
    setPassword('');
    setTdsVersion(conn.tdsVersion);
    setEncrypt(conn.encrypt);
    setTrustServerCertificate(conn.trustServerCertificate);
    setDescription(conn.description || '');
    setTestFeedback(null);
    setFormError(null);
    setShowForm(true);
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await biApi.createAgent(newAgentName, window.location.origin);
      setAgentBundle({
        agentName: res.agent.name,
        scriptContent: res.scriptContent,
      });
      await loadAgents();
      setAgentId(res.agent.id);
      setEngine('agent_relay');
    } catch (err) {
      setTestFeedback({
        ok: false,
        message: err instanceof Error ? err.message : 'Impossible de créer l’agent.',
      });
    }
  };

  const handleRotateAgent = async (agent: AgentInfo) => {
    try {
      const res = await biApi.rotateAgent(agent.id, window.location.origin);
      setAgentBundle({
        agentName: agent.name,
        scriptContent: res.scriptContent,
      });
    } catch (err) {
      setTestFeedback({
        ok: false,
        message: err instanceof Error ? err.message : 'Erreur de génération du script.',
      });
    }
  };

  const handleDeleteAgent = async (id: string) => {
    await biApi.deleteAgent(id);
    await loadAgents();
  };

  const handleTestExisting = async (id: string) => {
    setTestingId(id);
    setTestFeedback(null);
    try {
      const res = await biApi.testConnection(id);
      setTestFeedback({
        ok: true,
        message: `${res.message} (${res.latencyMs} ms)`,
        version: res.serverVersion,
      });
      await onConnectionsChanged();
    } catch (err) {
      setTestFeedback({
        ok: false,
        message: err instanceof Error ? err.message : 'Échec du test de connexion.',
      });
      await onConnectionsChanged();
    } finally {
      setTestingId(null);
    }
  };

  const handleTestDraft = async () => {
    setTestingId('draft');
    setTestFeedback(null);
    try {
      const res = await biApi.testDraftConnection({
        engine,
        agentId: engine === 'agent_relay' ? agentId : undefined,
        host,
        port,
        instanceName: instanceName || undefined,
        database,
        username,
        password,
        encrypt,
        trustServerCertificate,
        tdsVersion,
      });
      setTestFeedback({
        ok: true,
        message: `${res.message} (${res.latencyMs} ms)`,
        version: res.serverVersion,
      });
    } catch (err) {
      setTestFeedback({
        ok: false,
        message: err instanceof Error ? err.message : 'Impossible de joindre le serveur SQL Server.',
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await biApi.saveConnection({
        id: editingId || undefined,
        name,
        engine,
        agentId: engine === 'agent_relay' ? agentId : undefined,
        host,
        port,
        instanceName: instanceName || undefined,
        database,
        username,
        password: password || undefined,
        encrypt,
        trustServerCertificate,
        tdsVersion,
        description,
      });
      await onConnectionsChanged();
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Erreur d’enregistrement.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await biApi.deleteConnection(id);
      await onConnectionsChanged();
    } catch (err) {
      setTestFeedback({
        ok: false,
        message: err instanceof Error ? err.message : 'Suppression impossible.',
      });
    }
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importFile) {
      setImportError('Veuillez sélectionner un fichier .sql, .db, .sqlite, .csv ou .xlsx.');
      return;
    }
    if (importFile.size > 25 * 1024 * 1024) {
      setImportError('Le fichier dépasse la limite de 25 Mo.');
      return;
    }

    setImporting(true);
    setImportError(null);
    setImportWarnings([]);

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Impossible de lire le fichier sélectionné.'));
        reader.readAsDataURL(importFile);
      });

      const res = await biApi.importDatabase({
        name: importName.trim() || undefined,
        originalFileName: importFile.name,
        contentBase64: dataUrl,
        description: importDesc.trim() || undefined,
        autoCreateDashboard: importAutoDashboard,
      });

      setImportWarnings(res.summary.warnings || []);
      setTestFeedback({
        ok: true,
        message: `Base « ${res.connection.name} » importée (${res.summary.tablesCreated} table(s), ${res.summary.viewsCreated} vue(s), ${res.summary.rowsInserted} ligne(s)).`,
      });
      setShowImportPanel(false);
      setImportFile(null);
      setImportName('');
      setImportDesc('');

      if (onImportSuccess) {
        await onImportSuccess(res.connection.id, res.dashboard?.id);
      } else {
        await onConnectionsChanged();
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Erreur lors de l’importation de la base.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
            Connexions SQL Server (2008 R2 à 2022) & Sources de données
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Connectez vos bases ERP locales ou distantes via Agent Relais Windows ou connexion TCP directe, toujours en lecture seule.
          </p>
        </div>

        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setShowImportPanel((v) => !v);
                setShowForm(false);
                setImportError(null);
              }}
              className="px-3.5 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-100 text-xs font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400" />
              <span>Importer une base (.sql / .db / .xlsx)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowImportPanel(false);
                openNewForm();
              }}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nouvelle base SQL Server</span>
            </button>
          </div>
        )}
      </div>

      {testFeedback && (
        <div
          className={`p-4 rounded-xl border text-xs flex items-start gap-2.5 ${
            testFeedback.ok
              ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-900 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200'
          }`}
        >
          {testFeedback.ok ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-700 dark:text-emerald-400" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-700 dark:text-red-400" />
          )}
          <div>
            <p className="font-semibold">{testFeedback.message}</p>
            {testFeedback.version && (
              <p className="mt-1 font-mono text-[11px] opacity-85">{testFeedback.version}</p>
            )}
            {importWarnings.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[11px] list-disc pl-4 opacity-90">
                {importWarnings.map((w, i) => (
                  <li key={i} className="font-mono break-all">
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Database File Import Panel */}
      {showImportPanel && isAdmin && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Upload className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                <span>Importer une base SQL ou un fichier de données</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Chargez un script SQL exporté (<code className="font-mono">.sql</code>), une base SQLite (<code className="font-mono">.db</code> / <code className="font-mono">.sqlite</code>) ou un classeur (<code className="font-mono">.xlsx</code> / <code className="font-mono">.csv</code>) jusqu’à 25 Mo. Les données importées sont stockées localement et interrogées en lecture seule stricte.
              </p>
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            <span className="font-semibold text-slate-800 dark:text-slate-100">Astuce SQL Server (SSMS 2008 R2 / 2022) : </span>
            Clic droit sur votre base → <span className="font-medium">Tâches</span> → <span className="font-medium">Générer des scripts</span> → <span className="font-medium">Avancé</span> → réglez <em>Types de données à inclure dans le script</em> sur <span className="font-medium">« Schéma et données »</span>, puis importez le fichier <code className="font-mono">.sql</code> généré ici.
          </div>

          <form onSubmit={handleImportSubmit} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Fichier source (.sql, .db, .sqlite, .xlsx, .csv)
                </label>
                <input
                  type="file"
                  accept=".sql,.txt,.ddl,.db,.sqlite,.sqlite3,.csv,.xlsx,.xls"
                  required
                  onChange={(e) => {
                    const file = e.target.files?.[0] || null;
                    setImportFile(file);
                    setImportError(null);
                    if (file && !importName.trim()) {
                      const clean = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
                      setImportName(clean);
                    }
                  }}
                  className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-slate-100 dark:file:bg-slate-800 file:text-slate-700 dark:file:text-slate-200 cursor-pointer"
                />
                {importFile && (
                  <p className="mt-1 text-[11px] font-mono text-slate-500">
                    {importFile.name} ({(importFile.size / 1024).toFixed(1)} Ko)
                  </p>
                )}
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Nom de la source dans SQL BI Studio
                </label>
                <input
                  type="text"
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder="Ex. Gestion Commerciale 2026"
                  className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Description (optionnel)
                </label>
                <input
                  type="text"
                  value={importDesc}
                  onChange={(e) => setImportDesc(e.target.value)}
                  placeholder="Ex. Export SSMS du 21/11/2026"
                  className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={importAutoDashboard}
                onChange={(e) => setImportAutoDashboard(e.target.checked)}
                className="rounded border-slate-300"
              />
              <span>Générer automatiquement un tableau de bord BI initial à partir des tables détectées</span>
            </label>

            {importError && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300">
                {importError}
              </div>
            )}

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowImportPanel(false)}
                className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                disabled={importing || !importFile}
                className="px-4 py-2 bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{importing ? 'Importation et analyse...' : 'Importer et analyser'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Existing Connections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {connections.map((conn) => {
          const isActive = conn.id === activeConnectionId;
          const linkedAgent = conn.agentId ? agents.find((a) => a.id === conn.agentId) : undefined;
          return (
            <div
              key={conn.id}
              className={`bg-white dark:bg-slate-900 border rounded-xl p-5 flex flex-col justify-between gap-4 ${
                isActive
                  ? 'border-blue-600 dark:border-blue-500'
                  : 'border-slate-200 dark:border-slate-800'
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1 flex-wrap">
                      <Server className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {conn.engine === 'sandbox_erp'
                          ? 'Modèle ERP local'
                          : conn.engine === 'imported_sqlite'
                          ? 'Base SQL importée'
                          : conn.engine === 'agent_relay'
                          ? `Agent Relais Windows (${conn.tdsVersion === '7_4' ? 'SQL 2012–2022' : 'SQL 2008 R2'})`
                          : conn.tdsVersion === '7_4'
                          ? 'SQL Server 2012–2022 (TDS 7.4)'
                          : `SQL Server 2008 R2 (TDS ${conn.tdsVersion})`}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                        <Lock className="w-3 h-3" />
                        Lecture seule
                      </span>
                    </div>
                    <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white truncate">
                      {conn.name}
                    </h3>
                  </div>

                  {conn.lastStatus === 'connected' ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 shrink-0">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Connectée
                    </span>
                  ) : conn.lastStatus === 'error' ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400 shrink-0">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Erreur
                    </span>
                  ) : (
                    <span className="text-xs text-slate-500 shrink-0">Non testée</span>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600 dark:text-slate-300 font-mono">
                  <div className="truncate">
                    <span className="text-slate-400 font-sans">
                      {conn.engine === 'imported_sqlite' ? 'Origine : ' : 'Hôte : '}
                    </span>
                    {conn.engine === 'imported_sqlite'
                      ? 'Fichier importé'
                      : `${conn.host}${conn.instanceName ? `\\${conn.instanceName}` : `:${conn.port}`}`}
                  </div>
                  <div className="truncate">
                    <span className="text-slate-400 font-sans">
                      {conn.engine === 'imported_sqlite' ? 'Fichier : ' : 'Base : '}
                    </span>
                    {conn.database}
                  </div>
                </div>

                {linkedAgent && (
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    Relais : {linkedAgent.name} —{' '}
                    <span className={linkedAgent.online ? 'text-emerald-700 dark:text-emerald-400 font-medium' : 'text-amber-700 dark:text-amber-400 font-medium'}>
                      {linkedAgent.online ? `En ligne (${linkedAgent.hostname || 'connecté'})` : 'Hors ligne'}
                    </span>
                  </p>
                )}

                {conn.description && (
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    {conn.description}
                  </p>
                )}

                {conn.lastError && conn.lastStatus === 'error' && (
                  <p className="mt-2 text-xs text-red-700 dark:text-red-400 font-mono break-all">
                    {conn.lastError}
                  </p>
                )}
              </div>

              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectConnection(conn.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer transition-colors ${
                      isActive
                        ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700'
                    }`}
                  >
                    {isActive ? 'Source active' : 'Utiliser cette base'}
                  </button>

                  <button
                    type="button"
                    onClick={() => handleTestExisting(conn.id)}
                    disabled={testingId === conn.id}
                    className="px-3 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${testingId === conn.id ? 'animate-spin' : ''}`} />
                    <span>Tester</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onDetectSchema(conn.id)}
                    className="px-3 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Database className="w-3.5 h-3.5" />
                    <span>Détecter tables/vues</span>
                  </button>
                </div>

                {isAdmin && conn.id !== 'conn-sandbox-erp' && (
                  <div className="flex items-center gap-2">
                    {conn.engine !== 'imported_sqlite' && (
                      <button
                        type="button"
                        onClick={() => openEditForm(conn)}
                        className="text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white px-2 py-1 cursor-pointer"
                      >
                        Modifier
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDelete(conn.id)}
                      className="p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-md cursor-pointer"
                      aria-label="Supprimer la connexion"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add / Edit Connection Form */}
      {showForm && isAdmin && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
          <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white mb-1">
            {editingId ? 'Modifier la connexion SQL Server' : 'Configurer une connexion SQL Server (2008 R2 à 2022)'}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-5">
            Pour un poste Windows local derrière une box/pare-feu, utilisez le mode <strong>Agent Relais Local</strong>. Pour un serveur public ou tunnel TCP, choisissez <strong>Connexion directe TCP</strong>.
          </p>

          <form onSubmit={handleSave} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setEngine('agent_relay');
                  if (!host) setHost('localhost');
                }}
                className={`p-3 rounded-lg border text-left cursor-pointer transition-colors ${
                  engine === 'agent_relay'
                    ? 'border-blue-700 bg-blue-50/70 dark:bg-blue-950/30 text-slate-900 dark:text-white'
                    : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                }`}
              >
                <p className="font-semibold">Agent Relais Local (PC Windows / LAN)</p>
                <p className="text-[11px] opacity-80 mt-0.5">
                  Recommandé si SQL Server tourne sur votre poste (ex. desktop-3p076mi). Aucun port à ouvrir sur la box.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setEngine('sqlserver2008r2')}
                className={`p-3 rounded-lg border text-left cursor-pointer transition-colors ${
                  engine === 'sqlserver2008r2'
                    ? 'border-blue-700 bg-blue-50/70 dark:bg-blue-950/30 text-slate-900 dark:text-white'
                    : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                }`}
              >
                <p className="font-semibold">Connexion directe TCP (IP / DNS / Tunnel)</p>
                <p className="text-[11px] opacity-80 mt-0.5">
                  Pour une IP publique, un VPN, un tunnel TCP (ngrok) ou une exécution locale de SQL BI Studio.
                </p>
              </button>
            </div>

            {engine === 'agent_relay' && (
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Agent Relais Windows cible
                </label>
                {agents.length === 0 ? (
                  <p className="text-amber-700 dark:text-amber-400">
                    Créez d’abord un Agent Relais dans la section ci-dessous (« Agent Relais pour PC Windows local »).
                  </p>
                ) : (
                  <select
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    required
                    className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.online ? `En ligne · ${a.hostname || 'prêt'}` : 'Hors ligne'})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Nom de la connexion
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex. Gestion Commerciale PC"
                  className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {engine === 'agent_relay' ? 'Serveur vu depuis le PC Windows' : 'Serveur / Adresse IP'}
                </label>
                <input
                  type="text"
                  required
                  value={host}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw.includes('\\')) {
                      const [h, inst] = raw.split('\\');
                      setHost(h.trim());
                      if (inst) setInstanceName(inst.trim());
                    } else if (raw.includes(',')) {
                      const [h, p] = raw.split(',');
                      setHost(h.trim());
                      const parsedPort = Number(p?.trim());
                      if (parsedPort > 0 && parsedPort <= 65535) setPort(parsedPort);
                    } else {
                      setHost(raw);
                    }
                  }}
                  placeholder={engine === 'agent_relay' ? 'localhost ou desktop-3p076mi' : '0.tcp.eu.ngrok.io ou IP'}
                  className="w-full px-3 py-2 font-mono bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Port TCP
                  </label>
                  <input
                    type="number"
                    required
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value) || 1433)}
                    className="w-full px-3 py-2 font-mono bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Instance (opt.)
                  </label>
                  <input
                    type="text"
                    value={instanceName}
                    onChange={(e) => setInstanceName(e.target.value)}
                    placeholder="SQLEXPRESS"
                    className="w-full px-3 py-2 font-mono bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Base de données
                </label>
                <input
                  type="text"
                  required
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  placeholder="Ex. BIJOU_PROD"
                  className="w-full px-3 py-2 font-mono bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Utilisateur SQL
                </label>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="sa ou bi_readonly"
                  className="w-full px-3 py-2 font-mono bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Mot de passe {editingId ? '(laisser vide pour conserver)' : ''}
                </label>
                <input
                  type="password"
                  required={!editingId}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Version SQL Server / Protocole TDS
                </label>
                <select
                  value={tdsVersion}
                  onChange={(e) => {
                    const nextTds = e.target.value as TdsVersion;
                    setTdsVersion(nextTds);
                    if (nextTds === '7_4') {
                      setEncrypt(true);
                      setTrustServerCertificate(true);
                    } else {
                      setEncrypt(false);
                      setTrustServerCertificate(true);
                    }
                  }}
                  className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                >
                  <option value="7_4">TDS 7.4 — SQL Server 2012 à 2022 (Recommandé SQL 2022)</option>
                  <option value="7_3_A">TDS 7.3A — SQL Server 2008 / 2008 R2</option>
                  <option value="7_3_B">TDS 7.3B — SQL Server 2008 R2 SP2+</option>
                  <option value="7_2">TDS 7.2 — SQL Server 2005 / 2008</option>
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Description / Notes d’exploitation
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Ex. Serveur de gestion commerciale principal (lecture seule)"
                  className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-6 pt-1">
              <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={encrypt}
                  onChange={(e) => setEncrypt(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>Chiffrement TLS/SSL (activé sur SQL Server 2022, désactivé sur 2008 R2)</span>
              </label>
              <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={trustServerCertificate}
                  onChange={(e) => setTrustServerCertificate(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>Accepter le certificat auto-signé du serveur</span>
              </label>
            </div>

            {formError && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300">
                {formError}
              </div>
            )}

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleTestDraft}
                disabled={testingId === 'draft' || !host || !database || (engine === 'agent_relay' && !agentId)}
                className="px-3.5 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${testingId === 'draft' ? 'animate-spin' : ''}`} />
                <span>Tester la connexion avant enregistrement</span>
              </button>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={saving || (engine === 'agent_relay' && !agentId)}
                  className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white font-medium rounded-lg cursor-pointer disabled:opacity-60"
                >
                  {saving ? 'Enregistrement...' : 'Enregistrer la connexion'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Windows Local Agent Relay Manager */}
      {isAdmin && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Laptop className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                <span>Agent Relais pour PC Windows local (desktop-3p076mi)</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                L’agent s’exécute sur votre poste Windows et établit une connexion sortante sécurisée pour relayer les requêtes SELECT vers votre SQL Server local (2008 R2 ou 2022).
              </p>
            </div>

            <form onSubmit={handleCreateAgent} className="flex items-center gap-2 shrink-0">
              <input
                type="text"
                required
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                placeholder="Nom du poste Windows"
                className="px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
              />
              <button
                type="submit"
                className="px-3.5 py-1.5 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium rounded-lg whitespace-nowrap cursor-pointer"
              >
                Créer un agent
              </button>
            </form>
          </div>

          {agentBundle && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3 text-xs">
              <p className="font-semibold text-slate-900 dark:text-white">
                Fichiers prêts pour « {agentBundle.agentName} » :
              </p>
              <p className="text-slate-600 dark:text-slate-300">
                1. Placez les deux fichiers ci-dessous dans un même dossier sur votre poste Windows (ex. <code className="font-mono">C:\SQL-BI-Agent</code>).
                <br />
                2. Double-cliquez sur <code className="font-mono">demarrer-agent.bat</code> (Node.js requis). L’agent apparaîtra immédiatement « En ligne ».
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => downloadTextFile('sql-bi-agent.mjs', agentBundle.scriptContent)}
                  className="px-3.5 py-2 bg-blue-700 hover:bg-blue-800 text-white font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Télécharger sql-bi-agent.mjs</span>
                </button>
                <button
                  type="button"
                  onClick={() => downloadTextFile('demarrer-agent.bat', WINDOWS_BAT_CONTENT)}
                  className="px-3.5 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Télécharger demarrer-agent.bat</span>
                </button>
              </div>
              {window.location.hostname.startsWith('ais-dev-') && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  Remarque : l’URL de développement (<code className="font-mono">ais-dev-*</code>) est protégée par votre session Google. Pour un agent externe, utilisez l’URL partagée/déployée ou exécutez directement SQL BI Studio en local sur Windows (<code className="font-mono">npm run start</code>).
                </p>
              )}
            </div>
          )}

          {agents.length > 0 && (
            <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300">
                    <th className="py-2 px-3 font-semibold">Nom de l’agent</th>
                    <th className="py-2 px-3 font-semibold">Poste détecté</th>
                    <th className="py-2 px-3 font-semibold">Statut</th>
                    <th className="py-2 px-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {agents.map((a) => (
                    <tr key={a.id}>
                      <td className="py-2.5 px-3 font-medium text-slate-900 dark:text-white">{a.name}</td>
                      <td className="py-2.5 px-3 font-mono text-slate-500">{a.hostname || '—'}</td>
                      <td className="py-2.5 px-3">
                        {a.online ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            En ligne
                          </span>
                        ) : (
                          <span className="text-slate-500">Hors ligne</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right space-x-2">
                        <button
                          type="button"
                          onClick={() => handleRotateAgent(a)}
                          className="text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                        >
                          Télécharger script
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteAgent(a.id)}
                          className="text-red-600 hover:underline cursor-pointer"
                        >
                          Supprimer
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
