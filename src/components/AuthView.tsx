import React, { useState } from 'react';
import { Database, Lock, ShieldCheck, UserCheck } from 'lucide-react';
import { biApi } from '../lib/api';
import type { UserProfile } from '../types/bi';

interface AuthViewProps {
  needsSetup: boolean;
  hasEnvAdminOverride: boolean;
  onAuthenticated: (token: string, user: UserProfile) => void;
}

export const AuthView: React.FC<AuthViewProps> = ({
  needsSetup,
  hasEnvAdminOverride,
  onAuthenticated,
}) => {
  const [name, setName] = useState('Administrateur BI');
  const [email, setEmail] = useState('admin@entreprise.fr');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (needsSetup) {
      if (password.length < 8) {
        setError('Le mot de passe doit contenir au moins 8 caractères.');
        return;
      }
      if (password !== confirmPassword) {
        setError('La confirmation du mot de passe ne correspond pas.');
        return;
      }
    }

    setLoading(true);
    try {
      const res = needsSetup
        ? await biApi.setupAdmin({ name, email, password })
        : await biApi.login({ email, password });
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur d’authentification.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
        {/* Left editorial context column */}
        <div className="p-8 md:p-10 bg-slate-900 text-slate-100 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2.5 text-slate-200 mb-8">
              <Database className="w-5 h-5 text-blue-400 shrink-0" />
              <span className="font-display font-semibold text-base tracking-tight">SQL BI Studio</span>
            </div>

            <h1 className="font-display text-2xl md:text-3xl font-semibold tracking-tight text-white leading-tight [text-wrap:balance]">
              Business Intelligence en lecture seule pour SQL Server 2008 R2 à 2022
            </h1>

            <p className="mt-4 text-sm text-slate-300 leading-relaxed">
              Connectez vos bases de gestion commerciale sans jamais altérer vos données de production.
              Détection automatique des tables et vues, tableaux de bord dynamiques et exports certifiés.
            </p>
          </div>

          <div className="mt-10 pt-6 border-t border-slate-800 space-y-3 text-xs text-slate-300">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>Protection lecture seule stricte : requêtes mutantes bloquées côté serveur.</span>
            </div>
            <div className="flex items-start gap-2.5">
              <Lock className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <span>Contrôle d’accès par rôle (Administrateur, Analyste, Lecteur) et périmètre société.</span>
            </div>
          </div>
        </div>

        {/* Right form column */}
        <div className="p-8 md:p-10 flex flex-col justify-center">
          <div className="mb-6">
            <p className="text-xs font-medium text-blue-700 dark:text-blue-400 mb-1">
              {needsSetup ? 'Configuration initiale' : 'Espace sécurisé'}
            </p>
            <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
              {needsSetup ? 'Créer le compte administrateur' : 'Connexion au studio'}
            </h2>
            <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
              {needsSetup
                ? 'Définissez le premier administrateur pour verrouiller l’accès et gérer vos connexions SQL Server.'
                : hasEnvAdminOverride
                ? 'Connectez-vous avec un compte utilisateur ou le code d’accès administrateur configuré.'
                : 'Saisissez vos identifiants pour accéder à vos tableaux de bord.'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {needsSetup && (
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Nom complet
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  placeholder="Ex. Marc Lefèvre"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Adresse e-mail
              </label>
              <input
                type="email"
                required={!hasEnvAdminOverride}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                placeholder="utilisateur@entreprise.fr"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Mot de passe
              </label>
              <input
                type="password"
                required
                minLength={needsSetup ? 8 : 1}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                placeholder={needsSetup ? 'Minimum 8 caractères' : '••••••••'}
              />
            </div>

            {needsSetup && (
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Confirmer le mot de passe
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  placeholder="Répétez le mot de passe"
                />
              </div>
            )}

            {error && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <UserCheck className="w-4 h-4" />
              <span>
                {loading
                  ? 'Validation en cours...'
                  : needsSetup
                  ? 'Initialiser et ouvrir le studio'
                  : 'Se connecter'}
              </span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
