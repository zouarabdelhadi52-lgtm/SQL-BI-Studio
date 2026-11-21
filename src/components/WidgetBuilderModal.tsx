import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type {
  AggregationType,
  SchemaObject,
  WidgetConfig,
  WidgetType,
} from '../types/bi';

interface WidgetBuilderModalProps {
  open: boolean;
  connectionId: string;
  schema: SchemaObject[];
  initialWidget?: WidgetConfig | null;
  onClose: () => void;
  onSave: (widget: WidgetConfig) => void;
}

const NUMERIC_TYPES = new Set([
  'INT',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'DECIMAL',
  'NUMERIC',
  'FLOAT',
  'REAL',
  'MONEY',
  'SMALLMONEY',
  'INTEGER',
]);

function isNumericType(t: string): boolean {
  const upper = t.toUpperCase();
  return Array.from(NUMERIC_TYPES).some((nt) => upper.includes(nt));
}

export const WidgetBuilderModal: React.FC<WidgetBuilderModalProps> = ({
  open,
  connectionId,
  schema,
  initialWidget,
  onClose,
  onSave,
}) => {
  const defaultSource = initialWidget?.sourceObject || schema[0]?.fullName || '';

  const [title, setTitle] = useState(initialWidget?.title || '');
  const [type, setType] = useState<WidgetType>(initialWidget?.type || 'bar');
  const [sourceObject, setSourceObject] = useState(defaultSource);
  const [dimensionColumn, setDimensionColumn] = useState(initialWidget?.dimensionColumn || '');
  const [measureColumn, setMeasureColumn] = useState(initialWidget?.measureColumn || '*');
  const [aggregation, setAggregation] = useState<AggregationType>(initialWidget?.aggregation || 'SUM');
  const [dateColumn, setDateColumn] = useState(initialWidget?.dateColumn || '');
  const [clientColumn, setClientColumn] = useState(initialWidget?.clientColumn || '');
  const [articleColumn, setArticleColumn] = useState(initialWidget?.articleColumn || '');
  const [companyColumn, setCompanyColumn] = useState(initialWidget?.companyColumn || '');
  const [colSpan, setColSpan] = useState<1 | 2 | 3>(initialWidget?.colSpan || 1);
  const [limit, setLimit] = useState(initialWidget?.limit || 10);
  const [valueSuffix, setValueSuffix] = useState(initialWidget?.valueSuffix || '');
  const [selectedTableCols, setSelectedTableCols] = useState<string[]>(initialWidget?.tableColumns || []);

  const selectedObj = useMemo(
    () => schema.find((o) => o.fullName === sourceObject || o.name === sourceObject) || schema[0],
    [schema, sourceObject]
  );

  useEffect(() => {
    if (!open) return;
    if (initialWidget) {
      setTitle(initialWidget.title);
      setType(initialWidget.type);
      setSourceObject(initialWidget.sourceObject);
      setDimensionColumn(initialWidget.dimensionColumn || '');
      setMeasureColumn(initialWidget.measureColumn);
      setAggregation(initialWidget.aggregation);
      setDateColumn(initialWidget.dateColumn || '');
      setClientColumn(initialWidget.clientColumn || '');
      setArticleColumn(initialWidget.articleColumn || '');
      setCompanyColumn(initialWidget.companyColumn || '');
      setColSpan(initialWidget.colSpan || 1);
      setLimit(initialWidget.limit || 10);
      setValueSuffix(initialWidget.valueSuffix || '');
      setSelectedTableCols(initialWidget.tableColumns || []);
    } else if (selectedObj) {
      const cols = selectedObj.columns;
      const firstNum = cols.find((c) => isNumericType(c.dataType) && !c.isPrimaryKey);
      const firstDim = cols.find((c) => !isNumericType(c.dataType) && !c.name.toUpperCase().includes('DATE'));
      const autoDate = cols.find((c) => c.name.toUpperCase().includes('DATE'));
      const autoClient = cols.find((c) => c.name.toUpperCase().includes('CLIENT'));
      const autoArticle = cols.find((c) => c.name.toUpperCase().includes('ARTICLE') || c.name.toUpperCase().includes('DESIGNATION'));
      const autoComp = cols.find((c) => c.name.toUpperCase().includes('SOCIETE'));

      setTitle('');
      setType('bar');
      setSourceObject(selectedObj.fullName);
      setMeasureColumn(firstNum?.name || '*');
      setAggregation(firstNum ? 'SUM' : 'COUNT');
      setDimensionColumn(firstDim?.name || cols[0]?.name || '');
      setDateColumn(autoDate?.name || '');
      setClientColumn(autoClient?.name || '');
      setArticleColumn(autoArticle?.name || '');
      setCompanyColumn(autoComp?.name || '');
      setColSpan(1);
      setLimit(10);
      setValueSuffix('');
      setSelectedTableCols(cols.slice(0, 7).map((c) => c.name));
    }
  }, [open, initialWidget]);

  // Auto-map common ERP columns when changing source table/view for a new widget
  const handleSourceChange = (nextSource: string) => {
    setSourceObject(nextSource);
    const obj = schema.find((o) => o.fullName === nextSource);
    if (!obj) return;
    const cols = obj.columns;
    const firstNum = cols.find((c) => isNumericType(c.dataType) && !c.isPrimaryKey);
    const firstDim = cols.find((c) => !isNumericType(c.dataType));
    setMeasureColumn(firstNum?.name || '*');
    setAggregation(firstNum ? 'SUM' : 'COUNT');
    setDimensionColumn(firstDim?.name || cols[0]?.name || '');
    setDateColumn(cols.find((c) => c.name.toUpperCase().includes('DATE'))?.name || '');
    setClientColumn(cols.find((c) => c.name.toUpperCase().includes('CLIENT'))?.name || '');
    setArticleColumn(cols.find((c) => c.name.toUpperCase().includes('ARTICLE'))?.name || '');
    setCompanyColumn(cols.find((c) => c.name.toUpperCase().includes('SOCIETE'))?.name || '');
    setSelectedTableCols(cols.slice(0, 7).map((c) => c.name));
  };

  if (!open) return null;

  const columns = selectedObj?.columns || [];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const computedTitle =
      title.trim() ||
      (type === 'kpi'
        ? `${aggregation} ${measureColumn}`
        : type === 'table'
        ? `Données ${selectedObj?.name || ''}`
        : `${measureColumn} par ${dimensionColumn}`);

    onSave({
      id: initialWidget?.id || `w-${Date.now().toString(36)}`,
      title: computedTitle,
      type,
      connectionId,
      sourceObject: selectedObj?.fullName || sourceObject,
      dimensionColumn: type === 'kpi' || type === 'table' ? undefined : dimensionColumn,
      measureColumn,
      aggregation,
      dateColumn: dateColumn || undefined,
      clientColumn: clientColumn || undefined,
      articleColumn: articleColumn || undefined,
      companyColumn: companyColumn || undefined,
      colSpan: type === 'table' && colSpan === 1 ? 3 : colSpan,
      limit,
      sortDirection: type === 'line' ? 'ASC' : 'DESC',
      valueSuffix: valueSuffix.trim() || undefined,
      tableColumns: type === 'table' ? selectedTableCols : undefined,
    });
  };

  const toggleTableCol = (colName: string) => {
    setSelectedTableCols((prev) =>
      prev.includes(colName) ? prev.filter((c) => c !== colName) : [...prev, colName]
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white">
              {initialWidget ? 'Modifier le visuel BI' : 'Nouveau visuel personnalisé'}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Reliez n’importe quelle table ou vue détectée en lecture seule.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded-md cursor-pointer"
            aria-label="Fermer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-5 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Titre du visuel
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ex. Marge brute par client"
                className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Table ou Vue SQL source
              </label>
              <select
                value={sourceObject}
                onChange={(e) => handleSourceChange(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
              >
                {schema.map((obj) => (
                  <option key={obj.fullName} value={obj.fullName}>
                    [{obj.type === 'VIEW' ? 'Vue' : 'Table'}] {obj.fullName} ({obj.rowCount} lignes)
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Type de visualisation
            </label>
            <div className="grid grid-cols-5 gap-2">
              {(
                [
                  { id: 'kpi', label: 'KPI' },
                  { id: 'bar', label: 'Barres' },
                  { id: 'line', label: 'Courbe' },
                  { id: 'pie', label: 'Anneau' },
                  { id: 'table', label: 'Tableau' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setType(opt.id)}
                  className={`py-2 px-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                    type === opt.id
                      ? 'bg-blue-700 text-white border-blue-700'
                      : 'bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:border-slate-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {type !== 'table' ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {type !== 'kpi' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Dimension (Axe / Groupe)
                  </label>
                  <select
                    value={dimensionColumn}
                    onChange={(e) => setDimensionColumn(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  >
                    {columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} ({c.dataType})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Colonne de mesure
                </label>
                <select
                  value={measureColumn}
                  onChange={(e) => setMeasureColumn(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                >
                  <option value="*">* (Nombre de lignes)</option>
                  {columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} ({c.dataType})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Agrégation
                </label>
                <select
                  value={aggregation}
                  onChange={(e) => setAggregation(e.target.value as AggregationType)}
                  className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                >
                  <option value="SUM">Somme (SUM)</option>
                  <option value="AVG">Moyenne (AVG)</option>
                  <option value="COUNT">Comptage (COUNT)</option>
                  <option value="MIN">Minimum (MIN)</option>
                  <option value="MAX">Maximum (MAX)</option>
                </select>
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Colonnes affichées dans le tableau
              </label>
              <div className="flex flex-wrap gap-1.5 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
                {columns.map((col) => {
                  const active = selectedTableCols.includes(col.name);
                  return (
                    <button
                      key={col.name}
                      type="button"
                      onClick={() => toggleTableCol(col.name)}
                      className={`px-2.5 py-1 text-xs rounded-md border transition-colors cursor-pointer ${
                        active
                          ? 'bg-blue-700 text-white border-blue-700'
                          : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {col.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Largeur sur la grille
              </label>
              <select
                value={colSpan}
                onChange={(e) => setColSpan(Number(e.target.value) as 1 | 2 | 3)}
                className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
              >
                <option value={1}>1 colonne (1/3)</option>
                <option value={2}>2 colonnes (2/3)</option>
                <option value={3}>Pleine largeur (3/3)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Limite de lignes / Top N
              </label>
              <input
                type="number"
                min={1}
                max={200}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) || 10)}
                className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Unité / Suffixe (optionnel)
              </label>
              <input
                type="text"
                value={valueSuffix}
                onChange={(e) => setValueSuffix(e.target.value)}
                placeholder="Ex.  € ou  %"
                className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2.5">
              Liaison avec les filtres dynamiques du tableau de bord
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Colonne Date', value: dateColumn, setter: setDateColumn },
                { label: 'Colonne Client', value: clientColumn, setter: setClientColumn },
                { label: 'Colonne Article', value: articleColumn, setter: setArticleColumn },
                { label: 'Colonne Société', value: companyColumn, setter: setCompanyColumn },
              ].map((mapping) => (
                <div key={mapping.label}>
                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                    {mapping.label}
                  </label>
                  <select
                    value={mapping.value}
                    onChange={(e) => mapping.setter(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100"
                  >
                    <option value="">Aucune</option>
                    {columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
            >
              Annuler
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
            >
              {initialWidget ? 'Mettre à jour le visuel' : 'Ajouter au tableau de bord'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
