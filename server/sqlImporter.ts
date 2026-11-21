import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as XLSX from 'xlsx';

const IMPORT_DIR = path.resolve(process.cwd(), 'data', 'imports');
const openReadOnlyImports = new Map<string, Database.Database>();

function ensureImportDir(): void {
  if (!fs.existsSync(IMPORT_DIR)) {
    fs.mkdirSync(IMPORT_DIR, { recursive: true });
  }
}

export function resolveSafeImportPath(fileName: string): string {
  ensureImportDir();
  const safeBase = path.basename(fileName);
  if (!safeBase || !/^imp-[a-z0-9-]+\.db$/i.test(safeBase)) {
    throw new Error('Nom de fichier de base importée invalide.');
  }
  const resolved = path.resolve(IMPORT_DIR, safeBase);
  if (!resolved.startsWith(IMPORT_DIR + path.sep)) {
    throw new Error('Chemin de fichier non autorisé.');
  }
  return resolved;
}

export function getImportedReadOnlyDb(fileName: string): Database.Database {
  const safePath = resolveSafeImportPath(fileName);
  const cached = openReadOnlyImports.get(safePath);
  if (cached) return cached;
  const db = new Database(safePath, { readonly: true, fileMustExist: true });
  openReadOnlyImports.set(safePath, db);
  return db;
}

