import React, { useEffect, useState } from 'react';
import { CheckCircle2, Plus, Shield, Trash2, UserPlus, AlertTriangle } from 'lucide-react';
import { biApi } from '../lib/api';
import type { RefreshLogEntry, SqlConnectionConfig, UserProfile, UserRole } from '../types/bi';

interface UsersAccessViewProps {
  currentUser: UserProfile;
  connections: SqlConnectionConfig[];
  availableCompanies: string[];
}

export const UsersAccessView: React.FC<UsersAccessViewProps> = ({
  currentUser,
  connections,
  availableCompanies,
}) => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [logs, setLogs] = useState<RefreshLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('lecteur');
  const [selectedConnections, setSelectedConnections] = useState<string[]>(
    connections.map((c) => c.id)
  );
  const [selectedCompanies, setSelectedCompanies] = useState<string[]>([]);
  const [canExport, setCanExport] = useState(true);
  const [canRunSql, setCanRunSql] = useState(false);
  const [canEditDashboards, setCanEditDashboards] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [uRes, lRes] = await Promise.all([biApi.listUsers(), biApi.listLogs()]);
      setUsers(uRes.users);
      setLogs(lRes.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement des utilisateurs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleRolePreset = (nextRole: UserRole) => {
    setRole(nextRole);
    if (nextRole === 'admin') {
      setCanExport(true);
      setCanRunSql(true);
      setCanEditDashboards(true);
    } else if (nextRole === 'analyste') {
      setCanExport(true);
      setCanRunSql(true);
      setCanEditDashboards(true);
    } else {
      setCanExport(true);
      setCanRunSql(false);
      setCanEditDashboards(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await biApi.createUser({
        name,
        email,
        password,
        role,
        allowedConnectionIds: selectedConnections,
        allowedCompanies: selectedCompanies,
        canExport,
        canRunSql,
        canEditDashboards,
      });
      setShowCreate(false);
      setName('');
      setEmail('');
      setPassword('');
      setSelectedCompanies([]);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible.');
    }
  };

  const togglePermission = async (
    user: UserProfile,
    field: 'canExport' | 'canRunSql' | 'canEditDashboards' | 'active'
  ) => {
    try {
      await biApi.updateUser(user.id, { [field]: !user[field] });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mise à jour refusée.');
    }
  };

  const handleDeleteUser = async (id: string) => {
    try {
      await biApi.deleteUser(id);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Suppression impossible.');
    }
  };

  const toggleItem = (arr: string[], setter: React.Dispatch<React.SetStateAction<string[]>>, val: string) => {
    setter(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
            Utilisateurs, Rôles & Cloisonnement par Société
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Définissez précisément quelles bases SQL Server et quelles sociétés chaque collaborateur peut consulter.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreate((s) => !s)}
          className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
        >
          <UserPlus className="w-3.5 h-3.5" />
          <span>Nouvel utilisateur</span>
        </button>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 text-xs"
        >
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-white">
            Ajouter un accès utilisateur
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Nom</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex. Claire Dupont"
                className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">E-mail</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="claire@entreprise.fr"
                className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Mot de passe (min 8 car.)
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Rôle</label>
              <select
                value={role}
                onChange={(e) => handleRolePreset(e.target.value as UserRole)}
                className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
              >
                <option value="lecteur">Lecteur (Consultation & Filtres)</option>
                <option value="analyste">Analyste (Édition & SQL SELECT)</option>
                <option value="admin">Administrateur (Accès complet)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div>
              <p className="font-medium text-slate-700 dark:text-slate-300 mb-2">
                Bases SQL autorisées
              </p>
              <div className="space-y-1.5">
                {connections.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 cursor-pointer text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={selectedConnections.includes(c.id)}
                      onChange={() => toggleItem(selectedConnections, setSelectedConnections, c.id)}
                    />
                    <span>{c.name}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <p className="font-medium text-slate-700 dark:text-slate-300 mb-2">
                Restriction par société (aucune coche = toutes les sociétés)
              </p>
              <div className="space-y-1.5">
                {availableCompanies.length === 0 ? (
                  <p className="text-slate-400">Aucune société détectée dans la vue active.</p>
                ) : (
                  availableCompanies.map((comp) => (
                    <label key={comp} className="flex items-center gap-2 cursor-pointer text-slate-600 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={selectedCompanies.includes(comp)}
                        onChange={() => toggleItem(selectedCompanies, setSelectedCompanies, comp)}
                      />
                      <span>{comp}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 pt-2 border-t border-slate-100 dark:border-slate-800">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={canExport} onChange={(e) => setCanExport(e.target.checked)} />
              <span>Export Excel & PDF</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={canEditDashboards} onChange={(e) => setCanEditDashboards(e.target.checked)} />
              <span>Créer / modifier des tableaux de bord</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={canRunSql} onChange={(e) => setCanRunSql(e.target.checked)} />
              <span>Explorateur SQL lecture seule</span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
            >
              Annuler
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Créer l’utilisateur</span>
            </button>
          </div>
        </form>
      )}

      {/* Users RBAC Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Shield className="w-4 h-4 text-blue-700 dark:text-blue-400" />
            <span>Comptes et matrice des droits ({users.length})</span>
          </h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300">
                <th className="py-2.5 px-4 font-semibold">Collaborateur</th>
                <th className="py-2.5 px-4 font-semibold">Rôle</th>
                <th className="py-2.5 px-4 font-semibold">Périmètre Sociétés</th>
                <th className="py-2.5 px-4 font-semibold text-center">Export</th>
                <th className="py-2.5 px-4 font-semibold text-center">Édition BI</th>
                <th className="py-2.5 px-4 font-semibold text-center">SQL SELECT</th>
                <th className="py-2.5 px-4 font-semibold text-center">Statut</th>
                <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    Chargement des droits...
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900 dark:text-white">{u.name}</div>
                      <div className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">{u.email}</div>
                    </td>
                    <td className="py-3 px-4 capitalize font-medium text-slate-700 dark:text-slate-200">
                      {u.role}
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                      {u.allowedCompanies.length === 0
                        ? 'Toutes les sociétés'
                        : u.allowedCompanies.join(', ')}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <input
                        type="checkbox"
                        checked={u.canExport}
                        disabled={u.role === 'admin'}
                        onChange={() => togglePermission(u, 'canExport')}
                        aria-label={`Export pour ${u.name}`}
                      />
                    </td>
                    <td className="py-3 px-4 text-center">
                      <input
                        type="checkbox"
                        checked={u.canEditDashboards}
                        disabled={u.role === 'admin'}
                        onChange={() => togglePermission(u, 'canEditDashboards')}
                        aria-label={`Édition BI pour ${u.name}`}
                      />
                    </td>
                    <td className="py-3 px-4 text-center">
                      <input
                        type="checkbox"
                        checked={u.canRunSql}
                        disabled={u.role === 'admin'}
                        onChange={() => togglePermission(u, 'canRunSql')}
                        aria-label={`SQL SELECT pour ${u.name}`}
                      />
                    </td>
                    <td className="py-3 px-4 text-center">
                      <button
                        type="button"
                        disabled={u.id === currentUser.id}
                        onClick={() => togglePermission(u, 'active')}
                        className={`text-xs font-medium cursor-pointer disabled:cursor-default ${
                          u.active
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-slate-400'
                        }`}
                      >
                        {u.active ? 'Actif' : 'Suspendu'}
                      </button>
                    </td>
                    <td className="py-3 px-4 text-right">
                      {u.id !== currentUser.id && (
                        <button
                          type="button"
                          onClick={() => handleDeleteUser(u.id)}
                          className="p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-md cursor-pointer"
                          aria-label={`Supprimer ${u.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Refresh & Read-Only Audit Logs */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-white">
            Journal d’actualisation et de protection lecture seule
          </h3>
        </div>
        <div className="overflow-x-auto max-h-72">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300">
                <th className="py-2 px-4 font-semibold">Horodatage</th>
                <th className="py-2 px-4 font-semibold">Utilisateur</th>
                <th className="py-2 px-4 font-semibold">Connexion</th>
                <th className="py-2 px-4 font-semibold">Opération</th>
                <th className="py-2 px-4 font-semibold text-right">Durée</th>
                <th className="py-2 px-4 font-semibold">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">
                    Aucune activité enregistrée pour le moment.
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                    <td className="py-2 px-4 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString('fr-FR')}
                    </td>
                    <td className="py-2 px-4 text-slate-800 dark:text-slate-200">{log.userName}</td>
                    <td className="py-2 px-4 text-slate-600 dark:text-slate-300">{log.connectionName}</td>
                    <td className="py-2 px-4 text-slate-700 dark:text-slate-200">{log.action}</td>
                    <td className="py-2 px-4 text-right font-mono tabular-nums text-slate-500">
                      {log.durationMs} ms
                    </td>
                    <td className="py-2 px-4 whitespace-nowrap">
                      {log.status === 'success' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          OK
                        </span>
                      ) : log.status === 'blocked' ? (
                        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          Bloqué
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400 font-medium">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          Erreur
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
