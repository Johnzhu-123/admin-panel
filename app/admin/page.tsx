'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Users,
  Activity,
  Server,
  TrendingUp,
  Settings,
  AlertCircle,
  CheckCircle,
  Clock,
  BarChart3,
  Shield,
  Zap,
  LogOut,
} from 'lucide-react';
import { AdminUserManagement } from '@/components/admin/user-management';
import { AdminDashboardCharts } from '@/components/admin/dashboard-charts';
import { AdminSystemHealth } from '@/components/admin/system-health';
import { AdminLogin } from '@/components/admin/admin-login';
import { ServiceCatalogManagement } from '@/components/admin/service-catalog-management';

interface DashboardOverview {
  totalUsers: number;
  activeUsers: number;
  totalServices: number;
  availableServices: number;
  systemHealth: boolean;
  totalRequests: number;
  successRate: number;
  averageResponseTime: number;
  requestsLast24h?: number;
  averageResponseTimeLast24h?: number;
  lastUpdated: string;
}

interface RuntimeSystemSettings {
  serviceGatewayUrl: string;
  updatePageUrl: string;
  downloadChannels: Array<{
    id: string;
    name: string;
    url: string;
  }>;
  mineru: MinerUAdminSettings;
}

interface MinerUAdminSettings {
  enabled: boolean;
  baseUrl: string;
  apiToken: string;
  apiTokenConfigured: boolean;
  apiTokenMask: string;
  defaultOptions: {
    modelVersion: 'vlm' | 'pipeline' | 'MinerU-HTML' | 'auto';
    language: string;
    enableFormula: boolean;
    enableTable: boolean;
    isOcr: boolean;
    extraFormats: Array<'docx' | 'html' | 'latex'>;
  };
}

const DEFAULT_MINERU_ADMIN_SETTINGS: MinerUAdminSettings = {
  enabled: true,
  baseUrl: 'https://mineru.net',
  apiToken: '',
  apiTokenConfigured: false,
  apiTokenMask: '',
  defaultOptions: {
    modelVersion: 'vlm',
    language: 'ch',
    enableFormula: true,
    enableTable: true,
    isOcr: false,
    extraFormats: [],
  },
};

