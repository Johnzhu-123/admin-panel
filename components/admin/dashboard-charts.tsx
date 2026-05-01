'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  LineChart, 
  Line, 
  AreaChart, 
  Area, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import { TrendingUp, Users, Clock, Activity, BarChart3, PieChart as PieChartIcon } from 'lucide-react';

interface UsageStats {
  daily: Array<{
    date: string;
    requests: number;
    users: number;
  }>;
  hourly: Array<{
    hour: number;
    requests: number;
    responseTime: number;
  }>;
  summary: {
    totalRequests: number;
    successRate: number;
    averageResponseTime: number;
    activeUsers: number;
    requestsLast24h: number;
    averageResponseTimeLast24h: number;
  };
}

export function AdminDashboardCharts() {
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchUsageStats();
    // Refresh every 30 seconds
    const interval = setInterval(fetchUsageStats, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchUsageStats = async () => {
    try {
      const response = await fetch('/api/admin/dashboard?action=usage-stats', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Failed to fetch usage statistics');
      }
      const data = await response.json();
      setUsageStats(data.usageStats);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Card className="bg-slate-800/50 border-slate-700">
        <CardContent className="flex items-center justify-center py-12">
          <div className="flex flex-col items-center space-y-4">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent"></div>
            <p className="text-slate-400 text-sm">加载统计数据...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !usageStats) {
    return (
      <Card className="bg-slate-800/50 border-slate-700">
        <CardContent className="flex items-center justify-center py-8">
          <div className="text-red-400">加载统计数据失败: {error}</div>
        </CardContent>
      </Card>
    );
  }

  // Prepare data for charts
  const pieData = [
    { name: '成功请求', value: Math.round(usageStats.summary.totalRequests * usageStats.summary.successRate / 100), color: '#10b981' },
    { name: '失败请求', value: Math.round(usageStats.summary.totalRequests * (100 - usageStats.summary.successRate) / 100), color: '#ef4444' }
  ];

  const userTypeData = [
    { name: '基础用户', value: 60, color: '#3b82f6' },
    { name: '高级用户', value: 30, color: '#8b5cf6' },
    { name: 'VIP用户', value: 10, color: '#f59e0b' }
  ];

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-300">近24小时请求数</CardTitle>
            <div className="p-2 bg-blue-500/20 rounded-lg">
              <Activity className="h-4 w-4 text-blue-400" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{usageStats.summary.requestsLast24h || 0}</div>
            <p className="text-xs text-slate-400 flex items-center gap-1">
              总请求数: {usageStats.summary.totalRequests || 0}
            </p>
          </CardContent>
        </Card>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-300">成功率</CardTitle>
            <div className="p-2 bg-green-500/20 rounded-lg">
              <TrendingUp className="h-4 w-4 text-green-400" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{usageStats.summary.successRate}%</div>
            <p className="text-xs text-green-400 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              +2% 相比上月
            </p>
          </CardContent>
        </Card>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-300">近24小时平均响应时间</CardTitle>
            <div className="p-2 bg-orange-500/20 rounded-lg">
              <Clock className="h-4 w-4 text-orange-400" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{usageStats.summary.averageResponseTimeLast24h || 0}ms</div>
            <p className="text-xs text-slate-400 flex items-center gap-1">
              总平均响应时间: {usageStats.summary.averageResponseTime || 0}ms
            </p>
          </CardContent>
        </Card>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-300">活跃用户</CardTitle>
            <div className="p-2 bg-purple-500/20 rounded-lg">
              <Users className="h-4 w-4 text-purple-400" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{usageStats.summary.activeUsers}</div>
            <p className="text-xs text-green-400 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              +1 相比上月
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <Card className="bg-slate-800/50 border-slate-700">
        <Tabs defaultValue="requests" className="w-full">
          <div className="border-b border-slate-700">
            <TabsList className="grid w-full grid-cols-3 bg-transparent h-auto p-0">
              <TabsTrigger 
                value="requests" 
                className="flex items-center gap-2 py-3 px-4 data-[state=active]:bg-slate-700/50 data-[state=active]:text-white text-slate-400 hover:text-white transition-all duration-200 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-500"
              >
                <BarChart3 className="h-4 w-4" />
                请求趋势
              </TabsTrigger>
              <TabsTrigger 
                value="performance" 
                className="flex items-center gap-2 py-3 px-4 data-[state=active]:bg-slate-700/50 data-[state=active]:text-white text-slate-400 hover:text-white transition-all duration-200 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-500"
              >
                <Activity className="h-4 w-4" />
                性能监控
              </TabsTrigger>
              <TabsTrigger 
                value="distribution" 
                className="flex items-center gap-2 py-3 px-4 data-[state=active]:bg-slate-700/50 data-[state=active]:text-white text-slate-400 hover:text-white transition-all duration-200 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-500"
              >
                <PieChartIcon className="h-4 w-4" />
                使用分布
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="p-6">
            <TabsContent value="requests" className="mt-0 space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card className="bg-slate-700/30 border-slate-600">
                  <CardHeader>
                    <CardTitle className="text-white">每日请求趋势</CardTitle>
                    <CardDescription className="text-slate-400">过去30天的API请求数量</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <AreaChart data={usageStats.daily}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                        <XAxis 
                          dataKey="date" 
                          tickFormatter={(value) => new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                          stroke="#9ca3af"
                        />
                        <YAxis stroke="#9ca3af" />
                        <Tooltip 
                          labelFormatter={(value) => new Date(value).toLocaleDateString('zh-CN')}
                          formatter={(value, name) => [value, name === 'requests' ? '请求数' : '用户数']}
                          contentStyle={{ 
                            backgroundColor: '#1f2937', 
                            border: '1px solid #374151',
                            borderRadius: '8px',
                            color: '#fff'
                          }}
                        />
                        <Area 
                          type="monotone" 
                          dataKey="requests" 
                          stroke="#3b82f6" 
                          fill="#3b82f6" 
                          fillOpacity={0.3}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                <Card className="bg-slate-700/30 border-slate-600">
                  <CardHeader>
                    <CardTitle className="text-white">每日活跃用户</CardTitle>
                    <CardDescription className="text-slate-400">过去30天的活跃用户数量</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={usageStats.daily}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                        <XAxis 
                          dataKey="date" 
                          tickFormatter={(value) => new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                          stroke="#9ca3af"
                        />
                        <YAxis stroke="#9ca3af" />
                        <Tooltip 
                          labelFormatter={(value) => new Date(value).toLocaleDateString('zh-CN')}
                          formatter={(value) => [value, '活跃用户']}
                          contentStyle={{ 
                            backgroundColor: '#1f2937', 
                            border: '1px solid #374151',
                            borderRadius: '8px',
                            color: '#fff'
                          }}
                        />
                        <Line 
                          type="monotone" 
                          dataKey="users" 
                          stroke="#10b981" 
                          strokeWidth={2}
                          dot={{ fill: '#10b981' }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="performance" className="mt-0 space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card className="bg-slate-700/30 border-slate-600">
                  <CardHeader>
                    <CardTitle className="text-white">24小时请求分布</CardTitle>
                    <CardDescription className="text-slate-400">按小时统计的请求数量</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={usageStats.hourly}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                        <XAxis 
                          dataKey="hour" 
                          tickFormatter={(value) => `${value}:00`}
                          stroke="#9ca3af"
                        />
                        <YAxis stroke="#9ca3af" />
                        <Tooltip 
                          labelFormatter={(value) => `${value}:00`}
                          formatter={(value) => [value, '请求数']}
                          contentStyle={{ 
                            backgroundColor: '#1f2937', 
                            border: '1px solid #374151',
                            borderRadius: '8px',
                            color: '#fff'
                          }}
                        />
                        <Bar dataKey="requests" fill="#8b5cf6" />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                <Card className="bg-slate-700/30 border-slate-600">
                  <CardHeader>
                    <CardTitle className="text-white">响应时间趋势</CardTitle>
                    <CardDescription className="text-slate-400">24小时平均响应时间</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={usageStats.hourly}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                        <XAxis 
                          dataKey="hour" 
                          tickFormatter={(value) => `${value}:00`}
                          stroke="#9ca3af"
                        />
                        <YAxis stroke="#9ca3af" />
                        <Tooltip 
                          labelFormatter={(value) => `${value}:00`}
                          formatter={(value) => [`${value}ms`, '响应时间']}
                          contentStyle={{ 
                            backgroundColor: '#1f2937', 
                            border: '1px solid #374151',
                            borderRadius: '8px',
                            color: '#fff'
                          }}
                        />
                        <Line 
                          type="monotone" 
                          dataKey="responseTime" 
                          stroke="#f59e0b" 
                          strokeWidth={2}
                          dot={{ fill: '#f59e0b' }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="distribution" className="mt-0 space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card className="bg-slate-700/30 border-slate-600">
                  <CardHeader>
                    <CardTitle className="text-white">请求成功率</CardTitle>
                    <CardDescription className="text-slate-400">成功与失败请求的比例</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie
                          data={pieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={100}
                          paddingAngle={5}
                          dataKey="value"
                        >
                          {pieData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip 
                          formatter={(value) => [value, '请求数']} 
                          contentStyle={{ 
                            backgroundColor: '#1f2937', 
                            border: '1px solid #374151',
                            borderRadius: '8px',
                            color: '#fff'
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex justify-center gap-4 mt-4">
                      {pieData.map((entry, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <div 
                            className="w-3 h-3 rounded-full" 
                            style={{ backgroundColor: entry.color }}
                          />
                          <span className="text-sm text-slate-300">{entry.name}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                <Card className="bg-slate-700/30 border-slate-600">
                  <CardHeader>
                    <CardTitle className="text-white">用户类型分布</CardTitle>
                    <CardDescription className="text-slate-400">不同类型用户的占比</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie
                          data={userTypeData}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={100}
                          paddingAngle={5}
                          dataKey="value"
                        >
                          {userTypeData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip 
                          formatter={(value) => [`${value}%`, '占比']} 
                          contentStyle={{ 
                            backgroundColor: '#1f2937', 
                            border: '1px solid #374151',
                            borderRadius: '8px',
                            color: '#fff'
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex justify-center gap-4 mt-4">
                      {userTypeData.map((entry, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <div 
                            className="w-3 h-3 rounded-full" 
                            style={{ backgroundColor: entry.color }}
                          />
                          <span className="text-sm text-slate-300">{entry.name}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </Card>
    </div>
  );
}

