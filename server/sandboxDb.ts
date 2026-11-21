import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SANDBOX_DB_PATH = path.join(DATA_DIR, 'erp-sandbox.db');

let readonlySandboxDb: Database.Database | null = null;

function ensureSandboxSeeded(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(SANDBOX_DB_PATH);
  try {
    const existing = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='VENTES_FACTURES'")
      .get();

    if (existing) {
      return;
    }

    db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE SOCIETES (
        ID_SOCIETE INTEGER PRIMARY KEY,
        CODE_SOCIETE TEXT NOT NULL UNIQUE,
        RAISON_SOCIALE TEXT NOT NULL,
        VILLE TEXT NOT NULL,
        PAYS TEXT NOT NULL,
        DEVISE TEXT NOT NULL
      );

      CREATE TABLE CLIENTS (
        ID_CLIENT INTEGER PRIMARY KEY,
        CODE_CLIENT TEXT NOT NULL UNIQUE,
        NOM_CLIENT TEXT NOT NULL,
        SEGMENT TEXT NOT NULL,
        VILLE TEXT NOT NULL,
        REGION TEXT NOT NULL,
        ID_SOCIETE INTEGER NOT NULL REFERENCES SOCIETES(ID_SOCIETE),
        ENCOURS_MAX REAL NOT NULL
      );

      CREATE TABLE ARTICLES (
        ID_ARTICLE INTEGER PRIMARY KEY,
        REF_ARTICLE TEXT NOT NULL UNIQUE,
        DESIGNATION TEXT NOT NULL,
        FAMILLE TEXT NOT NULL,
        PRIX_ACHAT REAL NOT NULL,
        PRIX_VENTE REAL NOT NULL,
        STOCK_ACTUEL INTEGER NOT NULL
      );

      CREATE TABLE VENTES_FACTURES (
        ID_FACTURE INTEGER PRIMARY KEY,
        NUM_FACTURE TEXT NOT NULL UNIQUE,
        DATE_FACTURE TEXT NOT NULL,
        ID_SOCIETE INTEGER NOT NULL REFERENCES SOCIETES(ID_SOCIETE),
        ID_CLIENT INTEGER NOT NULL REFERENCES CLIENTS(ID_CLIENT),
        ID_ARTICLE INTEGER NOT NULL REFERENCES ARTICLES(ID_ARTICLE),
        QUANTITE INTEGER NOT NULL,
        MONTANT_HT REAL NOT NULL,
        COUT_ACHAT REAL NOT NULL,
        MARGE_HT REAL NOT NULL,
        STATUT_PAIEMENT TEXT NOT NULL,
        COMMERCIAL TEXT NOT NULL
      );

      CREATE VIEW VW_ANALYSE_VENTES AS
      SELECT
        f.ID_FACTURE,
        f.NUM_FACTURE,
        f.DATE_FACTURE,
        substr(f.DATE_FACTURE, 1, 7) AS MOIS,
        s.CODE_SOCIETE,
        s.RAISON_SOCIALE AS SOCIETE,
        c.CODE_CLIENT,
        c.NOM_CLIENT AS CLIENT,
        c.SEGMENT AS SEGMENT_CLIENT,
        c.REGION,
        a.REF_ARTICLE,
        a.DESIGNATION AS ARTICLE,
        a.FAMILLE AS FAMILLE_ARTICLE,
        f.COMMERCIAL,
        f.QUANTITE,
        f.MONTANT_HT AS CA_HT,
        f.COUT_ACHAT,
        f.MARGE_HT,
        f.STATUT_PAIEMENT
      FROM VENTES_FACTURES f
      INNER JOIN SOCIETES s ON s.ID_SOCIETE = f.ID_SOCIETE
      INNER JOIN CLIENTS c ON c.ID_CLIENT = f.ID_CLIENT
      INNER JOIN ARTICLES a ON a.ID_ARTICLE = f.ID_ARTICLE;

      CREATE VIEW VW_PERFORMANCE_CLIENTS AS
      SELECT
        c.CODE_CLIENT,
        c.NOM_CLIENT AS CLIENT,
        c.SEGMENT AS SEGMENT_CLIENT,
        c.REGION,
        s.RAISON_SOCIALE AS SOCIETE,
        COUNT(f.ID_FACTURE) AS NB_FACTURES,
        SUM(f.QUANTITE) AS TOTAL_QUANTITE,
        ROUND(SUM(f.MONTANT_HT), 2) AS CA_TOTAL_HT,
        ROUND(SUM(f.MARGE_HT), 2) AS MARGE_TOTALE_HT,
        MAX(f.DATE_FACTURE) AS DERNIERE_FACTURE
      FROM CLIENTS c
      INNER JOIN SOCIETES s ON s.ID_SOCIETE = c.ID_SOCIETE
      LEFT JOIN VENTES_FACTURES f ON f.ID_CLIENT = c.ID_CLIENT
      GROUP BY c.ID_CLIENT, c.CODE_CLIENT, c.NOM_CLIENT, c.SEGMENT, c.REGION, s.RAISON_SOCIALE;

      CREATE VIEW VW_STOCK_ET_MARGES AS
      SELECT
        a.REF_ARTICLE,
        a.DESIGNATION AS ARTICLE,
        a.FAMILLE AS FAMILLE_ARTICLE,
        a.PRIX_ACHAT,
        a.PRIX_VENTE,
        a.STOCK_ACTUEL,
        ROUND((a.PRIX_VENTE - a.PRIX_ACHAT) * 100.0 / a.PRIX_VENTE, 2) AS TAUX_MARGE_PCT,
        COALESCE(SUM(f.QUANTITE), 0) AS QTE_VENDUE,
        ROUND(COALESCE(SUM(f.MONTANT_HT), 0), 2) AS CA_GENERE_HT
      FROM ARTICLES a
      LEFT JOIN VENTES_FACTURES f ON f.ID_ARTICLE = a.ID_ARTICLE
      GROUP BY a.ID_ARTICLE, a.REF_ARTICLE, a.DESIGNATION, a.FAMILLE, a.PRIX_ACHAT, a.PRIX_VENTE, a.STOCK_ACTUEL;
    `);

    const insertSoc = db.prepare(
      'INSERT INTO SOCIETES (ID_SOCIETE, CODE_SOCIETE, RAISON_SOCIALE, VILLE, PAYS, DEVISE) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const societes = [
      [1, 'SOC-ALPHA', 'ALPHA DISTRIBUTION SAS', 'Paris', 'France', 'EUR'],
      [2, 'SOC-BETA', 'BETA INDUSTRIE LYON', 'Lyon', 'France', 'EUR'],
      [3, 'SOC-GAMMA', 'GAMMA SERVICES MARSEILLE', 'Marseille', 'France', 'EUR'],
    ];
    for (const s of societes) insertSoc.run(...s);

    const insertClient = db.prepare(
      'INSERT INTO CLIENTS (ID_CLIENT, CODE_CLIENT, NOM_CLIENT, SEGMENT, VILLE, REGION, ID_SOCIETE, ENCOURS_MAX) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const clients = [
      [1, 'CLI-001', 'Groupe Delacroix & Fils', 'Grand Compte', 'Paris', 'Île-de-France', 1, 150000],
      [2, 'CLI-002', 'Logistique Nord Atlantique', 'ETI', 'Nantes', 'Pays de la Loire', 1, 85000],
      [3, 'CLI-003', 'Clinique Saint-Honoré', 'Santé', 'Paris', 'Île-de-France', 1, 120000],
      [4, 'CLI-004', 'Menuiseries Val de Loire', 'PME', 'Tours', 'Centre-Val de Loire', 1, 45000],
      [5, 'CLI-005', 'Transports Mercier SAS', 'ETI', 'Lille', 'Hauts-de-France', 1, 95000],
      [6, 'CLI-006', 'Cabinet Expertise Moreau', 'PME', 'Rouen', 'Normandie', 1, 35000],
      [7, 'CLI-007', 'Aéro Mécanique Rhône', 'Grand Compte', 'Lyon', 'Auvergne-Rhône-Alpes', 2, 180000],
      [8, 'CLI-008', 'Laboratoires Alpine Bio', 'ETI', 'Grenoble', 'Auvergne-Rhône-Alpes', 2, 110000],
      [9, 'CLI-009', 'Fonderie Moderne du Forez', 'Industrie', 'Saint-Étienne', 'Auvergne-Rhône-Alpes', 2, 90000],
      [10, 'CLI-010', 'Distri-Froid Savoie', 'PME', 'Annecy', 'Auvergne-Rhône-Alpes', 2, 60000],
      [11, 'CLI-011', 'Équipements Industriels Est', 'ETI', 'Strasbourg', 'Grand Est', 2, 95000],
      [12, 'CLI-012', 'Chantiers Navals Phocéens', 'Grand Compte', 'Marseille', 'PACA', 3, 160000],
      [13, 'CLI-013', 'Hôtellerie Côte d’Azur', 'ETI', 'Nice', 'PACA', 3, 85000],
      [14, 'CLI-014', 'Coopérative Solaire Midi', 'PME', 'Montpellier', 'Occitanie', 3, 55000],
      [15, 'CLI-015', 'Portuaire Méditerranée Log', 'Grand Compte', 'Toulon', 'PACA', 3, 140000],
      [16, 'CLI-016', 'Bâtiment Sud-Ouest', 'PME', 'Toulouse', 'Occitanie', 3, 65000],
    ];
    for (const c of clients) insertClient.run(...c);

    const insertArt = db.prepare(
      'INSERT INTO ARTICLES (ID_ARTICLE, REF_ARTICLE, DESIGNATION, FAMILLE, PRIX_ACHAT, PRIX_VENTE, STOCK_ACTUEL) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const articles = [
      [1, 'ART-SRV01', 'Serveur Rack Pro XE-200', 'Infrastructure', 2150, 3490, 14],
      [2, 'ART-SRV02', 'Baie NAS Entreprise 48To', 'Infrastructure', 1480, 2390, 19],
      [3, 'ART-WKS01', 'Station Travail CAD i9', 'Postes Clients', 1290, 1980, 32],
      [4, 'ART-LAP01', 'Ultrabook Pro 14" 32Go', 'Postes Clients', 890, 1420, 48],
      [5, 'ART-NET01', 'Switch Managé 48 Ports PoE', 'Réseaux', 520, 890, 27],
      [6, 'ART-NET02', 'Pare-feu UTM Enterprise', 'Réseaux', 780, 1350, 16],
      [7, 'ART-LOG01', 'Licence ERP Gestion 10 Postes', 'Logiciels', 900, 2650, 999],
      [8, 'ART-LOG02', 'Suite BI Connecteur SQL Annual', 'Logiciels', 420, 1490, 999],
      [9, 'ART-LOG03', 'Pack Sauvegarde Cloud 10To', 'Logiciels', 310, 790, 999],
      [10, 'ART-SVC01', 'Contrat Infogérance Annuel', 'Services', 650, 1850, 999],
      [11, 'ART-SVC02', 'Audit Sécurité & Migration', 'Services', 800, 2200, 999],
      [12, 'ART-PER01', 'Écran 32" 4K Calibré Pro', 'Postes Clients', 340, 590, 64],
    ];
    for (const a of articles) insertArt.run(...a);

    const commerciauxBySociete: Record<number, string[]> = {
      1: ['Nadia Benali', 'Thomas Lefèvre'],
      2: ['Julien Girard', 'Claire Vasseur'],
      3: ['Marc Rivière', 'Sophie Laurent'],
    };

    const insertFact = db.prepare(`
      INSERT INTO VENTES_FACTURES (
        ID_FACTURE, NUM_FACTURE, DATE_FACTURE, ID_SOCIETE, ID_CLIENT, ID_ARTICLE,
        QUANTITE, MONTANT_HT, COUT_ACHAT, MARGE_HT, STATUT_PAIEMENT, COMMERCIAL
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Deterministic pseudo-random generator for reproducible, consistent ERP figures
    let seed = 200802;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const months = [
      '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04',
      '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ];

    const tx = db.transaction(() => {
      let id = 1;
      for (let mIdx = 0; mIdx < months.length; mIdx += 1) {
        const ym = months[mIdx];
        // Seasonal volume variation: ~28-38 invoices per month
        const countInMonth = 26 + ((mIdx * 3 + 5) % 12);
        for (let k = 0; k < countInMonth; k += 1) {
          const clientRow = clients[Math.floor(nextRand() * clients.length)];
          const clientId = clientRow[0] as number;
          const societeId = clientRow[6] as number;
          const articleRow = articles[Math.floor(nextRand() * articles.length)];
          const articleId = articleRow[0] as number;
          const prixAchat = articleRow[4] as number;
          const prixVente = articleRow[5] as number;

          const qty = 1 + Math.floor(nextRand() * 6);
          const discountFactor = 0.94 + nextRand() * 0.08;
          const montantHt = Math.round(qty * prixVente * discountFactor * 100) / 100;
          const coutAchat = Math.round(qty * prixAchat * 100) / 100;
          const margeHt = Math.round((montantHt - coutAchat) * 100) / 100;

          const day = String(1 + Math.floor(nextRand() * 28)).padStart(2, '0');
          const dateFact = `${ym}-${day}`;
          const numFact = `FA-${ym.replace('-', '')}-${String(id).padStart(4, '0')}`;

          const statusRoll = nextRand();
          const statut =
            mIdx >= 10 && statusRoll > 0.72
              ? 'En attente'
              : statusRoll > 0.92
              ? 'Échue'
              : 'Payée';

          const comms = commerciauxBySociete[societeId];
          const commercial = comms[Math.floor(nextRand() * comms.length)];

          insertFact.run(
            id,
            numFact,
            dateFact,
            societeId,
            clientId,
            articleId,
            qty,
            montantHt,
            coutAchat,
            margeHt,
            statut,
            commercial
          );
          id += 1;
        }
      }
    });

    tx();
  } finally {
    db.close();
  }
}

export function getSandboxReadOnlyDb(): Database.Database {
  if (!readonlySandboxDb) {
    ensureSandboxSeeded();
    readonlySandboxDb = new Database(SANDBOX_DB_PATH, { readonly: true, fileMustExist: true });
  }
  return readonlySandboxDb;
}