const normalizeUrl = (value?: string) => (value || '').trim().replace(/\/+$/, '');
const normalizeChannelId = (value?: string) =>
  (value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
const normalizeChannelName = (value?: string) => (value || '').trim().slice(0, 40);

const parseDownloadChannelsInput = (raw: unknown) => {
  if (!Array.isArray(raw)) return [] as Array<{ id: string; name: string; url: string }>;
  const seen = new Set<string>();
  const channels: Array<{ id: string; name: string; url: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = normalizeUrl(String(record.url || ''));
    if (!/^https?:\/\//i.test(url)) continue;
    const id = normalizeChannelId(String(record.id || '')) || `link_${channels.length + 1}`;
    const name = normalizeChannelName(String(record.name || '')) || id;
    const key = `${id}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    channels.push({ id, name, url });
  }
  return channels;
};

const parseMinerUSettingsInput = (raw: unknown): MinerUAdminSettings => {
  if (!raw || typeof raw !== 'object') return DEFAULT_MINERU_ADMIN_SETTINGS;
  const record = raw as Partial<MinerUAdminSettings>;
  const defaults = (record.defaultOptions || {}) as Partial<MinerUAdminSettings['defaultOptions']>;
  const modelVersion =
    defaults.modelVersion === 'pipeline' ||
    defaults.modelVersion === 'MinerU-HTML' ||
    defaults.modelVersion === 'auto' ||
    defaults.modelVersion === 'vlm'
      ? defaults.modelVersion
      : DEFAULT_MINERU_ADMIN_SETTINGS.defaultOptions.modelVersion;
  const extraFormats = Array.isArray(defaults.extraFormats)
    ? defaults.extraFormats.filter((item): item is 'docx' | 'html' | 'latex' =>
        item === 'docx' || item === 'html' || item === 'latex'
      )
    : [];
  return {
    enabled: record.enabled !== false,
    baseUrl:
      typeof record.baseUrl === 'string' && record.baseUrl.trim()
        ? normalizeUrl(record.baseUrl)
        : DEFAULT_MINERU_ADMIN_SETTINGS.baseUrl,
    apiToken: '',
    apiTokenConfigured: Boolean(record.apiTokenConfigured),
    apiTokenMask: typeof record.apiTokenMask === 'string' ? record.apiTokenMask : '',
    defaultOptions: {
      modelVersion,
      language:
        typeof defaults.language === 'string' && defaults.language.trim()
          ? defaults.language.trim()
          : DEFAULT_MINERU_ADMIN_SETTINGS.defaultOptions.language,
      enableFormula:
        typeof defaults.enableFormula === 'boolean'
          ? defaults.enableFormula
          : DEFAULT_MINERU_ADMIN_SETTINGS.defaultOptions.enableFormula,
      enableTable:
        typeof defaults.enableTable === 'boolean'
          ? defaults.enableTable
          : DEFAULT_MINERU_ADMIN_SETTINGS.defaultOptions.enableTable,
      isOcr:
        typeof defaults.isOcr === 'boolean'
          ? defaults.isOcr
          : DEFAULT_MINERU_ADMIN_SETTINGS.defaultOptions.isOcr,
      extraFormats: Array.from(new Set(extraFormats)),
    },
  };
};

export default function AdminDashboard() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [systemSettings, setSystemSettings] = useState<RuntimeSystemSettings>({
    // 🔧 FIX (2026-05 #19): serviceGatewayUrl 是「上游 AI 网关」（如
    //   api.seeyjys.eu.org），不是 admin-panel URL（ppt2admin.onrender.com）。
    //   初始 state 留空，等 fetchSystemSettings 拉到正确值再显示。
    serviceGatewayUrl: '',
    updatePageUrl: '',
    downloadChannels: [],
    mineru: DEFAULT_MINERU_ADMIN_SETTINGS,
  });
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);

  useEffect(() => {
    checkAuthentication();
  }, []);

  useEffect(() => {
    if (authenticated) {
      fetchOverview();
      fetchSystemSettings();
      const interval = setInterval(fetchOverview, 30000);
      return () => clearInterval(interval);
    }
  }, [authenticated]);

  const checkAuthentication = async () => {
    try {
      const response = await fetch('/api/admin/auth');
      const data = await response.json();
      setAuthenticated(data.authenticated);
    } catch (err) {
      setAuthenticated(false);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (password: string): Promise<boolean> => {
    try {
      const response = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await response.json();
      if (data.success) {
        setAuthenticated(true);
        return true;
      }
      return false;
    } catch (err) {
      return false;
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/admin/auth', { method: 'DELETE' });
      setAuthenticated(false);
      setOverview(null);
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const fetchOverview = async () => {
    try {
      const response = await fetch('/api/admin/dashboard?action=overview', { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed to fetch dashboard data');
      const data = await response.json();
      setOverview(data.overview);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const fetchSystemSettings = async () => {
    try {
      setSettingsLoading(true);
      const response = await fetch('/api/admin/system-settings', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || '加载系统设置失败');
      const settings = data?.settings || {};
      const parsedChannels = parseDownloadChannelsInput(settings.downloadChannels);
      const next: RuntimeSystemSettings = {
        // 🔧 FIX (2026-05 #19): 拉不到时留空，避免错把 admin-panel URL 当 gateway URL
        serviceGatewayUrl:
          typeof settings.serviceGatewayUrl === 'string' && settings.serviceGatewayUrl.trim()
            ? settings.serviceGatewayUrl.trim()
            : '',
        updatePageUrl:
          typeof settings.updatePageUrl === 'string' && settings.updatePageUrl.trim()
            ? normalizeUrl(settings.updatePageUrl)
            : '',
        downloadChannels: parsedChannels,
        mineru: parseMinerUSettingsInput(settings.mineru),
      };
      setSystemSettings(next);
      setSettingsMessage(null);
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : '加载系统设置失败');
    } finally {
      setSettingsLoading(false);
    }
  };

  const upsertDownloadChannel = (id: string, name: string, url: string) => {
    const normalizedId = normalizeChannelId(id);
    if (!normalizedId) return;
    const normalizedName = normalizeChannelName(name) || normalizedId;
    const normalizedUrl = normalizeUrl(url);
    setSystemSettings((prev) => {
      const next = prev.downloadChannels.filter((item) => item.id !== normalizedId);
      if (/^https?:\/\//i.test(normalizedUrl)) {
        next.push({ id: normalizedId, name: normalizedName, url: normalizedUrl });
      }
      return { ...prev, downloadChannels: next };
    });
  };

  const getDownloadChannelUrl = (id: string) =>
    systemSettings.downloadChannels.find((item) => item.id === normalizeChannelId(id))?.url || '';

  const updateMinerUSettings = (patch: Partial<MinerUAdminSettings>) => {
    setSystemSettings((prev) => ({
      ...prev,
      mineru: {
        ...prev.mineru,
        ...patch,
        defaultOptions: {
          ...prev.mineru.defaultOptions,
          ...(patch.defaultOptions || {}),
        },
      },
    }));
  };

  const toggleMinerUExtraFormat = (format: 'docx' | 'html' | 'latex') => {
    setSystemSettings((prev) => {
      const existing = new Set(prev.mineru.defaultOptions.extraFormats);
      if (existing.has(format)) existing.delete(format);
      else existing.add(format);
      return {
        ...prev,
        mineru: {
          ...prev.mineru,
          defaultOptions: {
            ...prev.mineru.defaultOptions,
            extraFormats: Array.from(existing),
          },
        },
      };
    });
  };

  const handleSaveSystemSettings = async () => {
    try {
      setSettingsSaving(true);
      setSettingsMessage(null);
      const response = await fetch('/api/admin/system-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceGatewayUrl: normalizeUrl(systemSettings.serviceGatewayUrl),
          updatePageUrl: normalizeUrl(systemSettings.updatePageUrl),
          downloadChannels: systemSettings.downloadChannels.filter((item) =>
            /^https?:\/\//i.test(item.url)
          ),
          mineru: {
            enabled: systemSettings.mineru.enabled,
            baseUrl: normalizeUrl(systemSettings.mineru.baseUrl),
            ...(systemSettings.mineru.apiToken.trim()
              ? { apiToken: systemSettings.mineru.apiToken.trim() }
              : {}),
            defaultOptions: systemSettings.mineru.defaultOptions,
          },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || '保存系统设置失败');
      const settings = data?.settings || {};
      const parsedChannels = parseDownloadChannelsInput(settings.downloadChannels);
      setSystemSettings({
        serviceGatewayUrl:
          typeof settings.serviceGatewayUrl === 'string' && settings.serviceGatewayUrl.trim()
            ? normalizeUrl(settings.serviceGatewayUrl)
            : normalizeUrl(systemSettings.serviceGatewayUrl),
        updatePageUrl:
          typeof settings.updatePageUrl === 'string'
            ? normalizeUrl(settings.updatePageUrl)
            : normalizeUrl(systemSettings.updatePageUrl),
        downloadChannels: parsedChannels,
        mineru: parseMinerUSettingsInput(settings.mineru),
      });
      setSettingsMessage('系统设置已保存');
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : '保存系统设置失败');
    } finally {
      setSettingsSaving(false);
    }
  };

  if (authenticated === false) {
    return <AdminLogin onLogin={handleLogin} />;
  }

  if (loading || authenticated === null) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="flex flex-col items-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-2 border-blue-500 border-t-transparent"></div>
          <p className="text-slate-400 text-sm">验证身份中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
        <Card className="w-full max-w-md bg-slate-800/50 border-slate-700 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-400">
              <AlertCircle className="h-5 w-5" />
              连接错误
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-slate-300">{error}</p>
            <Button onClick={fetchOverview} className="w-full bg-blue-600 hover:bg-blue-700">
              重新连接
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="relative">
        <div className="absolute inset-0 bg-gradient-to-r from-blue-600/20 to-purple-600/20"></div>
        <div className="relative px-6 py-8">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">
                  内置API服务管理中心
                </h1>
                <p className="text-slate-300 text-lg">
                  实时监控系统状态，管理用户权限和使用统计
                </p>
              </div>
              <div className="flex items-center space-x-4">
                <div className="flex items-center space-x-2 bg-slate-800/50 backdrop-blur-sm rounded-lg px-4 py-2 border border-slate-700">
                  {overview?.systemHealth ? (
                    <>
                      <CheckCircle className="h-4 w-4 text-green-400" />
                      <span className="text-green-400 font-medium">系统正常</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="h-4 w-4 text-red-400" />
                      <span className="text-red-400 font-medium">系统异常</span>
                    </>
                  )}
                </div>
                <Button
                  variant="outline"
                  onClick={handleLogout}
                  className="border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  退出登录
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 pb-10 pt-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-10 mt-6">
          <Card className="bg-slate-800/50 border-slate-700/70 backdrop-blur-sm hover:bg-slate-800/70 transition-all duration-200 shadow-lg hover:shadow-xl hover:-translate-y-0.5">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-slate-300">授权用户数</CardTitle>
              <div className="p-2 bg-blue-500/20 rounded-lg">
                <Users className="h-4 w-4 text-blue-400" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-white mb-1">{overview?.totalUsers || 0}</div>
              <p className="text-xs text-slate-400 flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />
                活跃用户: {overview?.activeUsers || 0}
              </p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700/70 backdrop-blur-sm hover:bg-slate-800/70 transition-all duration-200 shadow-lg hover:shadow-xl hover:-translate-y-0.5">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-slate-300">系统状态</CardTitle>
              <div className="p-2 bg-green-500/20 rounded-lg">
                <Server className="h-4 w-4 text-green-400" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 mb-1">
                {overview?.systemHealth ? (
                  <span className="text-3xl font-bold text-green-400">健康</span>
                ) : (
                  <span className="text-3xl font-bold text-red-400">异常</span>
                )}
              </div>
              <p className="text-xs text-slate-400 flex items-center gap-1">
                <Shield className="h-3 w-3" />
                可用服务: {overview?.availableServices || 0}/{overview?.totalServices || 0}
              </p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700/70 backdrop-blur-sm hover:bg-slate-800/70 transition-all duration-200 shadow-lg hover:shadow-xl hover:-translate-y-0.5">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-slate-300">总请求数</CardTitle>
              <div className="p-2 bg-purple-500/20 rounded-lg">
                <Activity className="h-4 w-4 text-purple-400" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-white mb-1">{overview?.totalRequests || 0}</div>
              <p className="text-xs text-slate-400 flex items-center gap-1">
                <CheckCircle className="h-3 w-3" />
                近24小时请求数: {overview?.requestsLast24h || 0}
              </p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700/70 backdrop-blur-sm hover:bg-slate-800/70 transition-all duration-200 shadow-lg hover:shadow-xl hover:-translate-y-0.5">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-slate-300">平均响应时间</CardTitle>
              <div className="p-2 bg-orange-500/20 rounded-lg">
                <Clock className="h-4 w-4 text-orange-400" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-white mb-1">
                {overview?.averageResponseTime || 0}ms
              </div>
              <p className="text-xs text-slate-400 flex items-center gap-1">
                <Zap className="h-3 w-3" />
                近24小时平均响应时间: {overview?.averageResponseTimeLast24h || 0}ms
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-slate-900/50 border-slate-700/60 backdrop-blur-sm shadow-xl rounded-2xl">
          <Tabs defaultValue="users" className="w-full">
            <div className="border-b border-slate-700">
              <TabsList className="grid w-full grid-cols-4 bg-slate-900/40 h-auto p-0 rounded-t-2xl overflow-hidden">
                <TabsTrigger
                  value="users"
                  className="flex items-center gap-2 py-4 px-6 data-[state=active]:bg-slate-700/50 data-[state=active]:text-white text-slate-400 hover:text-white transition-all duration-200 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-500"
                >
                  <Users className="h-4 w-4" />
                  授权用户管理
                </TabsTrigger>
                <TabsTrigger
                  value="analytics"
                  className="flex items-center gap-2 py-4 px-6 data-[state=active]:bg-slate-700/50 data-[state=active]:text-white text-slate-400 hover:text-white transition-all duration-200 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-500"
                >
                  <BarChart3 className="h-4 w-4" />
                  使用统计
                </TabsTrigger>
                <TabsTrigger
                  value="health"
                  className="flex items-center gap-2 py-4 px-6 data-[state=active]:bg-slate-700/50 data-[state=active]:text-white text-slate-400 hover:text-white transition-all duration-200 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-500"
                >
                  <Activity className="h-4 w-4" />
                  系统健康
                </TabsTrigger>
                <TabsTrigger
                  value="settings"
                  className="flex items-center gap-2 py-4 px-6 data-[state=active]:bg-slate-700/50 data-[state=active]:text-white text-slate-400 hover:text-white transition-all duration-200 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-500"
                >
                  <Settings className="h-4 w-4" />
                  系统设置
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="p-6">
              <TabsContent value="users" className="mt-0">
                <AdminUserManagement />
              </TabsContent>

              <TabsContent value="analytics" className="mt-0">
                <AdminDashboardCharts />
              </TabsContent>

              <TabsContent value="health" className="mt-0">
                <AdminSystemHealth />
              </TabsContent>

              <TabsContent value="settings" className="mt-0">
                <div className="space-y-6">
                  <ServiceCatalogManagement />
                  <Card className="bg-slate-800/50 border-slate-700">
                    <CardHeader>
                      <CardTitle className="text-white">系统设置</CardTitle>
                      <CardDescription className="text-slate-400">
                        管理内置服务网关与发布页/下载链接，统一下发到桌面端。
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div className="space-y-4">
                        <div className="p-6 bg-slate-700/30 border border-slate-600 rounded-lg space-y-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                              <div className="p-2 bg-emerald-500/20 rounded-lg">
                                <Server className="h-5 w-5 text-emerald-400" />
                              </div>
                              <div>
                                <h3 className="font-semibold text-white">MinerU 文档解析服务</h3>
                                <p className="text-xs text-slate-400">
                                  云端统一持有 MinerU Token，授权用户桌面端无需自行配置。
                                </p>
                              </div>
                            </div>
                            <label className="flex items-center gap-2 text-sm text-slate-300">
                              <input
                                type="checkbox"
                                checked={systemSettings.mineru.enabled}
                                onChange={(event) => updateMinerUSettings({ enabled: event.target.checked })}
                                className="accent-emerald-500"
                              />
                              启用 MinerU 内置云端
                            </label>
                          </div>

                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <label className="text-sm text-slate-300">MinerU BaseURL</label>
                              <input
                                className="w-full bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                                value={systemSettings.mineru.baseUrl}
                                onChange={(event) => updateMinerUSettings({ baseUrl: event.target.value })}
                                placeholder="https://mineru.net"
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm text-slate-300">MinerU Bearer Token</label>
                              <input
                                type="password"
                                className="w-full bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                                value={systemSettings.mineru.apiToken}
                                onChange={(event) => updateMinerUSettings({ apiToken: event.target.value })}
                                placeholder={
                                  systemSettings.mineru.apiTokenConfigured
                                    ? systemSettings.mineru.apiTokenMask || '已配置，留空则保留'
                                    : '粘贴 mineru.net API Token'
                                }
                              />
                              {systemSettings.mineru.apiTokenConfigured && (
                                <p className="text-xs text-slate-500">
                                  已配置 Token：{systemSettings.mineru.apiTokenMask || '已隐藏'}。留空保存会保留原值。
                                </p>
                              )}
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm text-slate-300">默认模型版本</label>
                              <select
                                className="w-full bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                                value={systemSettings.mineru.defaultOptions.modelVersion}
                                onChange={(event) =>
                                  updateMinerUSettings({
                                    defaultOptions: {
                                      ...systemSettings.mineru.defaultOptions,
                                      modelVersion: event.target.value as MinerUAdminSettings['defaultOptions']['modelVersion'],
                                    },
                                  })
                                }
                              >
                                <option value="vlm">vlm</option>
                                <option value="pipeline">pipeline</option>
                                <option value="MinerU-HTML">MinerU-HTML</option>
                                <option value="auto">auto</option>
                              </select>
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm text-slate-300">默认语言</label>
                              <input
                                className="w-full bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                                value={systemSettings.mineru.defaultOptions.language}
                                onChange={(event) =>
                                  updateMinerUSettings({
                                    defaultOptions: {
                                      ...systemSettings.mineru.defaultOptions,
                                      language: event.target.value,
                                    },
                                  })
                                }
                                placeholder="ch / en / japan / korean"
                              />
                            </div>
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="flex flex-wrap gap-4 rounded-md border border-slate-600 bg-slate-900/40 p-3">
                              <label className="flex items-center gap-2 text-sm text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={systemSettings.mineru.defaultOptions.enableFormula}
                                  onChange={(event) =>
                                    updateMinerUSettings({
                                      defaultOptions: {
                                        ...systemSettings.mineru.defaultOptions,
                                        enableFormula: event.target.checked,
                                      },
                                    })
                                  }
                                  className="accent-emerald-500"
                                />
                                公式识别
                              </label>
                              <label className="flex items-center gap-2 text-sm text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={systemSettings.mineru.defaultOptions.enableTable}
                                  onChange={(event) =>
                                    updateMinerUSettings({
                                      defaultOptions: {
                                        ...systemSettings.mineru.defaultOptions,
                                        enableTable: event.target.checked,
                                      },
                                    })
                                  }
                                  className="accent-emerald-500"
                                />
                                表格识别
                              </label>
                              <label className="flex items-center gap-2 text-sm text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={systemSettings.mineru.defaultOptions.isOcr}
                                  onChange={(event) =>
                                    updateMinerUSettings({
                                      defaultOptions: {
                                        ...systemSettings.mineru.defaultOptions,
                                        isOcr: event.target.checked,
                                      },
                                    })
                                  }
                                  className="accent-emerald-500"
                                />
                                强制 OCR
                              </label>
                            </div>
                            <div className="flex flex-wrap gap-4 rounded-md border border-slate-600 bg-slate-900/40 p-3">
                              {(['docx', 'html', 'latex'] as const).map((format) => (
                                <label key={format} className="flex items-center gap-2 text-sm text-slate-300">
                                  <input
                                    type="checkbox"
                                    checked={systemSettings.mineru.defaultOptions.extraFormats.includes(format)}
                                    onChange={() => toggleMinerUExtraFormat(format)}
                                    className="accent-emerald-500"
                                  />
                                  导出 {format}
                                </label>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="p-6 bg-slate-700/30 border border-slate-600 rounded-lg space-y-4">
                          <div className="flex items-center gap-3">
                            <div className="p-2 bg-indigo-500/20 rounded-lg">
                              <Server className="h-5 w-5 text-indigo-400" />
                            </div>
                            <h3 className="font-semibold text-white">更新入口与网盘链接（云端可维护）</h3>
                          </div>
                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2 md:col-span-2">
                              <label className="text-sm text-slate-300">公开发布页（语雀/飞书等）</label>
                              <input
                                className="w-full bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                                value={systemSettings.updatePageUrl}
                                onChange={(event) =>
                                  setSystemSettings((prev) => ({
                                    ...prev,
                                    updatePageUrl: event.target.value,
                                  }))
                                }
                                placeholder="https://your-public-release-page"
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm text-slate-300">OneDrive 下载链接</label>
                              <input
                                className="w-full bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                                value={getDownloadChannelUrl('onedrive')}
                                onChange={(event) =>
                                  upsertDownloadChannel('onedrive', 'OneDrive', event.target.value)
                                }
                                placeholder="https://..."
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm text-slate-300">百度网盘下载链接</label>
                              <input
                                className="w-full bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                                value={getDownloadChannelUrl('baidupan')}
                                onChange={(event) =>
                                  upsertDownloadChannel('baidupan', '百度网盘', event.target.value)
                                }
                                placeholder="https://..."
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm text-slate-300">夸克网盘下载链接</label>
                              <input
                                className="w-full bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                                value={getDownloadChannelUrl('quark')}
                                onChange={(event) =>
                                  upsertDownloadChannel('quark', '夸克网盘', event.target.value)
                                }
                                placeholder="https://..."
                              />
                            </div>
                          </div>
                          <p className="text-xs text-slate-400">
                            保存后将下发到客户端&ldquo;下载更新&rdquo;入口，用户可一键跳转到你维护的发布页。
                          </p>
                        </div>

                        <div className="flex items-center gap-3 flex-wrap">
                          <Button
                            onClick={handleSaveSystemSettings}
                            disabled={settingsSaving || settingsLoading}
                            className="bg-blue-600 hover:bg-blue-700"
                          >
                            {settingsSaving ? '保存中...' : '保存系统设置'}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={fetchSystemSettings}
                            disabled={settingsSaving || settingsLoading}
                            className="border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
                          >
                            刷新
                          </Button>
                          {settingsLoading && <span className="text-xs text-slate-400">加载中...</span>}
                          {settingsMessage && <span className="text-xs text-slate-300">{settingsMessage}</span>}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
            </div>
          </Tabs>
        </Card>
      </div>
    </div>
  );
}
