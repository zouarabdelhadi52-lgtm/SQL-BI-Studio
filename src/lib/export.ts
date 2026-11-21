import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { DynamicFilters, WidgetConfig, WidgetQueryResult } from '../types/bi';

function sanitizeSheetName(raw: string, fallbackIndex: number): string {
  const cleaned = raw.replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 28);
  return cleaned || `Visuel_${fallbackIndex + 1}`;
}

export function formatNumericValue(val: number | null | undefined, prefix = '', suffix = ''): string {
  if (val === null || val === undefined || Number.isNaN(val)) return '—';
  const formatted = new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: Math.abs(val) >= 100 ? 0 : 2,
  }).format(val);
  return `${prefix}${formatted}${suffix}`;
}

function buildFilterSummaryRows(filters: DynamicFilters): [string, string][] {
  return [
    ['Période du', filters.dateFrom || 'Toutes dates'],
    ['Période au', filters.dateTo || 'Toutes dates'],
    ['Société', filters.company || 'Toutes'],
    ['Client', filters.client || 'Tous'],
    ['Article', filters.article || 'Tous'],
    ['Recherche', filters.search || 'Aucune'],
  ];
}

export function exportDashboardToExcel(
  dashboardName: string,
  connectionName: string,
  widgets: WidgetConfig[],
  resultsMap: Record<string, WidgetQueryResult>,
  filters: DynamicFilters
): void {
  const wb = XLSX.utils.book_new();

  const summaryRows: (string | number)[][] = [
    ['SQL BI Studio — Export Analytique (Lecture Seule)'],
    ['Tableau de bord', dashboardName],
    ['Source SQL', connectionName],
    ['Date export', new Date().toLocaleString('fr-FR')],
    [],
    ['Filtres appliqués', 'Valeur'],
    ...buildFilterSummaryRows(filters),
    [],
    ['Indicateurs clés (KPI)', 'Valeur calculée', 'Objet source'],
  ];

  widgets
    .filter((w) => w.type === 'kpi')
    .forEach((w) => {
      const res = resultsMap[w.id];
      summaryRows.push([
        w.title,
        res?.summaryValue !== null && res?.summaryValue !== undefined
          ? `${res.summaryValue}${w.valueSuffix || ''}`
          : '—',
        w.sourceObject,
      ]);
    });

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 36 }, { wch: 34 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Synthèse');

  const usedNames = new Set<string>(['Synthèse']);
  widgets
    .filter((w) => w.type !== 'kpi')
    .forEach((w, idx) => {
      const res = resultsMap[w.id];
      if (!res || res.rows.length === 0) return;

      let sheetName = sanitizeSheetName(w.title, idx);
      let counter = 2;
      while (usedNames.has(sheetName)) {
        sheetName = `${sheetName.slice(0, 26)}_${counter}`;
        counter += 1;
      }
      usedNames.add(sheetName);

      const ws = XLSX.utils.json_to_sheet(res.rows);
      const cols = Object.keys(res.rows[0] || {});
      ws['!cols'] = cols.map((c) => ({ wch: Math.max(c.length + 4, 16) }));
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

  const safeFile = dashboardName.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  XLSX.writeFile(wb, `sql-bi-${safeFile || 'rapport'}.xlsx`);
}

export function exportDashboardToPdf(
  dashboardName: string,
  connectionName: string,
  widgets: WidgetConfig[],
  resultsMap: Record<string, WidgetQueryResult>,
  filters: DynamicFilters
): void {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42);
  doc.text(`SQL BI Studio — ${dashboardName}`, 40, 42);

  doc.setFontSize(9.5);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `Source : ${connectionName}  |  Généré le ${new Date().toLocaleString('fr-FR')}  |  Mode lecture seule`,
    40,
    60
  );

  autoTable(doc, {
    startY: 74,
    head: [['Filtre actif', 'Valeur sélectionnée']],
    body: buildFilterSummaryRows(filters),
    theme: 'grid',
    styles: { fontSize: 8.5, cellPadding: 4 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255 },
    margin: { left: 40, right: 40 },
    tableWidth: 360,
  });

  const kpis = widgets.filter((w) => w.type === 'kpi');
  if (kpis.length > 0) {
    const startAfterFilters = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 190;
    autoTable(doc, {
      startY: startAfterFilters + 14,
      head: [['Indicateur KPI', 'Valeur', 'Source SQL', 'Agrégation']],
      body: kpis.map((k) => [
        k.title,
        formatNumericValue(resultsMap[k.id]?.summaryValue, k.valuePrefix || '', k.valueSuffix || ''),
        k.sourceObject,
        `${k.aggregation}(${k.measureColumn})`,
      ]),
      theme: 'striped',
      styles: { fontSize: 9, cellPadding: 5 },
      headStyles: { fillColor: [29, 78, 216], textColor: 255 },
      margin: { left: 40, right: 40 },
    });
  }

  widgets
    .filter((w) => w.type !== 'kpi')
    .forEach((w) => {
      const res = resultsMap[w.id];
      if (!res || res.rows.length === 0) return;

      const prevY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 120;
      const nextStart = prevY + 26 > 510 ? 48 : prevY + 26;
      if (prevY + 26 > 510) {
        doc.addPage();
      }

      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text(w.title, 40, nextStart - 6);

      const cols = Object.keys(res.rows[0]);
      const bodyRows = res.rows.slice(0, 30).map((r) =>
        cols.map((c) => {
          const v = r[c];
          if (typeof v === 'number') {
            return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(v);
          }
          return String(v ?? '');
        })
      );

      autoTable(doc, {
        startY: nextStart,
        head: [cols],
        body: bodyRows,
        theme: 'striped',
        styles: { fontSize: 8, cellPadding: 4 },
        headStyles: { fillColor: [30, 41, 59], textColor: 255 },
        margin: { left: 40, right: 40 },
      });
    });

  const safeFile = dashboardName.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  doc.save(`sql-bi-${safeFile || 'rapport'}.pdf`);
}

export function exportSqlTableToExcel(title: string, columns: string[], rows: Record<string, unknown>[]): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, { header: columns });
  ws['!cols'] = columns.map((c) => ({ wch: Math.max(c.length + 4, 15) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Résultats SQL');
  const safe = title.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  XLSX.writeFile(wb, `${safe || 'requete-sql'}.xlsx`);
}

export function exportSqlTableToPdf(title: string, columns: string[], rows: Record<string, unknown>[]): void {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(`SQL BI Studio — ${title}`, 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`${rows.length} ligne(s) exportée(s) · ${new Date().toLocaleString('fr-FR')} · Requête lecture seule`, 40, 56);

  autoTable(doc, {
    startY: 70,
    head: [columns],
    body: rows.slice(0, 120).map((r) => columns.map((c) => String(r[c] ?? ''))),
    theme: 'striped',
    styles: { fontSize: 7.5, cellPadding: 3.5 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255 },
    margin: { left: 32, right: 32 },
  });

  const safe = title.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  doc.save(`${safe || 'requete-sql'}.pdf`);
}
