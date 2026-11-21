import crypto from 'node:crypto';
import net from 'node:net';

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const CREDENTIAL_KEY = crypto
  .createHash('sha256')
  .update(process.env.DB_CREDENTIAL_KEY || SESSION_SECRET)
  .digest();

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: 'admin' | 'analyste' | 'lecteur';
  exp: number;
}

export function signAuthToken(payload: Omit<AuthTokenPayload, 'exp'>, ttlSeconds = 60 * 60 * 12): string {
  const fullPayload: AuthTokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AuthTokenPayload;
    if (!parsed.sub || !parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CREDENTIAL_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(ciphertext: string): string {
  if (!ciphertext) return '';
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return '';
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', CREDENTIAL_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Strips SQL string literals and comments so keyword scanning only inspects active SQL syntax.
 */
function stripCommentsAndStrings(rawSql: string): { stripped: string; hasMultipleStatements: boolean } {
  let out = '';
  let i = 0;
  let inSingleQuote = false;
  let inBracketId = false;
  let hasSemicolonAfterCode = false;
  let sawCodeAfterSemicolon = false;

  while (i < rawSql.length) {
    const ch = rawSql[i];
    const next = rawSql[i + 1];

    if (inSingleQuote) {
      if (ch === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (ch === "'") {
        inSingleQuote = false;
        out += ' ';
      }
      i += 1;
      continue;
    }

    if (inBracketId) {
      if (ch === ']') {
        inBracketId = false;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < rawSql.length && rawSql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < rawSql.length && !(rawSql[i] === '*' && rawSql[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      out += ' ';
      i += 1;
      continue;
    }

    if (ch === '[') {
      inBracketId = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === ';') {
      hasSemicolonAfterCode = true;
      i += 1;
      continue;
    }

    if (hasSemicolonAfterCode && !/\s/.test(ch)) {
      sawCodeAfterSemicolon = true;
    }

    out += ch;
    i += 1;
  }

  return { stripped: out.trim(), hasMultipleStatements: sawCodeAfterSemicolon };
}

const FORBIDDEN_SQL_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bINSERT\b/i, label: 'INSERT' },
  { pattern: /\bUPDATE\b/i, label: 'UPDATE' },
  { pattern: /\bDELETE\b/i, label: 'DELETE' },
  { pattern: /\bDROP\b/i, label: 'DROP' },
  { pattern: /\bALTER\b/i, label: 'ALTER' },
  { pattern: /\bCREATE\b/i, label: 'CREATE' },
  { pattern: /\bTRUNCATE\b/i, label: 'TRUNCATE' },
  { pattern: /\bMERGE\b/i, label: 'MERGE' },
  { pattern: /\bEXEC(?:UTE)?\b/i, label: 'EXEC / EXECUTE' },
  { pattern: /\bGRANT\b/i, label: 'GRANT' },
  { pattern: /\bREVOKE\b/i, label: 'REVOKE' },
  { pattern: /\bDENY\b/i, label: 'DENY' },
  { pattern: /\bBACKUP\b/i, label: 'BACKUP' },
  { pattern: /\bRESTORE\b/i, label: 'RESTORE' },
  { pattern: /\bDBCC\b/i, label: 'DBCC' },
  { pattern: /\bSHUTDOWN\b/i, label: 'SHUTDOWN' },
  { pattern: /\bKILL\b/i, label: 'KILL' },
  { pattern: /\bBULK\b/i, label: 'BULK' },
  { pattern: /\bOPENROWSET\b/i, label: 'OPENROWSET' },
  { pattern: /\bOPENDATASOURCE\b/i, label: 'OPENDATASOURCE' },
  { pattern: /\bOPENQUERY\b/i, label: 'OPENQUERY' },
  { pattern: /\bINTO\b/i, label: 'SELECT INTO' },
  { pattern: /\bxp_[a-z0-9_]+/i, label: 'Procédure étendue xp_*' },
  { pattern: /\bsp_[a-z0-9_]+/i, label: 'Procédure système sp_*' },
  { pattern: /\bPRAGMA\b/i, label: 'PRAGMA' },
  { pattern: /\bATTACH\b/i, label: 'ATTACH' },
];

export function validateReadOnlySql(rawSql: string): {
  valid: boolean;
  reason?: string;
  sanitizedSql: string;
} {
  const trimmed = rawSql.trim().replace(/;+\s*$/, '');
  if (!trimmed) {
    return { valid: false, reason: 'La requête SQL est vide.', sanitizedSql: '' };
  }
  if (trimmed.length > 10000) {
    return { valid: false, reason: 'La requête dépasse la taille maximale autorisée (10 000 caractères).', sanitizedSql: '' };
  }

  const { stripped, hasMultipleStatements } = stripCommentsAndStrings(trimmed);
  if (hasMultipleStatements) {
    return {
      valid: false,
      reason: 'Mode lecture seule : les requêtes multiples séparées par « ; » sont bloquées.',
      sanitizedSql: '',
    };
  }

  if (!/^(SELECT|WITH)\b/i.test(stripped)) {
    return {
      valid: false,
      reason: 'Mode lecture seule : seules les requêtes SELECT (ou CTE WITH ... SELECT) sont autorisées.',
      sanitizedSql: '',
    };
  }

  for (const rule of FORBIDDEN_SQL_PATTERNS) {
    if (rule.pattern.test(stripped)) {
      return {
        valid: false,
        reason: `Instruction bloquée par le mode lecture seule : ${rule.label}.`,
        sanitizedSql: '',
      };
    }
  }

  return { valid: true, sanitizedSql: trimmed };
}

export function validateSqlServerHost(host: string, port: number): { valid: boolean; reason?: string } {
  const cleanHost = host.trim();
  if (!cleanHost || cleanHost.length > 255 || /[\s;'"\\]/.test(cleanHost)) {
    return { valid: false, reason: 'Nom d’hôte ou adresse IP invalide.' };
  }
  if (cleanHost === '169.254.169.254' || cleanHost.toLowerCase() === 'metadata.google.internal') {
    return { valid: false, reason: 'Adresse réseau réservée non autorisée.' };
  }
  if (net.isIP(cleanHost) === 4 && cleanHost.startsWith('169.254.')) {
    return { valid: false, reason: 'Plage link-local non autorisée.' };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { valid: false, reason: 'Port TCP invalide (1–65535).' };
  }
  return { valid: true };
}