export function removeImportedDbFile(fileName?: string): void {
  if (!fileName) return;
  try {
    const safePath = resolveSafeImportPath(fileName);
    const cached = openReadOnlyImports.get(safePath);
    if (cached) {
      cached.close();
      openReadOnlyImports.delete(safePath);
    }
    if (fs.existsSync(safePath)) {
      fs.unlinkSync(safePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Splits a SQL script into individual statements, handling T-SQL GO batches,
 * string literals, bracketed identifiers, and comments.
 */
function splitSqlStatements(rawSql: string): string[] {
  const text = rawSql.replace(/^\uFEFF/, '');
  // First split on standalone T-SQL GO batch lines (outside string literals in typical SSMS dumps)
  const lines = text.split(/\r?\n/);
  const batches: string[] = [];
  let currentBatch: string[] = [];

  for (const line of lines) {
    if (/^\s*GO(?:\s+\d+)?\s*(?:--.*)?$/i.test(line)) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch.join('\n'));
        currentBatch = [];
      }
    } else {
      currentBatch.push(line);
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch.join('\n'));
  }

  const statements: string[] = [];
  for (const batch of batches) {
    let cur = '';
    let i = 0;
    let inSingle = false;
    let inBracket = false;
    let inDouble = false;

    while (i < batch.length) {
      const ch = batch[i];
      const next = batch[i + 1];

      if (inSingle) {
        cur += ch;
        if (ch === "'" && next === "'") {
          cur += next;
          i += 2;
          continue;
        }
        if (ch === "'") inSingle = false;
        i += 1;
        continue;
      }

      if (inBracket) {
        cur += ch;
        if (ch === ']') inBracket = false;
        i += 1;
        continue;
      }

      if (inDouble) {
        cur += ch;
        if (ch === '"') inDouble = false;
        i += 1;
        continue;
      }

      if (ch === '-' && next === '-') {
        while (i < batch.length && batch[i] !== '\n') i += 1;
        cur += '\n';
        continue;
      }

      if (ch === '/' && next === '*') {
        i += 2;
        while (i < batch.length && !(batch[i] === '*' && batch[i + 1] === '/')) i += 1;
        i += 2;
        cur += ' ';
        continue;
      }

      if (ch === "'") {
        inSingle = true;
        cur += ch;
        i += 1;
        continue;
      }
      if (ch === '[') {
        inBracket = true;
        cur += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        cur += ch;
        i += 1;
        continue;
      }

      if (ch === ';') {
        const trimmed = cur.trim();
        if (trimmed) statements.push(trimmed);
        cur = '';
        i += 1;
        continue;
      }

      cur += ch;
      i += 1;
    }

    const tail = cur.trim();
    if (tail) statements.push(tail);
  }

  return statements;
}

/**
 * Converts common T-SQL / SSMS / MySQL dump syntax into clean SQLite-compatible DDL & DML.
 */
function transpileSqlStatement(stmt: string): { sql: string; kind: 'create' | 'insert' | 'ignore' } {
  const trimmed = stmt.trim();
  if (!trimmed) return { sql: '', kind: 'ignore' };

  // Block dangerous SQLite meta-commands
  if (/^\s*(ATTACH|DETACH|PRAGMA|VACUUM|LOAD_EXTENSION)\b/i.test(trimmed)) {
    return { sql: '', kind: 'ignore' };
  }

  // Ignore T-SQL / MySQL session directives
  if (
    /^\s*(USE|SET|PRINT|EXEC|EXECUTE|ALTER\s+DATABASE|IF\s+OBJECT_ID|IF\s+NOT\s+EXISTS|IF\s+EXISTS|LOCK\s+TABLES|UNLOCK\s+TABLES|START\s+TRANSACTION|BEGIN|COMMIT|ALTER\s+TABLE\b)/i.test(
      trimmed
    )
  ) {
    return { sql: '', kind: 'ignore' };
  }

  // Only allow CREATE TABLE, CREATE VIEW, CREATE INDEX, and INSERT INTO
  const isCreateTable = /^\s*CREATE\s+TABLE\b/i.test(trimmed);
  const isCreateView = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i.test(trimmed);
  const isCreateIndex = /^\s*CREATE\s+(?:UNIQUE\s+)?(?:NONCLUSTERED\s+|CLUSTERED\s+)?INDEX\b/i.test(trimmed);
  const isInsert = /^\s*INSERT\s+(?:INTO\s+)?/i.test(trimmed);

  if (!isCreateTable && !isCreateView && !isCreateIndex && !isInsert) {
    return { sql: '', kind: 'ignore' };
  }

  // Convert SSMS [dbo].[Table] or `db`.`table` schema prefixes
  let s = trimmed;
  s = s.replace(/\[(?:dbo|public)\]\s*\.\s*/gi, '');
  s = s.replace(/\b(?:dbo|public)\s*\.\s*/gi, '');

  // Convert T-SQL Unicode string literal prefix N'...' (outside words) to '...'
  s = s.replace(/(^|[\s,(=\[])N'/g, "$1'");

  if (isCreateTable) {
    // Strip T-SQL filegroup, compression & collation clauses
    s = s.replace(/\)\s*ON\s+\[?[^\s\]]+\]?(?:\s+TEXTIMAGE_ON\s+\[?[^\s\]]+\]?)?\s*$/i, ')');
    s = s.replace(/\)\s*ENGINE\s*=.*$/i, ')');
    s = s.replace(/\bCOLLATE\s+[A-Za-z0-9_]+/gi, '');

    // Remove IDENTITY(1,1) [NOT NULL] / AUTO_INCREMENT & CLUSTERED / NONCLUSTERED
    s = s.replace(/\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)(?:\s+NOT\s+NULL)?/gi, '');
    s = s.replace(/\bAUTO_INCREMENT(?:\s+NOT\s+NULL)?/gi, '');
    s = s.replace(/\b(?:NON)?CLUSTERED\b/gi, '');
    s = s.replace(/\bWITH\s*\([^)]*PAD_INDEX[^)]*\)/gi, '');
    s = s.replace(/\bON\s+\[?PRIMARY\]?/gi, '');
    s = s.replace(/\bTEXTIMAGE_ON\s+\[?PRIMARY\]?/gi, '');

    // Normalize SSMS bracketed and unbracketed SQL Server types to SQLite affinities BEFORE quoting identifiers
    s = s.replace(/(?:\[(?:N?VARCHAR|N?CHAR|SYSNAME)\]|\b(?:N?VARCHAR|N?CHAR|SYSNAME)\b)\s*\(\s*(?:MAX|\d+)\s*\)/gi, 'TEXT');
    s = s.replace(/(?:\[(?:NTEXT|TEXT|XML|UNIQUEIDENTIFIER)\]|\b(?:NTEXT|TEXT|XML|UNIQUEIDENTIFIER)\b)/gi, 'TEXT');
    s = s.replace(/(?:\[(?:BIGINT|SMALLINT|TINYINT|BIT|INT|INTEGER)\]|\b(?:BIGINT|SMALLINT|TINYINT|BIT|INT|INTEGER)\b)/gi, 'INTEGER');
    s = s.replace(/(?:\[(?:DECIMAL|NUMERIC|MONEY|SMALLMONEY|FLOAT|REAL)\]|\b(?:DECIMAL|NUMERIC|MONEY|SMALLMONEY|FLOAT|REAL)\b)\s*(?:\([^)]*\))?/gi, 'REAL');
    s = s.replace(/(?:\[(?:DATETIME2?|SMALLDATETIME|DATETIMEOFFSET|DATE|TIME)\]|\b(?:DATETIME2?|SMALLDATETIME|DATETIMEOFFSET|DATE|TIME)\b)\s*(?:\(\d+\))?/gi, 'TEXT');
    s = s.replace(/(?:\[VARBINARY\]|\bVARBINARY\b)\s*\(\s*(?:MAX|\d+)\s*\)/gi, 'BLOB');

    // Convert remaining bracket/backtick identifiers [col] / `col` to "col"
    s = s.replace(/\[([^\]]+)\]/g, '"$1"');
    s = s.replace(/`([^`]+)`/g, '"$1"');

    // Strip T-SQL default wrapper (getdate()) -> date('now')
    s = s.replace(/\bDEFAULT\s*\(\s*getdate\s*\(\s*\)\s*\)/gi, "DEFAULT (date('now'))");

    return { sql: s, kind: 'create' };
  }

  // Convert SSMS bracket identifiers [col] to "col" and MySQL backticks `col` to "col"
  s = s.replace(/\[([^\]]+)\]/g, '"$1"');
  s = s.replace(/`([^`]+)`/g, '"$1"');

  if (isCreateView) {
    s = s.replace(/^\s*CREATE\s+OR\s+REPLACE\s+VIEW\b/i, 'CREATE VIEW');
    s = s.replace(/\bWITH\s+SCHEMABINDING\b/gi, '');
    s = s.replace(/\bISNULL\s*\(/gi, 'COALESCE(');
    s = s.replace(/\bGETDATE\s*\(\s*\)/gi, "date('now')");
    return { sql: s, kind: 'create' };
  }

  if (isCreateIndex) {
    return { sql: s, kind: 'create' };
  }

  // Normalize SSMS `INSERT [Table] (...)` (missing INTO keyword) -> `INSERT INTO "Table" (...)`
  s = s.replace(/^\s*INSERT\s+(?!INTO\b)/i, 'INSERT INTO ');

  // INSERT statement cleanup (SSMS CAST(N'2026-01-15T00:00:00.000' AS DateTime))
  s = s.replace(
    /CAST\s*\(\s*('[^']*')\s+AS\s+(?:DateTime2?|SmallDateTime|Date|DateTimeOffset)\s*\)/gi,
    '$1'
  );
  s = s.replace(/CAST\s*\(\s*([0-9.-]+)\s+AS\s+(?:Decimal|Numeric|Money|Float)\s*(?:\([^)]*\))?\s*\)/gi, '$1');
  return { sql: s, kind: 'insert' };
}

export interface ImportSummary {
  fileName: string;
  tablesCreated: number;
  viewsCreated: number;
  rowsInserted: number;
  warnings: string[];
}

export function importSqlDumpToSqlite(sqlContent: string): ImportSummary {
  ensureImportDir();
  const fileName = `imp-${crypto.randomUUID().slice(0, 8)}.db`;
  const targetPath = resolveSafeImportPath(fileName);

  const statements = splitSqlStatements(sqlContent);
  if (statements.length === 0) {
    throw new Error('Le fichier SQL est vide ou ne contient aucune instruction exploitable.');
  }

  const db = new Database(targetPath);
  let tablesCreated = 0;
  let viewsCreated = 0;
  let rowsInserted = 0;
  const warnings: string[] = [];

  try {
    db.pragma('trusted_schema = OFF');
    db.pragma('foreign_keys = OFF');

    const tx = db.transaction(() => {
      for (const raw of statements) {
        const { sql, kind } = transpileSqlStatement(raw);
        if (kind === 'ignore' || !sql) continue;
        try {
          const info = db.prepare(sql).run();
          if (kind === 'create') {
            if (/^\s*CREATE\s+TABLE\b/i.test(sql)) tablesCreated += 1;
            else if (/^\s*CREATE\s+VIEW\b/i.test(sql)) viewsCreated += 1;
          } else if (kind === 'insert') {
            rowsInserted += info.changes || 1;
          }
        } catch (err) {
          if (warnings.length < 10) {
            const msg = err instanceof Error ? err.message : String(err);
            warnings.push(`${msg} (${sql.slice(0, 75)}...)`);
          }
        }
      }
    });

    tx();

    const objCount = (
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").get() as {
        c: number;
      }
    ).c;

    if (objCount === 0) {
      throw new Error(
        'Aucune table ou vue n’a pu être créée depuis ce script SQL. Vérifiez que le script contient des instructions CREATE TABLE / INSERT INTO.'
      );
    }
  } catch (err) {
    db.close();
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    throw err;
  }

  db.close();
  return { fileName, tablesCreated, viewsCreated, rowsInserted, warnings };
}

