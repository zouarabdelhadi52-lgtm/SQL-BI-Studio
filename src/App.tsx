import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Eye,
  FileSpreadsheet,
  Filter,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sun,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { AuthView } from './components/AuthView';
import {
  BarChartVisual,
  DataTableVisual,
  DonutChartVisual,
  LineAreaChartVisual,
} from './components/Charts';
import { ConnectionsView } from './components/ConnectionsView';
import { SqlExplorerView } from './components/SqlExplorerView';
import { UsersAccessView } from './components/UsersAccessView';
import { WidgetBuilderModal } from './components/WidgetBuilderModal';
import { biApi, setAuthToken } from './lib/api';
import {
  exportDashboardToExcel,
  exportDashboardToPdf,
  formatNumericValue,
} from './lib/export';
import type {
  DashboardConfig,
  DynamicFilters,
  FilterOptionsPayload,
  SchemaObject,
  SqlConnectionConfig,
  UserProfile,
  WidgetConfig,
  WidgetQueryResult,
} from './types/bi';

type ActiveSection = 'dashboards' | 'explorer' | 'connections' | 'users';

const EMPTY_FILTERS: DynamicFilters = {
  dateFrom: '',
  dateTo: '',
  client: '',
  article: '',
  company: '',
  search: '',
};

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasEnvAdminOverride, setHasEnvAdminOverride] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);

  const [darkMode, setDarkMode] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<ActiveSection>('dashboards');

  const [connections, setConnections] = useState<SqlConnectionConfig[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string>('conn-sandbox-erp');
  const [schema, setSchema] = useState<SchemaObject[]>([]);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaSearch, setSchemaSearch] = useState('');
  const [expandedObjects, setExpandedObjects] = useState<Record<string, boolean>>({});

  const [dashboards, setDashboards] = useState<DashboardConfig[]>([]);
  const [activeDashboardId, setActiveDashboardId] = useState<string>('');
  const [editMode, setEditMode] = useState(false);

  const [filters, setFilters] = useState<DynamicFilters>(EMPTY_FILTERS);
  const [filterOptions, setFilterOptions] = useState<FilterOptionsPayload>({
    clients: [],
    articles: [],
    companies: [],
    minDate: '',
    maxDate: '',
  });

  const [resultsMap, setResultsMap] = useState<Record<string, WidgetQueryResult>>({});
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string>('');
  const [autoRefreshSec, setAutoRefreshSec] = useState<number>(0);

  const [widgetModalOpen, setWidgetModalOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState<WidgetConfig | null>(null);

  const [newDashModalOpen, setNewDashModalOpen] = useState(false);
  const [newDashName, setNewDashName] = useState('');
  const [newDashDesc, setNewDashDesc] = useState('');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  useEffect(() => {
    biApi
      .getAuthStatus()
      .then((res) => {
        setNeedsSetup(res.needsSetup);
        setHasEnvAdminOverride(res.hasEnvAdminOverride);
      })
      .catch(() => {
        setNeedsSetup(false);
      })
      .finally(() => setAuthChecking(false));
  }, []);

  const loadWorkspace = useCallback(async () => {
    const [connRes, dashRes] = await Promise.all([biApi.listConnections(), biApi.listDashboards()]);
    setConnections(connRes.connections);
    setDashboards(dashRes.dashboards);

    const firstConnId = connRes.connections[0]?.id || '';
    setActiveConnectionId((prev) =>
      connRes.connections.some((c) => c.id === prev) ? prev : firstConnId
    );
    setActiveDashboardId((prev) =>
      dashRes.dashboards.some((d) => d.id === prev) ? prev : dashRes.dashboards[0]?.id || ''
    );
  }, []);

  const handleAuthenticated = async (token: string, user: UserProfile) => {
    setAuthToken(token);
    setCurrentUser(user);
    setNeedsSetup(false);
    await loadWorkspace();
  };

  const handleLogout = () => {
    setAuthToken(null);
    setCurrentUser(null);
    setResultsMap({});
    setSchema([]);
    setDashboards([]);
    setConnections([]);
  };

  const activeConnection = useMemo(
    () => connections.find((c) => c.id === activeConnectionId) || null,
    [connections, activeConnectionId]
  );

  const activeDashboard = useMemo(
    () => dashboards.find((d) => d.id === activeDashboardId) || null,
    [dashboards, activeDashboardId]
  );

  const loadSchema = useCallback(async (connId: string, forceRefresh = false) => {
    if (!connId) return;
    setSchemaLoading(true);
    try {
      const res = await biApi.getSchema(connId, forceRefresh);
      setSchema(res.objects);
    } catch (err) {
      setSchema([]);
      setQueryError(err instanceof Error ? err.message : 'Erreur de détection du schéma SQL.');
    } finally {
      setSchemaLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentUser && activeConnectionId) {
      void loadSchema(activeConnectionId, false);
    }
  }, [currentUser, activeConnectionId, loadSchema]);

  // Load dynamic filter dropdown values from the primary object of the active dashboard or first view/table
  useEffect(() => {
    if (!currentUser || !activeConnectionId || schema.length === 0) return;

    const refWidget =
      activeDashboard?.widgets.find(
        (w) => w.clientColumn || w.articleColumn || w.companyColumn || w.dateColumn
      ) || activeDashboard?.widgets[0];

    const fallbackObj = schema.find((s) => s.type === 'VIEW') || schema[0];
    const targetSource = refWidget?.sourceObject || fallbackObj?.fullName;
    if (!targetSource) return;

    const schemaObj = schema.find((s) => s.fullName === targetSource) || fallbackObj;
    const cols = schemaObj?.columns.map((c) => c.name) || [];

    const guessCol = (explicit: string | undefined, candidates: string[]) => {
      if (explicit && cols.includes(explicit)) return explicit;
      return cols.find((c) => candidates.some((cand) => c.toUpperCase().includes(cand)));
    };

    biApi
      .getFilterOptions({
        connectionId: activeConnectionId,
        sourceObject: targetSource,
        dateColumn: guessCol(refWidget?.dateColumn, ['DATE']),
        clientColumn: guessCol(refWidget?.clientColumn, ['CLIENT', 'NOM_CLIENT']),
        articleColumn: guessCol(refWidget?.articleColumn, ['ARTICLE', 'DESIGNATION']),
        companyColumn: guessCol(refWidget?.companyColumn, ['SOCIETE', 'RAISON_SOCIALE']),
      })
      .then((opts) => setFilterOptions(opts))
      .catch(() => undefined);
  }, [currentUser, activeConnectionId, activeDashboard, schema]);

  const executeDashboardQueries = useCallback(
    async (isManual = false) => {
      if (!currentUser || !activeDashboard) return;
      setQueryLoading(true);
      setQueryError(null);
      try {
        const res = await biApi.queryDashboard({
          connectionId: activeDashboard.connectionId,
          widgets: activeDashboard.widgets,
          filters,
          isManualRefresh: isManual,
        });
        const map: Record<string, WidgetQueryResult> = {};
        for (const r of res.results) {
          map[r.widgetId] = r;
        }
        setResultsMap(map);
        setLastRefreshedAt(res.refreshedAt);
      } catch (err) {
        setQueryError(err instanceof Error ? err.message : 'Erreur lors du chargement des données.');
      } finally {
        setQueryLoading(false);
      }
    },
    [currentUser, activeDashboard, filters]
  );

  useEffect(() => {
    if (currentUser && activeDashboard && activeSection === 'dashboards') {
      void executeDashboardQueries(false);
    }
  }, [currentUser, activeDashboard, activeSection, executeDashboardQueries]);

  useEffect(() => {
    if (!autoRefreshSec || activeSection !== 'dashboards' || !activeDashboard) return;
    const timer = window.setInterval(() => {
      void executeDashboardQueries(false);
    }, autoRefreshSec * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefreshSec, activeSection, activeDashboard, executeDashboardQueries]);

  const handleSaveWidget = async (widget: WidgetConfig) => {
    if (!activeDashboard) return;
    const exists = activeDashboard.widgets.some((w) => w.id === widget.id);
    const updatedWidgets = exists
      ? activeDashboard.widgets.map((w) => (w.id === widget.id ? widget : w))
      : [...activeDashboard.widgets, widget];

    const res = await biApi.saveDashboard({
      id: activeDashboard.id,
      name: activeDashboard.name,
      description: activeDashboard.description,
      connectionId: activeDashboard.connectionId,
      widgets: updatedWidgets,
    });
    setDashboards((prev) => prev.map((d) => (d.id === res.dashboard.id ? res.dashboard : d)));
    setWidgetModalOpen(false);
    setEditingWidget(null);
  };

  const handleDeleteWidget = async (widgetId: string) => {
    if (!activeDashboard) return;
    const updatedWidgets = activeDashboard.widgets.filter((w) => w.id !== widgetId);
    const res = await biApi.saveDashboard({
      id: activeDashboard.id,
      name: activeDashboard.name,
      description: activeDashboard.description,
      connectionId: activeDashboard.connectionId,
      widgets: updatedWidgets,
    });
    setDashboards((prev) => prev.map((d) => (d.id === res.dashboard.id ? res.dashboard : d)));
  };

  const handleCreateDashboard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDashName.trim() || !activeConnectionId) return;
    const res = await biApi.saveDashboard({
      name: newDashName,
      description: newDashDesc || 'Tableau de bord personnalisé',
      connectionId: activeConnectionId,
      widgets: [],
    });
    setDashboards((prev) => [res.dashboard, ...prev]);
    setActiveDashboardId(res.dashboard.id);
    setNewDashModalOpen(false);
    setNewDashName('');
    setNewDashDesc('');
    setEditMode(true);
    setActiveSection('dashboards');
  };

  const handleCrossFilter = (widget: WidgetConfig, label: string) => {
    const dim = (widget.dimensionColumn || '').toUpperCase();
    if (dim.includes('CLIENT')) {
      setFilters((f) => ({ ...f, client: f.client === label ? '' : label }));
    } else if (dim.includes('ARTICLE')) {
      setFilters((f) => ({ ...f, article: f.article === label ? '' : label }));
    } else if (dim.includes('SOCIETE')) {
      setFilters((f) => ({ ...f, company: f.company === label ? '' : label }));
    }
  };

  const getActiveCrossLabel = (widget: WidgetConfig): string | undefined => {
    const dim = (widget.dimensionColumn || '').toUpperCase();
    if (dim.includes('CLIENT') && filters.client) return filters.client;
    if (dim.includes('ARTICLE') && filters.article) return filters.article;
    if (dim.includes('SOCIETE') && filters.company) return filters.company;
    return undefined;
  };

  const applyDatePreset = (preset: 'all' | '90d' | '2026') => {
    if (preset === 'all') {
      setFilters((f) => ({ ...f, dateFrom: '', dateTo: '' }));
    } else if (preset === '2026') {
      setFilters((f) => ({ ...f, dateFrom: '2026-01-01', dateTo: '2026-12-31' }));
    } else if (preset === '90d') {
      const endStr = filterOptions.maxDate || new Date().toISOString().slice(0, 10);
      const endDate = new Date(endStr);
      const startDate = new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);
      setFilters((f) => ({
        ...f,
        dateFrom: startDate.toISOString().slice(0, 10),
        dateTo: endStr,
      }));
    }
  };

  const filteredSchema = useMemo(() => {
    const q = schemaSearch.trim().toLowerCase();
    if (!q) return schema;
    return schema.filter(
      (obj) =>
        obj.name.toLowerCase().includes(q) ||
        obj.columns.some((c) => c.name.toLowerCase().includes(q))
    );
  }, [schema, schemaSearch]);

  const detectedViews = useMemo(() => filteredSchema.filter((s) => s.type === 'VIEW'), [filteredSchema]);
  const detectedTables = useMemo(() => filteredSchema.filter((s) => s.type === 'TABLE'), [filteredSchema]);

  const hasActiveFilters = Boolean(
    filters.dateFrom || filters.dateTo || filters.client || filters.article || filters.company || filters.search
  );

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-sm text-slate-500">
        Initialisation de SQL BI Studio...
      </div>
    );
  }

  if (!currentUser) {
    return (
      <AuthView
        needsSetup={needsSetup}
        hasEnvAdminOverride={hasEnvAdminOverride}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  const canEdit = currentUser.role === 'admin' || currentUser.canEditDashboards;
  const canExport = currentUser.role === 'admin' || currentUser.canExport;
  const canRunSql = currentUser.role === 'admin' || currentUser.canRunSql;

  const kpiWidgets = activeDashboard?.widgets.filter((w) => w.type === 'kpi') || [];
  const visualWidgets = activeDashboard?.widgets.filter((w) => w.type !== 'kpi') || [];

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="h-14 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 lg:px-6 flex items-center justify-between gap-8 sticky top-0 z-30">
        {/* Zone 1: Single-line Brand Wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setMobileSidebarOpen((v) => !v)}
            className="lg:hidden p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            aria-label="Ouvrir le panneau latéral"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0">
            SQL BI Studio
          </span>
        </div>

        {/* Zone 2: Concise single-line navigation links */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium">
          {(
            [
              { id: 'dashboards', label: 'Tableaux de bord' },
              { id: 'explorer', label: 'Explorateur SQL' },
              { id: 'connections', label: 'Connexions' },
              ...(currentUser.role === 'admin' ? [{ id: 'users', label: 'Utilisateurs' }] : []),
            ] as { id: ActiveSection; label: string }[]
          ).map((nav) => {
            const active = activeSection === nav.id;
            return (
              <button
                key={nav.id}
                type="button"
                onClick={() => setActiveSection(nav.id)}
                className={`py-4 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-400'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {nav.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={() => {
              if (activeSection === 'dashboards') {
                void executeDashboardQueries(true);
              } else if (activeConnectionId) {
                void loadSchema(activeConnectionId, true);
              }
            }}
            disabled={queryLoading || schemaLoading}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${queryLoading || schemaLoading ? 'animate-spin' : ''}`} />
            <span>Actualiser</span>
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Mobile navigation strip */}
        {mobileSidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-slate-950/50 lg:hidden"
            onClick={() => setMobileSidebarOpen(false)}
          />
        )}

        {/* Sidebar (272px): Source selector, Dashboards, Auto-detected Tables & Views, User Footer */}
        <aside
          className={`${
            mobileSidebarOpen ? 'fixed inset-y-0 left-0 z-50 flex' : 'hidden'
          } lg:flex w-72 shrink-0 flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800`}
        >
          {/* Mobile Section Switcher inside drawer */}
          <div className="md:hidden p-3 border-b border-slate-200 dark:border-slate-800 grid grid-cols-2 gap-1.5 text-xs">
            {(
              [
                { id: 'dashboards', label: 'Tableaux' },
                { id: 'explorer', label: 'SQL' },
                { id: 'connections', label: 'Connexions' },
                ...(currentUser.role === 'admin' ? [{ id: 'users', label: 'Accès' }] : []),
              ] as { id: ActiveSection; label: string }[]
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveSection(item.id);
                  setMobileSidebarOpen(false);
                }}
                className={`py-1.5 px-2 rounded-md font-medium text-center cursor-pointer ${
                  activeSection === item.id
                    ? 'bg-blue-700 text-white'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Active Database Connection Selector */}
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-2">
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
              Base SQL Server active
            </label>
            <select
              value={activeConnectionId}
              onChange={(e) => {
                setActiveConnectionId(e.target.value);
                setFilters(EMPTY_FILTERS);
              }}
              className="w-full px-2.5 py-2 text-xs font-medium bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
              <Lock className="w-3 h-3 shrink-0" />
              <span>Mode lecture seule protégé</span>
            </div>
          </div>

          {/* Dashboards List */}
          <div className="p-4 border-b border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Tableaux de bord
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => setNewDashModalOpen(true)}
                  className="text-xs text-blue-700 dark:text-blue-400 hover:underline inline-flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Créer</span>
                </button>
              )}
            </div>
            <div className="space-y-1">
              {dashboards.map((d) => {
                const isSelected = d.id === activeDashboardId && activeSection === 'dashboards';
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      setActiveDashboardId(d.id);
                      if (d.connectionId !== activeConnectionId) {
                        setActiveConnectionId(d.connectionId);
                      }
                      setActiveSection('dashboards');
                      setMobileSidebarOpen(false);
                    }}
                    className={`w-full text-left px-2.5 py-2 rounded-lg text-xs flex items-center gap-2 transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-800 dark:text-blue-300 font-medium'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    <LayoutDashboard className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{d.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Auto-detected Tables & Views Tree */}
          <div className="flex-1 min-h-0 flex flex-col p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Tables & Vues détectées
              </span>
              <button
                type="button"
                onClick={() => activeConnectionId && void loadSchema(activeConnectionId, true)}
                className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded cursor-pointer"
                title="Réanalyser le schéma SQL"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${schemaLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="relative mb-3">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={schemaSearch}
                onChange={(e) => setSchemaSearch(e.target.value)}
                placeholder="Filtrer tables ou colonnes..."
                className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-1 text-xs">
              {schemaLoading && schema.length === 0 ? (
                <p className="text-slate-400 py-4 text-center">Inspection du schéma...</p>
              ) : (
                <>
                  {detectedViews.length > 0 && (
                    <div>
                      <p className="text-[11px] font-medium text-slate-400 mb-1">
                        Vues ({detectedViews.length})
                      </p>
                      <div className="space-y-0.5">
                        {detectedViews.map((obj) => {
                          const open = Boolean(expandedObjects[obj.fullName]);
                          return (
                            <div key={obj.fullName}>
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedObjects((prev) => ({
                                    ...prev,
                                    [obj.fullName]: !prev[obj.fullName],
                                  }))
                                }
                                className="w-full flex items-center justify-between py-1.5 px-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800/60 text-left cursor-pointer"
                              >
                                <span className="flex items-center gap-1.5 min-w-0">
                                  {open ? (
                                    <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
                                  ) : (
                                    <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />
                                  )}
                                  <Eye className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                                  <span className="truncate font-mono text-[11px] text-slate-800 dark:text-slate-200">
                                    {obj.name}
                                  </span>
                                </span>
                                <span className="font-mono tabular-nums text-[10px] text-slate-400 ml-1 shrink-0">
                                  {obj.rowCount}
                                </span>
                              </button>
                              {open && (
                                <div className="pl-6 py-1 space-y-0.5 border-l border-slate-200 dark:border-slate-800 ml-2.5">
                                  {obj.columns.map((col) => (
                                    <div
                                      key={col.name}
                                      className="flex items-center justify-between text-[11px] py-0.5 text-slate-600 dark:text-slate-400 gap-2"
                                    >
                                      <span className="truncate font-mono">{col.name}</span>
                                      <span className="text-[10px] text-slate-400 shrink-0">
                                        {col.dataType}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {detectedTables.length > 0 && (
                    <div>
                      <p className="text-[11px] font-medium text-slate-400 mb-1">
                        Tables ({detectedTables.length})
                      </p>
                      <div className="space-y-0.5">
                        {detectedTables.map((obj) => {
                          const open = Boolean(expandedObjects[obj.fullName]);
                          return (
                            <div key={obj.fullName}>
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedObjects((prev) => ({
                                    ...prev,
                                    [obj.fullName]: !prev[obj.fullName],
                                  }))
                                }
                                className="w-full flex items-center justify-between py-1.5 px-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800/60 text-left cursor-pointer"
                              >
                                <span className="flex items-center gap-1.5 min-w-0">
                                  {open ? (
                                    <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
                                  ) : (
                                    <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />
                                  )}
                                  <Table2 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                                  <span className="truncate font-mono text-[11px] text-slate-800 dark:text-slate-200">
                                    {obj.name}
                                  </span>
                                </span>
                                <span className="font-mono tabular-nums text-[10px] text-slate-400 ml-1 shrink-0">
                                  {obj.rowCount}
                                </span>
                              </button>
                              {open && (
                                <div className="pl-6 py-1 space-y-0.5 border-l border-slate-200 dark:border-slate-800 ml-2.5">
                                  {obj.columns.map((col) => (
                                    <div
                                      key={col.name}
                                      className="flex items-center justify-between text-[11px] py-0.5 text-slate-600 dark:text-slate-400 gap-2"
                                    >
                                      <span className="truncate font-mono flex items-center gap-1">
                                        {col.isPrimaryKey && (
                                          <KeyRound className="w-2.5 h-2.5 text-amber-600 shrink-0" />
                                        )}
                                        {col.name}
                                      </span>
                                      <span className="text-[10px] text-slate-400 shrink-0">
                                        {col.referencesTable ? `→ ${col.referencesTable}` : col.dataType}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Account & Theme Footer */}
          <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                {currentUser.name}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 capitalize truncate">
                {currentUser.role}
                {currentUser.allowedCompanies.length > 0
                  ? ` · ${currentUser.allowedCompanies.length} société(s)`
                  : ''}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setDarkMode((d) => !d)}
                className="p-2 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                aria-label="Basculer le thème clair/sombre"
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="p-2 text-slate-500 hover:text-red-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                aria-label="Se déconnecter"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </aside>

        {/* Main Viewport */}
        <main className="flex-1 min-w-0 p-4 lg:p-8 overflow-y-auto">
          <div className="max-w-[1440px] mx-auto">
            {activeSection === 'dashboards' && (
              <div className="space-y-6">
                {/* Workspace Header & Toolbar */}
                <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1">
                      <Database className="w-3.5 h-3.5 shrink-0" />
                      <span>{activeConnection?.name || 'Aucune source'}</span>
                      {lastRefreshedAt && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            Actualisé à {new Date(lastRefreshedAt).toLocaleTimeString('fr-FR')}
                          </span>
                        </>
                      )}
                    </div>
                    <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
                      {activeDashboard?.name || 'Aucun tableau de bord'}
                    </h1>
                    {activeDashboard?.description && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        {activeDashboard.description}
                      </p>
                    )}
                  </div>

                  {/* Secondary Workspace Actions (Exports, Edit, Auto-Refresh) */}
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={autoRefreshSec}
                      onChange={(e) => setAutoRefreshSec(Number(e.target.value))}
                      className="px-3 py-2 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-200"
                      aria-label="Fréquence d'actualisation automatique"
                    >
                      <option value={0}>Actualisation manuelle</option>
                      <option value={30}>Auto : 30 secondes</option>
                      <option value={60}>Auto : 1 minute</option>
                      <option value={300}>Auto : 5 minutes</option>
                    </select>

                    {canEdit && activeDashboard && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingWidget(null);
                            setWidgetModalOpen(true);
                          }}
                          className="px-3.5 py-2 text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-blue-600 rounded-lg text-slate-800 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400" />
                          <span>Ajouter un visuel</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setEditMode((m) => !m)}
                          className={`px-3.5 py-2 text-xs font-medium border rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                            editMode
                              ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900'
                              : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          <span>{editMode ? 'Terminer l’édition' : 'Personnaliser'}</span>
                        </button>
                      </>
                    )}

                    {canExport && activeDashboard && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            exportDashboardToExcel(
                              activeDashboard.name,
                              activeConnection?.name || 'SQL Server',
                              activeDashboard.widgets,
                              resultsMap,
                              filters
                            )
                          }
                          className="px-3.5 py-2 text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                        >
                          <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                          <span>Exporter Excel</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            exportDashboardToPdf(
                              activeDashboard.name,
                              activeConnection?.name || 'SQL Server',
                              activeDashboard.widgets,
                              resultsMap,
                              filters
                            )
                          }
                          className="px-3.5 py-2 text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400" />
                          <span>Exporter PDF</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Dynamic Multi-Dimensional Filter Bar (Date, Client, Article, Société) */}
                <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                      <Filter className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400" />
                      <span>Filtres dynamiques</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => applyDatePreset('all')}
                        className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer ${
                          !filters.dateFrom && !filters.dateTo
                            ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900'
                        }`}
                      >
                        Toutes dates
                      </button>
                      <button
                        type="button"
                        onClick={() => applyDatePreset('90d')}
                        className="px-2.5 py-1 text-xs rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900 cursor-pointer"
                      >
                        90 derniers jours
                      </button>
                      <button
                        type="button"
                        onClick={() => applyDatePreset('2026')}
                        className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer ${
                          filters.dateFrom === '2026-01-01'
                            ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900'
                        }`}
                      >
                        Exercice 2026
                      </button>

                      {hasActiveFilters && (
                        <button
                          type="button"
                          onClick={() => setFilters(EMPTY_FILTERS)}
                          className="ml-2 px-2.5 py-1 text-xs text-blue-700 dark:text-blue-400 hover:underline inline-flex items-center gap-1 cursor-pointer"
                        >
                          <RotateCcw className="w-3 h-3" />
                          <span>Réinitialiser</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 text-xs">
                    <div>
                      <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                        Date début
                      </label>
                      <input
                        type="date"
                        value={filters.dateFrom}
                        min={filterOptions.minDate || undefined}
                        max={filterOptions.maxDate || undefined}
                        onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
                        className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                        Date fin
                      </label>
                      <input
                        type="date"
                        value={filters.dateTo}
                        min={filterOptions.minDate || undefined}
                        max={filterOptions.maxDate || undefined}
                        onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
                        className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                        Société
                      </label>
                      <select
                        value={filters.company}
                        onChange={(e) => setFilters((f) => ({ ...f, company: e.target.value }))}
                        className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
                      >
                        <option value="">Toutes les sociétés</option>
                        {filterOptions.companies.map((comp) => (
                          <option key={comp} value={comp}>
                            {comp}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                        Client
                      </label>
                      <select
                        value={filters.client}
                        onChange={(e) => setFilters((f) => ({ ...f, client: e.target.value }))}
                        className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
                      >
                        <option value="">Tous les clients</option>
                        {filterOptions.clients.map((cl) => (
                          <option key={cl} value={cl}>
                            {cl}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                        Article
                      </label>
                      <select
                        value={filters.article}
                        onChange={(e) => setFilters((f) => ({ ...f, article: e.target.value }))}
                        className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
                      >
                        <option value="">Tous les articles</option>
                        {filterOptions.articles.map((art) => (
                          <option key={art} value={art}>
                            {art}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                        Recherche rapide
                      </label>
                      <input
                        type="text"
                        value={filters.search}
                        onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                        placeholder="Client, article, région..."
                        className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
                      />
                    </div>
                  </div>
                </section>

                {queryError && (
                  <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
                    {queryError}
                  </div>
                )}

                {activeDashboard && activeDashboard.widgets.length === 0 ? (
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-12 text-center">
                    <p className="font-display text-base font-semibold text-slate-900 dark:text-white">
                      Ce tableau de bord est prêt à être composé
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
                      Sélectionnez une table ou une vue détectée dans votre base SQL Server pour ajouter vos premiers KPI, graphiques ou tableaux détaillés.
                    </p>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingWidget(null);
                          setWidgetModalOpen(true);
                        }}
                        className="mt-4 px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Ajouter le premier visuel</span>
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    {/* KPI Strip */}
                    {kpiWidgets.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {kpiWidgets.map((w) => {
                          const res = resultsMap[w.id];
                          return (
                            <div
                              key={w.id}
                              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                  {w.title}
                                </span>
                                {editMode && (
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingWidget(w);
                                        setWidgetModalOpen(true);
                                      }}
                                      className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                                    >
                                      <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void handleDeleteWidget(w.id)}
                                      className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                )}
                              </div>

                              <div className="mt-3">
                                {queryLoading && !res ? (
                                  <div className="h-8 w-36 bg-slate-100 dark:bg-slate-800 rounded animate-pulse" />
                                ) : (
                                  <p className="font-display text-2xl lg:text-3xl font-semibold tracking-tight font-mono tabular-nums text-slate-900 dark:text-white">
                                    {formatNumericValue(
                                      res?.summaryValue,
                                      w.valuePrefix || '',
                                      w.valueSuffix || ''
                                    )}
                                  </p>
                                )}
                              </div>

                              <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                                <span className="truncate">{w.sourceObject}</span>
                                <span>
                                  {w.aggregation}({w.measureColumn})
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Main Analytical Charts & Tables Grid */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                      {visualWidgets.map((w) => {
                        const res = resultsMap[w.id];
                        const spanClass =
                          w.colSpan === 3
                            ? 'lg:col-span-3'
                            : w.colSpan === 2
                            ? 'lg:col-span-2'
                            : 'lg:col-span-1';

                        const isCrossFilterable = Boolean(
                          w.dimensionColumn &&
                            ['CLIENT', 'ARTICLE', 'SOCIETE'].some((k) =>
                              w.dimensionColumn!.toUpperCase().includes(k)
                            )
                        );

                        return (
                          <div
                            key={w.id}
                            className={`${spanClass} bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col`}
                          >
                            <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-white truncate">
                                  {w.title}
                                </h3>
                                <p className="text-[11px] text-slate-400 mt-0.5 font-mono truncate">
                                  {w.sourceObject}
                                  {isCrossFilterable ? ' · Cliquer pour filtrer' : ''}
                                </p>
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0">
                                {res && (
                                  <span className="text-[11px] font-mono tabular-nums text-slate-400">
                                    {res.durationMs} ms
                                  </span>
                                )}
                                {editMode && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingWidget(w);
                                        setWidgetModalOpen(true);
                                      }}
                                      className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                                      aria-label="Modifier le visuel"
                                    >
                                      <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void handleDeleteWidget(w.id)}
                                      className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                                      aria-label="Supprimer le visuel"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>

                            <div className={w.type === 'table' ? 'flex-1' : 'p-5 flex-1'}>
                              {queryLoading && !res ? (
                                <div className="h-56 bg-slate-100 dark:bg-slate-800/60 rounded-lg animate-pulse" />
                              ) : w.type === 'bar' ? (
                                <BarChartVisual
                                  rows={res?.rows || []}
                                  prefix={w.valuePrefix}
                                  suffix={w.valueSuffix}
                                  activeLabel={getActiveCrossLabel(w)}
                                  onSelectLabel={
                                    isCrossFilterable
                                      ? (label) => handleCrossFilter(w, label)
                                      : undefined
                                  }
                                />
                              ) : w.type === 'line' ? (
                                <LineAreaChartVisual
                                  rows={res?.rows || []}
                                  prefix={w.valuePrefix}
                                  suffix={w.valueSuffix}
                                />
                              ) : w.type === 'pie' ? (
                                <DonutChartVisual
                                  rows={res?.rows || []}
                                  prefix={w.valuePrefix}
                                  suffix={w.valueSuffix}
                                  activeLabel={getActiveCrossLabel(w)}
                                  onSelectLabel={
                                    isCrossFilterable
                                      ? (label) => handleCrossFilter(w, label)
                                      : undefined
                                  }
                                />
                              ) : (
                                <DataTableVisual rows={res?.rows || []} />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {activeSection === 'explorer' && (
              <SqlExplorerView
                connection={activeConnection}
                schema={schema}
                canRunSql={canRunSql}
                canExport={canExport}
              />
            )}

            {activeSection === 'connections' && (
              <ConnectionsView
                connections={connections}
                activeConnectionId={activeConnectionId}
                isAdmin={currentUser.role === 'admin'}
                onSelectConnection={(id) => {
                  setActiveConnectionId(id);
                  setFilters(EMPTY_FILTERS);
                }}
                onConnectionsChanged={loadWorkspace}
                onDetectSchema={async (id) => {
                  setActiveConnectionId(id);
                  await loadSchema(id, true);
                  setActiveSection('explorer');
                }}
                onImportSuccess={async (connectionId, dashboardId) => {
                  await loadWorkspace();
                  setActiveConnectionId(connectionId);
                  setFilters(EMPTY_FILTERS);
                  await loadSchema(connectionId, true);
                  if (dashboardId) {
                    setActiveDashboardId(dashboardId);
                    setActiveSection('dashboards');
                  } else {
                    setActiveSection('explorer');
                  }
                }}
              />
            )}

            {activeSection === 'users' && currentUser.role === 'admin' && (
              <UsersAccessView
                currentUser={currentUser}
                connections={connections}
                availableCompanies={filterOptions.companies}
              />
            )}
          </div>
        </main>
      </div>

      {/* Custom Widget Designer Modal */}
      <WidgetBuilderModal
        open={widgetModalOpen}
        connectionId={activeDashboard?.connectionId || activeConnectionId}
        schema={schema}
        initialWidget={editingWidget}
        onClose={() => {
          setWidgetModalOpen(false);
          setEditingWidget(null);
        }}
        onSave={handleSaveWidget}
      />

      {/* New Dashboard Modal */}
      {newDashModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white">
                Nouveau tableau de bord
              </h3>
              <button
                type="button"
                onClick={() => setNewDashModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateDashboard} className="space-y-4 text-xs">
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Nom du tableau de bord
                </label>
                <input
                  type="text"
                  required
                  value={newDashName}
                  onChange={(e) => setNewDashName(e.target.value)}
                  placeholder="Ex. Suivi Trésorerie & Encours"
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Description
                </label>
                <input
                  type="text"
                  value={newDashDesc}
                  onChange={(e) => setNewDashDesc(e.target.value)}
                  placeholder="Ex. Analyse des factures échues par client"
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setNewDashModalOpen(false)}
                  className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white font-medium rounded-lg cursor-pointer"
                >
                  Créer le tableau
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
