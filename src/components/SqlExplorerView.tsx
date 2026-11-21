import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Play, ShieldAlert, ShieldCheck } from 'lucide-react';
import { biApi } from '../lib/api';
import { exportSqlTableToExcel, exportSqlTableToPdf } from '../lib/export';
import type { SchemaObject, SqlConnectionConfig, SqlExecutionResult } from '../types/bi';
import { DataTableVisual } from './Charts';

interface SqlExplorerViewProps {
  connection: SqlConnectionConfig | null;
  schema: SchemaObject[];
  canRunSql: boolean;
  canExport: boolean;
}

export const SqlExplorerView: React.FC<SqlExplorerViewProps> = ({
  connection,
  schema,
  canRunSql,
  canExport,
}) => {
  const defaultQuery = useMemo(() => {
    const first = schema.find((s) => s.type === 'VIEW') || schema[0];
    if (!first) {
      return 'SELECT * FROM VW_ANALYSE_VENTES;';
    }
    const isMssql = connection?.engine === 'sqlserver2008r2' || connection?.engine === 'agent_relay';
    if (isMssql) {
      return `SELECT TOP 50 *\nFROM [${first.schema}].[${first.name}];`;
    }
    return `SELECT *\nFROM "${first.name}"\nLIMIT 50;`;
  }, [schema, connection?.engine]);

  const [sqlText, setSqlText] = useState(defaultQuery);
  const [result, setResult] = useState<SqlExecutionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; blocked?: boolean } | null>(null);

  useEffect(() => {
    setSqlText(defaultQuery);
    setResult(null);
    setError(null);
  }, [connection?.id, defaultQuery]);

  const handleRun = async () => {
    if (!connection) return;
    setLoading(true);
    setError(null);
    try {
      const res = await biApi.runReadOnlySql({
        connectionId: connection.id,
        sql: sqlText,
        maxRows: 250,
      });
      setResult(res);
    } catch (err) {
      setResult(null);
      const msg = err instanceof Error ? err.message : 'Erreur lors de l’exécution SQL.';
      const blocked = msg.toLowerCase().includes('lecture seule') || msg.toLowerCase().includes('bloquée');
      setError({ message: msg, blocked });
    } finally {
      setLoading(false);
    }
  };

  const quickTemplates = useMemo(() => {
    const isMssql = connection?.engine === 'sqlserver2008r2' || connection?.engine === 'agent_relay';
    const prefix = isMssql ? 'SELECT TOP 50' : 'SELECT';
    const suffix = isMssql ? '' : '\nLIMIT 50';
    return schema.slice(0, 6).map((obj) => ({
      label: obj.name,
      type: obj.type,
      query: isMssql
        ? `${prefix} *\nFROM [${obj.schema}].[${obj.name}];`
        : `${prefix} *\nFROM "${obj.name}"${suffix};`,
    }));
  }, [schema, connection?.engine]);

  if (!connection) {
    return (
      <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
        Sélectionnez une connexion SQL dans la barre latérale pour explorer les données.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
            Explorateur SQL en lecture seule
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Source active : {connection.name} · Base {connection.database} · Seules les requêtes SELECT / WITH sont exécutées.
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400 font-medium">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>Protection écriture active (INSERT / UPDATE / DELETE / DROP bloqués)</span>
        </div>
      </div>

      {!canRunSql ? (
        <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm text-slate-600 dark:text-slate-300">
          Votre profil utilisateur ne dispose pas de l’autorisation d’exécution SQL libre. Utilisez les tableaux de bord filtrés qui vous sont attribués.
        </div>
      ) : (
        <>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70 dark:bg-slate-900">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Modèles :</span>
                {quickTemplates.map((tpl) => (
                  <button
                    key={tpl.label}
                    type="button"
                    onClick={() => setSqlText(tpl.query)}
                    className="px-2.5 py-1 text-xs font-mono bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-slate-700 dark:text-slate-300 hover:border-blue-600 cursor-pointer"
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={handleRun}
                disabled={loading}
                className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{loading ? 'Exécution...' : 'Exécuter (SELECT)'}</span>
              </button>
            </div>

            <textarea
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              rows={7}
              spellCheck={false}
              className="w-full p-4 font-mono text-xs leading-relaxed bg-slate-950 text-slate-100 focus:outline-none resize-y"
              placeholder="Saisissez une requête SELECT ou WITH ... SELECT en lecture seule..."
            />
          </div>

          {error && (
            <div
              className={`p-4 rounded-xl border text-xs flex items-start gap-2.5 ${
                error.blocked
                  ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200'
                  : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200'
              }`}
            >
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">
                  {error.blocked ? 'Requête interceptée par le pare-feu lecture seule' : 'Erreur SQL'}
                </p>
                <p className="mt-0.5">{error.message}</p>
              </div>
            </div>
          )}

          {result && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-600 dark:text-slate-300 font-mono tabular-nums">
                  {result.rowCount} ligne(s) affichée(s)
                  {result.truncated ? ' (plafonné à 250 lignes)' : ''}
                  {' · '}
                  {result.durationMs} ms
                  {' · '}
                  <span className="text-emerald-700 dark:text-emerald-400">Lecture seule vérifiée</span>
                </div>

                {canExport && result.rows.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => exportSqlTableToExcel('export-requete-sql', result.columns, result.rows)}
                      className="px-3 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                      <span>Excel</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => exportSqlTableToPdf('Résultat Requête SQL', result.columns, result.rows)}
                      className="px-3 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400" />
                      <span>PDF</span>
                    </button>
                  </div>
                )}
              </div>

              <DataTableVisual rows={result.rows as Record<string, string | number | null>[]} />
            </div>
          )}
        </>
      )}
    </div>
  );
};