export function importSqliteBinary(buffer: Buffer): ImportSummary {
  ensureImportDir();
  if (buffer.length < 100 || buffer.subarray(0, 16).toString('utf8') !== 'SQLite format 3\0') {
    throw new Error('Fichier SQLite invalide (en-tête SQLite format 3 attendu).');
  }

  const fileName = `imp-${crypto.randomUUID().slice(0, 8)}.db`;
  const targetPath = resolveSafeImportPath(fileName);
  fs.writeFileSync(targetPath, buffer);

  try {
    const db = new Database(targetPath, { readonly: true, fileMustExist: true });
    const tables = db
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string; type: string }[];

    let rowsTotal = 0;
    let tablesCreated = 0;
    let viewsCreated = 0;
    for (const t of tables) {
      if (t.type === 'view') viewsCreated += 1;
      else tablesCreated += 1;
      try {
        const cnt = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name.replace(/"/g, '""')}"`).get() as { c: number };
        rowsTotal += cnt?.c ?? 0;
      } catch {
        // ignore
      }
    }
    db.close();

    if (tables.length === 0) {
      throw new Error('La base SQLite importée ne contient aucune table ou vue.');
    }

    return { fileName, tablesCreated, viewsCreated, rowsInserted: rowsTotal, warnings: [] };
  } catch (err) {
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    throw err;
  }
}

function sanitizeColumnName(raw: string, index: number): string {
  const cleaned = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || `COL_${index + 1}`;
}

export function importSpreadsheetToSqlite(buffer: Buffer, originalFileName: string): ImportSummary {
  ensureImportDir();
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('Le fichier Excel / CSV ne contient aucune feuille exploitable.');
  }

  const fileName = `imp-${crypto.randomUUID().slice(0, 8)}.db`;
  const targetPath = resolveSafeImportPath(fileName);
  const db = new Database(targetPath);

  let tablesCreated = 0;
  let rowsInserted = 0;

  try {
    db.pragma('trusted_schema = OFF');
    const baseName = path.basename(originalFileName, path.extname(originalFileName));

    const tx = db.transaction(() => {
      for (let sIdx = 0; sIdx < workbook.SheetNames.length; sIdx += 1) {
        const sheetName = workbook.SheetNames[sIdx];
        const sheet = workbook.Sheets[sheetName];
        const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
        if (jsonRows.length === 0) continue;

        const rawKeys = Object.keys(jsonRows[0]);
        const usedCols = new Set<string>();
        const colPairs = rawKeys.map((rk, i) => {
          let safe = sanitizeColumnName(rk, i);
          let n = 2;
          while (usedCols.has(safe.toUpperCase())) {
            safe = `${safe}_${n}`;
            n += 1;
          }
          usedCols.add(safe.toUpperCase());
          return { raw: rk, safe };
        });

        const colTypes = colPairs.map(({ raw }) => {
          const sample = jsonRows.slice(0, 50).map((r) => r[raw]).filter((v) => v !== null && v !== '');
          if (sample.length > 0 && sample.every((v) => typeof v === 'number' && Number.isFinite(v))) {
            return 'REAL';
          }
          return 'TEXT';
        });

        const rawTableName = workbook.SheetNames.length === 1 ? baseName : sheetName;
        const tableName = sanitizeColumnName(rawTableName, sIdx).toUpperCase();
        const colDefs = colPairs.map((c, idx) => `"${c.safe}" ${colTypes[idx]}`).join(', ');
        db.prepare(`CREATE TABLE "${tableName}" (${colDefs})`).run();
        tablesCreated += 1;

        const placeholders = colPairs.map(() => '?').join(', ');
        const insertStmt = db.prepare(
          `INSERT INTO "${tableName}" (${colPairs.map((c) => `"${c.safe}"`).join(', ')}) VALUES (${placeholders})`
        );

        for (const row of jsonRows) {
          const values = colPairs.map(({ raw }, idx) => {
            const val = row[raw];
            if (val === null || val === undefined || val === '') return null;
            if (val instanceof Date) return val.toISOString().slice(0, 10);
            if (colTypes[idx] === 'REAL') return Number(val);
            return String(val);
          });
          insertStmt.run(...values);
          rowsInserted += 1;
        }
      }
    });

    tx();

    if (tablesCreated === 0) {
      throw new Error('Aucune ligne de données détectée dans le fichier.');
    }
  } catch (err) {
    db.close();
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    throw err;
  }

  db.close();
  return { fileName, tablesCreated, viewsCreated: 0, rowsInserted, warnings: [] };
}
