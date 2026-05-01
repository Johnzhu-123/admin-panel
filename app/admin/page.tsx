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
  LogOut
} from 'lucide-react';
import { AdminUserManagement } from '@/components/admin/user-management';
import { AdminDashboardCharts } from '@/components/admin/dashboard-charts';
import { AdminSystemHealth } from '@/components/admin/system-health';
import { AdminLogin } from '@/components/admin/admin-login';
import { AdminServiceCatalogManager } from '@/components/admin/service-catalog-management';

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
  iopaintUrls: string[];
  updatePageUrl: string;
  downloadChannels: Array<{
    id: string;
    name: string;
    url: string;
  }>;
}

interface IopaintHealthResult {
  url: string;
  ok: boolean;
  severity: 'ok' | 'warn' | 'error';
  status?: number;
  message: string;
  detail?: string;
}

const normalizeIopaintUrl = (value?: string) => (value || '').trim().replace(/\/+$/, '');
const normalizeChannelId = (value?: string) =>
  (value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
const normalizeChannelName = (value?: string) => (value || '').trim().slice(0, 40);

const parseIopaintUrlsInput = (raw: unknown) => {
  const text = Array.isArray(raw) ? raw.join('\n') : String(raw || '');
  return Array.from(
    new Set(
      text
        .split(/[\n,;]/)
        .map((item) => normalizeIopaintUrl(item))
        .filter((item) => /^https?:\/\//i.test(item))
      )
  );
};

const parseDownloadChannelsInput = (raw: unknown) => {
  if (!Array.isArray(raw)) return [] as Array<{ id: string; name: string; url: string }>;
  const seen = new Set<string>();
  const channels: Array<{ id: string; name: string; url: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = normalizeIopaintUrl(String(record.url || ''));
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

export default function AdminDashboard() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [systemSettings, setSystemSettings] = useState<RuntimeSystemSettings>({
    serviceGatewayUrl: 'https://ppt2admin.zeabur.app',
    iopaintUrls: [],
    updatePageUrl: '',
    downloadChannels: [],
  });
  const [iopaintUrlsText, setIopaintUrlsText] = useState('');
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [iopaintImportText, setIopaintImportText] = useState('');
  const [pendingIopaintUrls, setPendingIopaintUrls] = useState<string[]>([]);
  const [iopaintVerifiedUrls, setIopaintVerifiedUrls] = useState<string[]>([]);
  const [iopaintHealthChecking, setIopaintHealthChecking] = useState(false);
  const [iopaintHealthResults, setIopaintHealthResults] = useState<IopaintHealthResult[]>([]);

  useEffect(() => {
    checkAuthentication();
  }, []);

  useEffect(() => {
    if (authenticated) {
      fetchOverview();
      fetchSystemSettings();
      // Refresh every 30 seconds
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
        body: JSON.stringify({ password })
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
      if (!response.ok) {
        throw new Error('Failed to fetch dashboard data');
      }
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
        serviceGatewayUrl:
          typeof settings.serviceGatewayUrl === 'string' && settings.serviceGatewayUrl.trim()
            ? settings.serviceGatewayUrl.trim()
            : 'https://ppt2admin.zeabur.app',
        iopaintUrls: Array.isArray(settings.iopaintUrls)
          ? settings.iopaintUrls.filter((item: unknown) => typeof item === 'string' && item.trim())
          : [],
        updatePageUrl:
          typeof settings.updatePageUrl === 'string' && settings.updatePageUrl.trim()
            ? normalizeIopaintUrl(settings.updatePageUrl)
            : '',
        downloadChannels: parsedChannels,
      };
      setSystemSettings(next);
      setIopaintUrlsText(next.iopaintUrls.join('\n'));
      setIopaintVerifiedUrls([]);
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
    const normalizedUrl = normalizeIopaintUrl(url);
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

  const handleSaveSystemSettings = async () => {
    try {
      setSettingsSaving(true);
      setSettingsMessage(null);
      const iopaintUrls = parseIopaintUrlsInput(iopaintUrlsText);
      const response = await fetch('/api/admin/system-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceGatewayUrl: normalizeIopaintUrl(systemSettings.serviceGatewayUrl),
          iopaintUrls,
          updatePageUrl: normalizeIopaintUrl(systemSettings.updatePageUrl),
          downloadChannels: systemSettings.downloadChannels.filter((item) => /^https?:\/\//i.test(item.url)),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || '保存系统设置失败');
      const settings = data?.settings || {};
      const parsedChannels = parseDownloadChannelsInput(settings.downloadChannels);
      const next: RuntimeSystemSettings = {
        serviceGatewayUrl:
          typeof settings.serviceGatewayUrl === 'string' && settings.serviceGatewayUrl.trim()
            ? normalizeIopaintUrl(settings.serviceGatewayUrl)
            : normalizeIopaintUrl(systemSettings.serviceGatewayUrl),
        iopaintUrls: Array.isArray(settings.iopaintUrls) ? settings.iopaintUrls : iopaintUrls,
        updatePageUrl:
          typeof settings.updatePageUrl === 'string'
            ? normalizeIopaintUrl(settings.updatePageUrl)
            : normalizeIopaintUrl(systemSettings.updatePageUrl),
        downloadChannels: parsedChannels,
      };
      setSystemSettings(next);
      setIopaintUrlsText(next.iopaintUrls.join('\n'));
      setSettingsMessage('系统设置已保存');
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : '保存系统设置失败');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleImportPendingIopaintUrls = () => {
    const imported = parseIopaintUrlsInput(iopaintImportText);
    if (!imported.length) {
      setSettingsMessage('请先输入至少一个待测 IOPaint 地址。');
      return;
    }
    const merged = Array.from(new Set([...pendingIopaintUrls, ...imported]));
    setPendingIopaintUrls(merged);
    setIopaintImportText('');
    setIopaintHealthResults([]);
    setIopaintVerifiedUrls([]);
    setSettingsMessage(`已导入 ${imported.length} 个待测地址，当前待测池 ${merged.length} 个。`);
  };

  const handleClearPendingIopaintUrls = () => {
    setPendingIopaintUrls([]);
    setIopaintHealthResults([]);
    setIopaintVerifiedUrls([]);
    setSettingsMessage('待测地址已清空。');
  };

  const handleInjectHealthyIopaintUrls = async () => {
    const healthy = Array.from(new Set(iopaintVerifiedUrls.map((url) => normalizeIopaintUrl(url)).filter(Boolean)));
    if (!healthy.length) {
      setSettingsMessage('暂无可注入地址。请先批量测活并确保存在可用地址。');
      return;
    }

    try {
      setSettingsSaving(true);
      setSettingsMessage(null);
      const response = await fetch('/api/admin/system-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceGatewayUrl: normalizeIopaintUrl(systemSettings.serviceGatewayUrl),
          iopaintUrls: healthy,
          updatePageUrl: normalizeIopaintUrl(systemSettings.updatePageUrl),
          downloadChannels: systemSettings.downloadChannels.filter((item) => /^https?:\/\//i.test(item.url)),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || '注入可用地址失败');

      const settings = data?.settings || {};
      const parsedChannels = parseDownloadChannelsInput(settings.downloadChannels);
      const next: RuntimeSystemSettings = {
        serviceGatewayUrl:
          typeof settings.serviceGatewayUrl === 'string' && settings.serviceGatewayUrl.trim()
            ? normalizeIopaintUrl(settings.serviceGatewayUrl)
            : normalizeIopaintUrl(systemSettings.serviceGatewayUrl),
        iopaintUrls: Array.isArray(settings.iopaintUrls) ? settings.iopaintUrls : healthy,
        updatePageUrl:
          typeof settings.updatePageUrl === 'string'
            ? normalizeIopaintUrl(settings.updatePageUrl)
            : normalizeIopaintUrl(systemSettings.updatePageUrl),
        downloadChannels: parsedChannels,
      };
      setSystemSettings(next);
      setIopaintUrlsText(next.iopaintUrls.join('\n'));
      setSettingsMessage(`已将 ${next.iopaintUrls.length} 个可用地址注入到 IOPaint 地址池。`);
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : '注入可用地址失败');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleBatchCheckIopaintHealth = async () => {
    const urls = pendingIopaintUrls.length
      ? pendingIopaintUrls
      : parseIopaintUrlsInput(iopaintImportText);

    if (!urls.length) {
      setSettingsMessage('请先导入待测 IOPaint 地址。');
      setIopaintHealthResults([]);
      setIopaintVerifiedUrls([]);
      return;
    }
    try {
      setIopaintHealthChecking(true);
      setSettingsMessage(`正在检测 ${urls.length} 个 IOPaint 地址...`);
      const response = await fetch('/api/ppt/ocr/iopaint-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      const data = await response.json().catch(() => ({}));
      const results = Array.isArray(data?.results)
        ? data.results.map((item: any) => ({
            url: String(item?.url || ''),
            ok: !!item?.ok,
            severity: (item?.severity || 'error') as 'ok' | 'warn' | 'error',
            status: typeof item?.status === 'number' ? item.status : undefined,
            message: String(item?.message || item?.error || '检测失败'),
            detail: typeof item?.detail === 'string' ? item.detail : '',
          }))
        : [];
      const healthyUrls = results
        .filter((item: IopaintHealthResult) => item.ok)
        .map((item: IopaintHealthResult) => item.url);
      setIopaintHealthResults(results);
      setIopaintVerifiedUrls(Array.from(new Set(healthyUrls)));
      if (!response.ok) {
        setSettingsMessage(data?.error || `批量检测失败（HTTP ${response.status}）`);
        return;
      }
      setSettingsMessage(
        typeof data?.message === 'string' && data.message
          ? data.message
          : `批量检测完成，共 ${results.length} 个地址，可注入 ${healthyUrls.length} 个。`
      );
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : '批量检测失败');
    } finally {
      setIopaintHealthChecking(false);
    }
  };

  // 显示登录页面
  if (authenticated === false) {
    return <AdminLogin onLogin={handleLogin} />;
  }

  // 显示加载状态
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
      {/* Header with gradient overlay */}
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
        {/* Overview Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-10 mt-6">
          <Card className="bg-slate-800/50 border-slate-700/70 backdrop-blur-sm hover:bg-slate-800/70 transition-all duration-200 shadow-lg hover:shadow-xl hover:-translate-y-0.5">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-slate-300">总用户数</CardTitle>
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

        {/* Main Content Tabs */}
        <Card className="bg-slate-900/50 border-slate-700/60 backdrop-blur-sm shadow-xl rounded-2xl">
          <Tabs defaultValue="users" className="w-full">
            <div className="border-b border-slate-700">
              <TabsList className="grid w-full grid-cols-4 bg-slate-900/40 h-auto p-0 rounded-t-2xl overflow-hidden">
                <TabsTrigger 
                  value="users" 
                  className="flex items-center gap-2 py-4 px-6 data-[state=active]:bg-slate-700/50 data-[state=active]:text-white text-slate-400 hover:text-white transition-all duration-200 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-500"
                >
                  <Users className="h-4 w-4" />
                  用户管理
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
                  <AdminServiceCatalogManager />
                  <Card className="bg-slate-800/50 border-slate-700">
                  <CardHeader>
                    <CardTitle className="text-white">系统设置</CardTitle>
                    <CardDescription className="text-slate-400">
                      管理内置服务网关与 IOPaint 地址池，统一下发到桌面端。
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="space-y-4">
                      <div className="p-6 bg-slate-700/30 border border-slate-600 rounded-lg space-y-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-blue-500/20 rounded-lg">
                            <Settings className="h-5 w-5 text-blue-400" />
                          </div>
                          <h3 className="font-semibold text-white">服务根地址</h3>
                        </div>
                        <input
                          className="w-full bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                          value={systemSettings.serviceGatewayUrl}
                          onChange={(event) =>
                            setSystemSettings((prev) => ({
                              ...prev,
                              serviceGatewayUrl: event.target.value,
                            }))
                          }
                          placeholder="https://ppt2admin.zeabur.app"
                        />
                        <p className="text-xs text-slate-400">
                          桌面端会默认使用此地址作为内置 API 网关，用户侧无需手动填写。
                        </p>
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
                          保存后将下发到客户端“下载更新”入口，用户可一键跳转到你维护的发布页。
                        </p>
                      </div>

                      <div className="p-6 bg-slate-700/30 border border-slate-600 rounded-lg space-y-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-green-500/20 rounded-lg">
                            <Server className="h-5 w-5 text-green-400" />
                          </div>
                          <h3 className="font-semibold text-white">可用 IOPaint 接口地址池（最终生效）</h3>
                        </div>
                        <textarea
                          className="w-full min-h-28 bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                          value={iopaintUrlsText}
                          readOnly
                          placeholder={"http://127.0.0.1:8080/api/v1/inpaint\nhttps://your-iopaint-2/api/v1/inpaint"}
                        />
                        <p className="text-xs text-slate-400">
                          该地址池由“待测导入 → 批量测活 → 一键注入”流程生成，并实时下发到桌面端。
                        </p>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="p-4 bg-slate-700/20 border border-slate-600 rounded-lg space-y-3">
                          <h4 className="font-medium text-slate-200">导入待测地址（单个或批量）</h4>
                          <textarea
                            className="w-full min-h-24 bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                            value={iopaintImportText}
                            onChange={(event) => setIopaintImportText(event.target.value)}
                            placeholder={"http://127.0.0.1:8080/api/v1/inpaint\nhttps://example.com/api/v1/inpaint"}
                          />
                          <div className="flex items-center gap-2">
                            <Button
                              onClick={handleImportPendingIopaintUrls}
                              disabled={settingsSaving || settingsLoading}
                              className="bg-green-600 hover:bg-green-700"
                            >
                              导入待测池
                            </Button>
                            <Button
                              variant="outline"
                              onClick={handleClearPendingIopaintUrls}
                              disabled={settingsSaving || settingsLoading}
                              className="border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
                            >
                              清空待测池
                            </Button>
                          </div>
                        </div>
                        <div className="p-4 bg-slate-700/20 border border-slate-600 rounded-lg space-y-3">
                          <h4 className="font-medium text-slate-200">当前待测地址池（{pendingIopaintUrls.length}）</h4>
                          <textarea
                            className="w-full min-h-24 bg-slate-900/70 border border-slate-600 rounded-md px-3 py-2 text-slate-100"
                            value={pendingIopaintUrls.join('\n')}
                            readOnly
                            placeholder={"待测地址池为空，请先导入地址"}
                          />
                          <p className="text-xs text-slate-400">
                            仅会检测这里的地址，检测通过后再注入到“可用地址池”。
                          </p>
                        </div>
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
                        <Button
                          variant="outline"
                          onClick={handleBatchCheckIopaintHealth}
                          disabled={settingsSaving || settingsLoading || iopaintHealthChecking || pendingIopaintUrls.length === 0}
                          className="border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
                        >
                          {iopaintHealthChecking ? '测活中...' : '一键测活待测地址'}
                        </Button>
                        <Button
                          onClick={handleInjectHealthyIopaintUrls}
                          disabled={settingsSaving || settingsLoading || iopaintVerifiedUrls.length === 0}
                          className="bg-emerald-600 hover:bg-emerald-700"
                        >
                          一键注入可用地址池（{iopaintVerifiedUrls.length}）
                        </Button>
                        {settingsLoading && <span className="text-xs text-slate-400">加载中...</span>}
                        {settingsMessage && <span className="text-xs text-slate-300">{settingsMessage}</span>}
                      </div>
                      {iopaintHealthResults.length > 0 && (
                        <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
                          {iopaintHealthResults.map((item) => (
                            <div
                              key={item.url}
                              className={
                                item.severity === 'ok'
                                  ? 'text-xs text-green-300'
                                  : item.severity === 'warn'
                                    ? 'text-xs text-amber-300'
                                    : 'text-xs text-red-300'
                              }
                            >
                              [{item.severity.toUpperCase()}] {item.url} · {item.message}
                              {typeof item.status === 'number' ? ` (HTTP ${item.status})` : ''}
                            </div>
                          ))}
                        </div>
                      )}
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
