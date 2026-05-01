'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { 
  UserPlus, 
  Edit, 
  Trash2, 
  XCircle,
  Crown,
  Star,
  User,
  Users,
  RefreshCw,
  Ban,
  CheckCircle,
  AlertTriangle
} from 'lucide-react';

interface User {
  userId: string;
  email: string;
  name: string;
  status: 'active' | 'suspended' | 'expired';
  permissions: {
    canUseBuiltInServices: boolean;
    allowedServices: string[];
    quotaLimits: {
      dailyRequests: number;
      monthlyRequests: number;
      concurrentRequests: number;
    };
    grantedAt: string;
    grantedBy: string;
  };
  usage: {
    dailyUsed: number;
    monthlyUsed: number;
    dailyRemaining: number;
    monthlyRemaining: number;
  };
  stats: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageResponseTime: number;
    lastUsed: string | null;
  };
}

interface ClerkUser {
  clerkId: string;
  userId: string;
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  createdAt: number;
  lastSignInAt: number | null;
  imageUrl: string;
  verified: boolean;
}

export function AdminUserManagement() {
  const [users, setUsers] = useState<User[]>([]);
  const [clerkUsers, setClerkUsers] = useState<ClerkUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingClerkUsers, setLoadingClerkUsers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showClerkUsersDialog, setShowClerkUsersDialog] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [batchUpsertInput, setBatchUpsertInput] = useState('');
  const [batchDeleteInput, setBatchDeleteInput] = useState('');
  const [batchTargetUsersInput, setBatchTargetUsersInput] = useState('');
  const [batchUserType, setBatchUserType] = useState('basic');
  const [batchStatus, setBatchStatus] = useState('keep');
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/admin/dashboard?action=users');
      if (!response.ok) {
        throw new Error('Failed to fetch users');
      }
      const data = await response.json();
      setUsers(data.users || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const fetchClerkUsers = async () => {
    try {
      setLoadingClerkUsers(true);
      const response = await fetch('/api/admin/clerk-users');
      if (!response.ok) {
        throw new Error('Failed to fetch Clerk users');
      }
      const data = await response.json();
      setClerkUsers(data.users || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch Clerk users');
    } finally {
      setLoadingClerkUsers(false);
    }
  };

  const handleAddUserFromClerk = async (clerkUser: ClerkUser, userType: string) => {
    const userTypeQuotas = {
      basic: { daily: 50, monthly: 1000, concurrent: 3 },
      premium: { daily: 200, monthly: 5000, concurrent: 10 },
      vip: { daily: 500, monthly: 15000, concurrent: 20 }
    };

    const quota = userTypeQuotas[userType as keyof typeof userTypeQuotas];
    
    const userData = {
      name: clerkUser.name,
      email: clerkUser.email,
      canUseBuiltInServices: true,
      allowedServices: ['gemini-built-in'],
      quotaLimits: {
        dailyRequests: quota.daily,
        monthlyRequests: quota.monthly,
        concurrentRequests: quota.concurrent
      },
      grantedAt: new Date().toISOString(),
      grantedBy: 'admin'
    };

    try {
      console.log('[Frontend] Adding user:', clerkUser.email, 'with data:', userData);
      
      const response = await fetch('/api/admin/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add-user',
          userId: clerkUser.email,
          userData
        })
      });

      const responseData = await response.json();
      console.log('[Frontend] Response:', responseData);

      if (!response.ok) {
        throw new Error(responseData.details || responseData.error || 'Failed to add user');
      }

      await fetchUsers();
      setShowClerkUsersDialog(false);
      setError(null);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to add user from Clerk';
      console.error('[Frontend] Add user error:', errorMessage);
      setError(errorMessage);
    }
  };
  const handleAddUser = async (userData: any) => {
    try {
      const response = await fetch('/api/admin/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add-user',
          userId: userData.userId,
          userData: {
            name: userData.name,
            email: userData.userId, // userId is the email in manual form
            canUseBuiltInServices: true,
            allowedServices: ['gemini-built-in'],
            quotaLimits: userData.permissions.quotaLimits,
            grantedAt: userData.permissions.grantedAt,
            grantedBy: userData.permissions.grantedBy
          }
        })
      });

      if (!response.ok) {
        throw new Error('Failed to add user');
      }

      await fetchUsers();
      setShowAddDialog(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add user');
    }
  };

  const handleUpdateUser = async (userId: string, userData: any) => {
    try {
      const response = await fetch('/api/admin/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-user',
          userId,
          userData: {
            name: userData.name,
            email: userData.email || userId,
            canUseBuiltInServices: userData.permissions.canUseBuiltInServices,
            allowedServices: userData.permissions.allowedServices,
            quotaLimits: userData.permissions.quotaLimits,
            grantedAt: userData.permissions.grantedAt,
            grantedBy: userData.permissions.grantedBy
          }
        })
      });

      if (!response.ok) {
        throw new Error('Failed to update user');
      }

      await fetchUsers();
      setEditingUser(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    }
  };

  const handleRemoveUser = async (userId: string) => {
    if (!confirm('确定要删除这个用户吗？此操作不可撤销。')) {
      return;
    }

    try {
      const response = await fetch('/api/admin/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'remove-user',
          userId
        })
      });

      if (!response.ok) {
        throw new Error('Failed to remove user');
      }

      await fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove user');
    }
  };

  const handleToggleStatus = async (userId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
    const action = newStatus === 'active' ? '启用' : '禁用';
    
    if (!confirm(`确定要${action}这个用户吗？`)) {
      return;
    }

    try {
      const response = await fetch('/api/admin/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'toggle-status',
          userId,
          status: newStatus
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.details || data.error || `Failed to ${action} user`);
      }

      await fetchUsers();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} user`);
    }
  };

  const parseIdLines = (raw: string) =>
    Array.from(
      new Set(
        raw
          .split(/[\n,;\t ]/)
          .map((item) => item.trim())
          .filter(Boolean)
      )
    );

  const normalizeUserType = (raw: string) => {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'vip') return 'vip';
    if (value === 'premium' || value === 'advanced' || value === '高级') return 'premium';
    return 'basic';
  };

  const handleBatchUpsertUsers = async () => {
    const lines = batchUpsertInput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      setBatchMessage('请先输入批量用户数据。');
      return;
    }

    const users = lines
      .map((line) => line.split(/[,\t，]/).map((item) => item.trim()))
      .filter((parts) => parts[0])
      .map((parts) => ({
        userId: parts[0],
        email: parts[0],
        name: parts[1] || parts[0],
        userType: normalizeUserType(parts[2] || 'basic'),
        status: (parts[3] || 'active').toLowerCase() === 'suspended' ? 'suspended' : 'active',
      }));

    if (!users.length) {
      setBatchMessage('未解析到有效用户。格式：邮箱,姓名,类型,状态');
      return;
    }

    try {
      setBatchLoading(true);
      setBatchMessage(null);
      const response = await fetch('/api/admin/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'batch-upsert-users',
          users,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.details || data?.error || '批量增改失败');
      }
      setBatchMessage(`批量增改完成：成功 ${data.success}，失败 ${data.failed}`);
      await fetchUsers();
    } catch (err) {
      setBatchMessage(err instanceof Error ? err.message : '批量增改失败');
    } finally {
      setBatchLoading(false);
    }
  };

  const handleBatchRemoveUsers = async () => {
    const userIds = parseIdLines(batchDeleteInput);
    if (!userIds.length) {
      setBatchMessage('请先输入要删除的用户ID或邮箱。');
      return;
    }

    try {
      setBatchLoading(true);
      setBatchMessage(null);
      const response = await fetch('/api/admin/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'batch-remove-users',
          userIds,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.details || data?.error || '批量删除失败');
      }
      setBatchMessage(`批量删除完成：成功 ${data.success}，失败 ${data.failed}`);
      await fetchUsers();
    } catch (err) {
      setBatchMessage(err instanceof Error ? err.message : '批量删除失败');
    } finally {
      setBatchLoading(false);
    }
  };

  const handleBatchUpdatePermissions = async () => {
    const userIds = parseIdLines(batchTargetUsersInput);
    if (!userIds.length) {
      setBatchMessage('请先输入要修改权限的用户ID或邮箱。');
      return;
    }

    try {
      setBatchLoading(true);
      setBatchMessage(null);
      const response = await fetch('/api/admin/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'batch-update-user-type',
          userIds,
          userType: batchUserType,
          status: batchStatus === 'keep' ? undefined : batchStatus,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.details || data?.error || '批量权限修改失败');
      }
      setBatchMessage(`批量权限修改完成：成功 ${data.success}，失败 ${data.failed}`);
      await fetchUsers();
    } catch (err) {
      setBatchMessage(err instanceof Error ? err.message : '批量权限修改失败');
    } finally {
      setBatchLoading(false);
    }
  };

  const isUsageAbnormal = (user: User) => {
    const dailyUsagePercent = (user.usage.dailyUsed / user.permissions.quotaLimits.dailyRequests) * 100;
    const monthlyUsagePercent = (user.usage.monthlyUsed / user.permissions.quotaLimits.monthlyRequests) * 100;
    
    // 标记为异常：每日使用超过90%或每月使用超过95%
    return dailyUsagePercent > 90 || monthlyUsagePercent > 95;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">活跃</Badge>;
      case 'suspended':
        return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">暂停</Badge>;
      case 'expired':
        return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">过期</Badge>;
      default:
        return <Badge variant="outline" className="border-slate-600 text-slate-300">{status}</Badge>;
    }
  };

  const getUserTypeFromQuota = (quota: any) => {
    if (quota.dailyRequests >= 500) return 'VIP';
    if (quota.dailyRequests >= 200) return '高级';
    return '基础';
  };

  const getUserTypeIcon = (quota: any) => {
    const type = getUserTypeFromQuota(quota);
    switch (type) {
      case 'VIP':
        return <Crown className="h-4 w-4 text-yellow-400" />;
      case '高级':
        return <Star className="h-4 w-4 text-purple-400" />;
      default:
        return <User className="h-4 w-4 text-blue-400" />;
    }
  };

  const getUserTypeBadge = (quota: any) => {
    const type = getUserTypeFromQuota(quota);
    switch (type) {
      case 'VIP':
        return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">VIP</Badge>;
      case '高级':
        return <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30">高级</Badge>;
      default:
        return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">基础</Badge>;
    }
  };

  if (loading) {
    return (
      <Card className="bg-slate-800/50 border-slate-700">
        <CardContent className="flex items-center justify-center py-12">
          <div className="flex flex-col items-center space-y-4">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent"></div>
            <p className="text-slate-400 text-sm">加载用户数据...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="bg-slate-800/50 border-slate-700">
        <CardHeader>
          <CardTitle className="text-white">批量管理</CardTitle>
          <CardDescription className="text-slate-400">
            支持批量添加、删除、修改授权用户权限。每行一个用户，推荐格式：邮箱,姓名,类型(basic/premium/vip),状态(active/suspended)。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-2">
              <Label className="text-slate-300">批量添加/更新</Label>
              <textarea
                value={batchUpsertInput}
                onChange={(event) => setBatchUpsertInput(event.target.value)}
                placeholder={"user1@example.com,张三,vip,active\nuser2@example.com,李四,premium,suspended"}
                className="w-full min-h-40 rounded-md border border-slate-600 bg-slate-900/70 px-3 py-2 text-sm text-slate-100"
              />
              <Button
                onClick={handleBatchUpsertUsers}
                disabled={batchLoading}
                className="w-full bg-blue-600 hover:bg-blue-700"
              >
                批量添加/更新
              </Button>
            </div>

            <div className="space-y-2">
              <Label className="text-slate-300">批量删除用户</Label>
              <textarea
                value={batchDeleteInput}
                onChange={(event) => setBatchDeleteInput(event.target.value)}
                placeholder={"user1@example.com\nuser2@example.com"}
                className="w-full min-h-40 rounded-md border border-slate-600 bg-slate-900/70 px-3 py-2 text-sm text-slate-100"
              />
              <Button
                onClick={handleBatchRemoveUsers}
                disabled={batchLoading}
                variant="destructive"
                className="w-full"
              >
                批量删除
              </Button>
            </div>

            <div className="space-y-2">
              <Label className="text-slate-300">批量修改权限</Label>
              <textarea
                value={batchTargetUsersInput}
                onChange={(event) => setBatchTargetUsersInput(event.target.value)}
                placeholder={"user1@example.com\nuser2@example.com"}
                className="w-full min-h-24 rounded-md border border-slate-600 bg-slate-900/70 px-3 py-2 text-sm text-slate-100"
              />
              <div className="grid grid-cols-2 gap-2">
                <Select value={batchUserType} onValueChange={setBatchUserType}>
                  <SelectTrigger className="bg-slate-900/70 border-slate-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 border-slate-600">
                    <SelectItem value="basic" className="text-white">基础</SelectItem>
                    <SelectItem value="premium" className="text-white">高级</SelectItem>
                    <SelectItem value="vip" className="text-white">VIP</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={batchStatus} onValueChange={setBatchStatus}>
                  <SelectTrigger className="bg-slate-900/70 border-slate-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 border-slate-600">
                    <SelectItem value="keep" className="text-white">状态不变</SelectItem>
                    <SelectItem value="active" className="text-white">设为活跃</SelectItem>
                    <SelectItem value="suspended" className="text-white">设为暂停</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleBatchUpdatePermissions}
                disabled={batchLoading}
                className="w-full bg-purple-600 hover:bg-purple-700"
              >
                批量修改权限
              </Button>
            </div>
          </div>
          {batchMessage && (
            <div className="rounded-md border border-slate-600 bg-slate-900/70 px-3 py-2 text-sm text-slate-200">
              {batchMessage}
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card className="bg-red-500/10 border-red-500/30">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-400">
              <XCircle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="bg-slate-800/50 border-slate-700">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-white text-xl">用户管理</CardTitle>
              <CardDescription className="text-slate-400">
                管理授权用户的权限和配额设置
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Dialog open={showClerkUsersDialog} onOpenChange={setShowClerkUsersDialog}>
                <DialogTrigger asChild>
                  <Button 
                    variant="outline" 
                    className="flex items-center gap-2 border-slate-600 text-slate-300 hover:bg-slate-700"
                    onClick={fetchClerkUsers}
                  >
                    <Users className="h-4 w-4" />
                    从Clerk选择用户
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-4xl bg-slate-800 border-slate-700">
                  <ClerkUsersDialog
                    users={clerkUsers}
                    loading={loadingClerkUsers}
                    onAddUser={handleAddUserFromClerk}
                    onCancel={() => setShowClerkUsersDialog(false)}
                    onRefresh={fetchClerkUsers}
                    existingUsers={users}
                  />
                </DialogContent>
              </Dialog>
              <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
                <DialogTrigger asChild>
                  <Button className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700">
                    <UserPlus className="h-4 w-4" />
                    手动添加用户
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md bg-slate-800 border-slate-700">
                  <UserForm
                    onSubmit={handleAddUser}
                    onCancel={() => setShowAddDialog(false)}
                  />
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border border-slate-700 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-slate-700 hover:bg-slate-700/30">
                  <TableHead className="text-slate-300">用户信息</TableHead>
                  <TableHead className="text-slate-300">状态</TableHead>
                  <TableHead className="text-slate-300">用户类型</TableHead>
                  <TableHead className="text-slate-300">配额使用</TableHead>
                  <TableHead className="text-slate-300">统计信息</TableHead>
                  <TableHead className="text-slate-300">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => {
                  const isAbnormal = isUsageAbnormal(user);
                  return (
                    <TableRow 
                      key={user.userId} 
                      className={`border-slate-700 hover:bg-slate-700/20 ${isAbnormal ? 'bg-red-900/10' : ''}`}
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-slate-700/50 rounded-lg">
                            {getUserTypeIcon(user.permissions.quotaLimits)}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-white">{user.name}</span>
                              {isAbnormal && (
                                <AlertTriangle className="h-4 w-4 text-red-400" />
                              )}
                            </div>
                            <div className="text-sm text-slate-400">{user.email}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {getStatusBadge(user.status)}
                      </TableCell>
                      <TableCell>
                        {getUserTypeBadge(user.permissions.quotaLimits)}
                      </TableCell>
                      <TableCell>
                        <div className="space-y-3">
                          <div>
                            <div className="flex justify-between text-sm mb-1">
                              <span className="text-slate-400">每日</span>
                              <span className={`text-slate-300 ${(user.usage.dailyUsed / user.permissions.quotaLimits.dailyRequests) > 0.9 ? 'text-red-400 font-bold' : ''}`}>
                                {user.usage.dailyUsed}/{user.permissions.quotaLimits.dailyRequests}
                              </span>
                            </div>
                            <Progress 
                              value={(user.usage.dailyUsed / user.permissions.quotaLimits.dailyRequests) * 100} 
                              className={`h-2 ${(user.usage.dailyUsed / user.permissions.quotaLimits.dailyRequests) > 0.9 ? 'bg-red-900' : 'bg-slate-700'}`}
                            />
                          </div>
                          <div>
                            <div className="flex justify-between text-sm mb-1">
                              <span className="text-slate-400">每月</span>
                              <span className={`text-slate-300 ${(user.usage.monthlyUsed / user.permissions.quotaLimits.monthlyRequests) > 0.95 ? 'text-red-400 font-bold' : ''}`}>
                                {user.usage.monthlyUsed}/{user.permissions.quotaLimits.monthlyRequests}
                              </span>
                            </div>
                            <Progress 
                              value={(user.usage.monthlyUsed / user.permissions.quotaLimits.monthlyRequests) * 100} 
                              className={`h-2 ${(user.usage.monthlyUsed / user.permissions.quotaLimits.monthlyRequests) > 0.95 ? 'bg-red-900' : 'bg-slate-700'}`}
                            />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm space-y-1">
                          <div className="text-slate-300">总请求: <span className="text-white font-medium">{user.stats.totalRequests}</span></div>
                          <div className="text-slate-300">成功率: <span className="text-green-400 font-medium">{user.stats.totalRequests > 0 ? Math.round((user.stats.successfulRequests / user.stats.totalRequests) * 100) : 0}%</span></div>
                          <div className="text-slate-300">平均响应: <span className="text-blue-400 font-medium">{user.stats.averageResponseTime}ms</span></div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {user.status === 'active' ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleToggleStatus(user.userId, user.status)}
                              className="border-yellow-600/50 text-yellow-400 hover:bg-yellow-600/20 hover:text-yellow-300"
                              title="禁用用户"
                            >
                              <Ban className="h-3 w-3" />
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleToggleStatus(user.userId, user.status)}
                              className="border-green-600/50 text-green-400 hover:bg-green-600/20 hover:text-green-300"
                              title="启用用户"
                            >
                              <CheckCircle className="h-3 w-3" />
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditingUser(user)}
                            className="border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
                            title="编辑用户"
                          >
                            <Edit className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRemoveUser(user.userId)}
                            className="border-red-600/50 text-red-400 hover:bg-red-600/20 hover:text-red-300"
                            title="删除用户"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Edit User Dialog */}
      <Dialog open={!!editingUser} onOpenChange={() => setEditingUser(null)}>
        <DialogContent className="sm:max-w-md bg-slate-800 border-slate-700">
          {editingUser && (
            <UserForm
              user={editingUser}
              onSubmit={(userData) => handleUpdateUser(editingUser.userId, userData)}
              onCancel={() => setEditingUser(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface UserFormProps {
  user?: User;
  onSubmit: (userData: any) => void;
  onCancel: () => void;
}

function UserForm({ user, onSubmit, onCancel }: UserFormProps) {
  const [formData, setFormData] = useState({
    userId: user?.userId || '',
    email: user?.email || '',
    name: user?.name || '',
    userType: user ? getUserTypeFromQuota(user.permissions.quotaLimits) : 'basic',
    dailyRequests: user?.permissions.quotaLimits.dailyRequests || 50,
    monthlyRequests: user?.permissions.quotaLimits.monthlyRequests || 1000,
    concurrentRequests: user?.permissions.quotaLimits.concurrentRequests || 3
  });

  const userTypeQuotas = {
    basic: { daily: 50, monthly: 1000, concurrent: 3 },
    premium: { daily: 200, monthly: 5000, concurrent: 10 },
    vip: { daily: 500, monthly: 15000, concurrent: 20 }
  };

  const handleUserTypeChange = (type: string) => {
    const quota = userTypeQuotas[type as keyof typeof userTypeQuotas];
    setFormData(prev => ({
      ...prev,
      userType: type,
      dailyRequests: quota.daily,
      monthlyRequests: quota.monthly,
      concurrentRequests: quota.concurrent
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const userData = {
      userId: formData.userId,
      name: formData.name,
      permissions: {
        canUseBuiltInServices: true,
        allowedServices: ['gemini-built-in'],
        quotaLimits: {
          dailyRequests: formData.dailyRequests,
          monthlyRequests: formData.monthlyRequests,
          concurrentRequests: formData.concurrentRequests
        },
        grantedAt: new Date().toISOString(),
        grantedBy: 'admin'
      }
    };

    onSubmit(userData);
  };

  function getUserTypeFromQuota(quota: any) {
    if (quota.dailyRequests >= 500) return 'vip';
    if (quota.dailyRequests >= 200) return 'premium';
    return 'basic';
  }

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle className="text-white">{user ? '编辑用户' : '添加用户'}</DialogTitle>
        <DialogDescription className="text-slate-400">
          {user ? '修改用户权限和配额设置' : '添加新的授权用户'}
        </DialogDescription>
      </DialogHeader>
      
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label htmlFor="userId" className="text-slate-300">用户ID (邮箱)</Label>
          <Input
            id="userId"
            value={formData.userId}
            onChange={(e) => setFormData(prev => ({ ...prev, userId: e.target.value }))}
            placeholder="user@example.com"
            disabled={!!user}
            required
            className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400"
          />
        </div>
        
        <div className="grid gap-2">
          <Label htmlFor="name" className="text-slate-300">用户名</Label>
          <Input
            id="name"
            value={formData.name}
            onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
            placeholder="用户名"
            required
            className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400"
          />
        </div>
        
        <div className="grid gap-2">
          <Label htmlFor="userType" className="text-slate-300">用户类型</Label>
          <Select value={formData.userType} onValueChange={handleUserTypeChange}>
            <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-700 border-slate-600">
              <SelectItem value="basic" className="text-white hover:bg-slate-600">基础用户 (50/天)</SelectItem>
              <SelectItem value="premium" className="text-white hover:bg-slate-600">高级用户 (200/天)</SelectItem>
              <SelectItem value="vip" className="text-white hover:bg-slate-600">VIP用户 (500/天)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        
        <div className="grid grid-cols-3 gap-2">
          <div>
            <Label htmlFor="daily" className="text-slate-300">每日限制</Label>
            <Input
              id="daily"
              type="number"
              value={formData.dailyRequests}
              onChange={(e) => setFormData(prev => ({ ...prev, dailyRequests: parseInt(e.target.value) }))}
              min="1"
              className="bg-slate-700 border-slate-600 text-white"
            />
          </div>
          <div>
            <Label htmlFor="monthly" className="text-slate-300">每月限制</Label>
            <Input
              id="monthly"
              type="number"
              value={formData.monthlyRequests}
              onChange={(e) => setFormData(prev => ({ ...prev, monthlyRequests: parseInt(e.target.value) }))}
              min="1"
              className="bg-slate-700 border-slate-600 text-white"
            />
          </div>
          <div>
            <Label htmlFor="concurrent" className="text-slate-300">并发限制</Label>
            <Input
              id="concurrent"
              type="number"
              value={formData.concurrentRequests}
              onChange={(e) => setFormData(prev => ({ ...prev, concurrentRequests: parseInt(e.target.value) }))}
              min="1"
              className="bg-slate-700 border-slate-600 text-white"
            />
          </div>
        </div>
      </div>
      
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} className="border-slate-600 text-slate-300 hover:bg-slate-700">
          取消
        </Button>
        <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
          {user ? '更新' : '添加'}
        </Button>
      </DialogFooter>
    </form>
  );
}

interface ClerkUsersDialogProps {
  users: ClerkUser[];
  loading: boolean;
  onAddUser: (user: ClerkUser, userType: string) => void;
  onCancel: () => void;
  onRefresh: () => void;
  existingUsers: User[];
}

function ClerkUsersDialog({ users, loading, onAddUser, onCancel, onRefresh, existingUsers }: ClerkUsersDialogProps) {
  const [selectedUserType, setSelectedUserType] = useState<{[key: string]: string}>({});
  
  const existingUserEmails = new Set(existingUsers.map(user => user.email));
  const availableUsers = users.filter(user => !existingUserEmails.has(user.email));

  const handleUserTypeChange = (userId: string, type: string) => {
    setSelectedUserType(prev => ({ ...prev, [userId]: type }));
  };

  const handleAddUser = (user: ClerkUser) => {
    const userType = selectedUserType[user.userId] || 'basic';
    onAddUser(user, userType);
  };

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return '从未登录';
    return new Date(timestamp).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <>
      <DialogHeader>
        <div className="flex items-center justify-between">
          <div>
            <DialogTitle className="text-white">从Clerk工作区选择用户</DialogTitle>
            <DialogDescription className="text-slate-400">
              选择已注册的用户并设置权限类型，避免手动输入错误
            </DialogDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            className="border-slate-600 text-slate-300 hover:bg-slate-700"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </DialogHeader>

      <div className="max-h-96 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="flex flex-col items-center space-y-4">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent"></div>
              <p className="text-slate-400 text-sm">加载Clerk用户...</p>
            </div>
          </div>
        ) : availableUsers.length === 0 ? (
          <div className="text-center py-8">
            <Users className="h-12 w-12 text-slate-500 mx-auto mb-4" />
            <p className="text-slate-400">没有可添加的新用户</p>
            <p className="text-slate-500 text-sm mt-2">所有Clerk用户都已添加到授权列表中</p>
          </div>
        ) : (
          <div className="space-y-3">
            {availableUsers.map((user) => (
              <Card key={user.clerkId} className="bg-slate-700/50 border-slate-600">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {user.imageUrl ? (
                        <img 
                          src={user.imageUrl} 
                          alt={user.name}
                          className="w-10 h-10 rounded-full"
                        />
                      ) : (
                        <div className="w-10 h-10 bg-slate-600 rounded-full flex items-center justify-center">
                          <User className="h-5 w-5 text-slate-300" />
                        </div>
                      )}
                      <div>
                        <div className="font-medium text-white">{user.name}</div>
                        <div className="text-sm text-slate-400">{user.email}</div>
                        <div className="text-xs text-slate-500 mt-1">
                          注册时间: {formatDate(user.createdAt)} | 
                          最后登录: {formatDate(user.lastSignInAt)}
                          {user.verified && (
                            <Badge className="ml-2 bg-green-500/20 text-green-400 border-green-500/30 text-xs">
                              已验证
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Select 
                        value={selectedUserType[user.userId] || 'basic'} 
                        onValueChange={(value) => handleUserTypeChange(user.userId, value)}
                      >
                        <SelectTrigger className="w-32 bg-slate-600 border-slate-500 text-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-slate-700 border-slate-600">
                          <SelectItem value="basic" className="text-white hover:bg-slate-600">基础 (50/天)</SelectItem>
                          <SelectItem value="premium" className="text-white hover:bg-slate-600">高级 (200/天)</SelectItem>
                          <SelectItem value="vip" className="text-white hover:bg-slate-600">VIP (500/天)</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        onClick={() => handleAddUser(user)}
                        className="bg-blue-600 hover:bg-blue-700"
                      >
                        添加
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} className="border-slate-600 text-slate-300 hover:bg-slate-700">
          关闭
        </Button>
      </DialogFooter>
    </>
  );
}
