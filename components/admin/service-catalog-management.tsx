"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Boxes,
  FileText,
  ImageIcon,
  AudioLines,
  Video,
  KeyRound,
  Save,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Plus,
  Trash2,
  Star,
  StarOff,
  Plug,
  CircleCheck,
  CircleX,
  Eye,
  EyeOff,
} from "lucide-react";

type CategoryKey = "multimodal" | "text" | "image" | "tts" | "video";

interface SubtaskConfig {
  id: string;
  displayName: string;
  description?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  isEnabled: boolean;
  updatedAt?: string;
}

interface CategoryConfig {
  displayName: string;
  description?: string;
  defaultSubtaskId: string;
  subtasks: Record<string, SubtaskConfig>;
}

type Catalog = Record<CategoryKey, CategoryConfig>;

interface SubtaskPreset {
  id: string;
  displayName: string;
  description?: string;
  defaultModel: string;
}

type ProbeResult = {
  ok: boolean;
  models: string[];
  error?: string;
  status?: number;
  authVerifiedVia?: "models" | "chat";
  notice?: string;
  at: number;
};

const CATEGORY_META: Array<{
  key: CategoryKey;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: "multimodal", icon: Boxes },
  { key: "text", icon: FileText },
  { key: "image", icon: ImageIcon },
  { key: "tts", icon: AudioLines },
  { key: "video", icon: Video },
];

const BASE_URL_PLACEHOLDER = "https://api.seeyjys.eu.org/v1";

/**
 * 判断字符串是否为后端 maskSecret 的输出（含连续 4+ 星号或全是星号）。
 * 与服务端 isMaskedApiKey 保持一致——真实 API Key 不会包含 `*` 字符。
 */
function isMaskedApiKey(value: string | undefined | null): boolean {
  if (!value) return false;
  if (/\*{4,}/.test(value)) return true;
  if (/^\*+$/.test(value)) return true;
  return false;
}

function makeEmptySubtask(id: string, displayName?: string): SubtaskConfig {
  return {
    id,
    displayName: displayName || id,
    baseUrl: "",
    apiKey: "",
    model: "",
    isEnabled: false,
  };
}

const DATALIST_ID = (category: CategoryKey, subtaskId: string) =>
  `model-options-${category}-${subtaskId}`;

export function ServiceCatalogManagement() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [presets, setPresets] = useState<Record<CategoryKey, SubtaskPreset[]>>({} as Record<CategoryKey, SubtaskPreset[]>);
  const [encryptionConfigured, setEncryptionConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [batchSavingCategory, setBatchSavingCategory] = useState<CategoryKey | null>(null);
  const [probingKey, setProbingKey] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({});
  const [error, setError] = useState("");
  const [bulkBaseUrl, setBulkBaseUrl] = useState("");
  const [bulkApiKey, setBulkApiKey] = useState("");
  const [bulkApiKeyVisible, setBulkApiKeyVisible] = useState(false);
  const [visibleApiKeys, setVisibleApiKeys] = useState<Record<string, boolean>>({});
  const [bulkEnable, setBulkEnable] = useState(true);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [success, setSuccess] = useState("");

  const fetchSettings = async () => {
    setLoading(true);
    setError("");
    try {
      const resp = await fetch("/api/admin/system-settings", {
        method: "GET",
        cache: "no-store",
        credentials: "include",
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const incoming = (data?.settings?.serviceCatalog || {}) as Partial<Catalog>;
      setEncryptionConfigured(Boolean(data?.encryption?.configured));
      const next: Catalog = {} as Catalog;
      for (const meta of CATEGORY_META) {
        const cat = incoming[meta.key];
        if (cat) {
          next[meta.key] = cat;
        } else {
          next[meta.key] = {
            displayName: meta.key,
            defaultSubtaskId: "default",
            subtasks: { default: makeEmptySubtask("default") },
          };
        }
      }
      setCatalog(next);
      setPresets(data?.settings?.subtaskPresets || ({} as Record<CategoryKey, SubtaskPreset[]>));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchSettings();
  }, []);

  const updateSubtaskField = (
    category: CategoryKey,
    subtaskId: string,
    field: keyof SubtaskConfig,
    value: string | boolean
  ) => {
    setCatalog((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as Catalog;
      const subtask = next[category].subtasks[subtaskId];
      if (!subtask) return prev;
      (subtask as unknown as Record<string, unknown>)[field as string] = value;
      return next;
    });
  };

  const buildSubtaskPatch = (subtask: SubtaskConfig) => {
    const patch: Record<string, unknown> = {
      displayName: subtask.displayName,
      description: subtask.description,
      baseUrl: subtask.baseUrl,
      model: subtask.model,
      isEnabled: subtask.isEnabled,
    };
    // 只有 apiKey 有值且不是掩码（如 "abcd********wxyz"）时才发送，
    // 避免把 mask 字符串当作真实 Key 写回数据库导致后续上游 401。
    if (subtask.apiKey && !isMaskedApiKey(subtask.apiKey)) {
      patch.apiKey = subtask.apiKey;
    }
    return patch;
  };

  const saveSubtask = async (category: CategoryKey, subtaskId: string) => {
    if (!catalog) return;
    const subtask = catalog[category].subtasks[subtaskId];
    if (!subtask) return;
    setSavingKey(`${category}/${subtaskId}`);
    setError("");
    setSuccess("");
    try {
      const resp = await fetch("/api/admin/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "update-service-subtask",
          category,
          subtaskId,
          patch: buildSubtaskPatch(subtask),
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${resp.status}`);
      }
      setSuccess(`已保存：${category} / ${subtask.displayName}`);
      await fetchSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingKey(null);
    }
  };

  const saveCategoryAll = async (category: CategoryKey) => {
    if (!catalog) return;
    const subtasks = Object.values(catalog[category].subtasks);
    if (!subtasks.length) return;
    setBatchSavingCategory(category);
    setError("");
    setSuccess("");
    try {
      let okCount = 0;
      const failures: string[] = [];
      for (const subtask of subtasks) {
        try {
          const resp = await fetch("/api/admin/system-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              action: "update-service-subtask",
              category,
              subtaskId: subtask.id,
              patch: buildSubtaskPatch(subtask),
            }),
          });
          if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            failures.push(`${subtask.id}: ${body?.error || `HTTP ${resp.status}`}`);
          } else {
            okCount += 1;
          }
        } catch (err) {
          failures.push(`${subtask.id}: ${err instanceof Error ? err.message : "失败"}`);
        }
      }
      if (failures.length) {
        setError(`${okCount} 个子任务保存成功；${failures.length} 个失败：${failures.join("；")}`);
      } else {
        setSuccess(`${catalog[category].displayName}：${okCount} 个子任务全部保存成功`);
      }
      await fetchSettings();
    } finally {
      setBatchSavingCategory(null);
    }
  };

  const probeSubtask = async (category: CategoryKey, subtaskId: string) => {
    if (!catalog) return;
    const subtask = catalog[category].subtasks[subtaskId];
    if (!subtask) return;
    const key = `${category}/${subtaskId}`;
    setProbingKey(key);
    setError("");
    try {
      const resp = await fetch("/api/admin/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "probe-subtask",
          category,
          subtaskId,
          baseUrl: subtask.baseUrl,
          apiKey: subtask.apiKey,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      const result: ProbeResult = {
        ok: Boolean(data?.ok),
        models: Array.isArray(data?.models) ? data.models : [],
        error: data?.error,
        status: data?.status,
        authVerifiedVia: data?.authVerifiedVia,
        notice: data?.notice,
        at: Date.now(),
      };
      setProbeResults((prev) => ({ ...prev, [key]: result }));
      // 如果上游 model 列表里没有当前 model 但用户填了一个，也保留它在 datalist 顶部
    } catch (e) {
      setProbeResults((prev) => ({
        ...prev,
        [key]: {
          ok: false,
          models: [],
          error: e instanceof Error ? e.message : "请求失败",
          at: Date.now(),
        },
      }));
    } finally {
      setProbingKey(null);
    }
  };

  const applyBulkCredentials = async () => {
    const trimmedBase = bulkBaseUrl.trim();
    const trimmedKey = bulkApiKey;
    if (!trimmedBase && !trimmedKey) {
      setError("请至少填写 BaseURL 或 API Key 之一");
      return;
    }
    if (trimmedBase && !/^https?:\/\//i.test(trimmedBase)) {
      setError("BaseURL 必须以 http:// 或 https:// 开头");
      return;
    }
    setBulkApplying(true);
    setError("");
    setSuccess("");
    try {
      const payload: Record<string, unknown> = { action: "bulk-apply-credentials" };
      if (trimmedBase) payload.baseUrl = trimmedBase;
      if (trimmedKey) payload.apiKey = trimmedKey;
      payload.isEnabled = bulkEnable;
      const resp = await fetch("/api/admin/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json().catch(() => ({}));
      setSuccess(`已应用到 ${data?.applied ?? "所有"} 个子任务`);
      setBulkApiKey("");
      await fetchSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "一键应用失败");
    } finally {
      setBulkApplying(false);
    }
  };

  const deleteSubtask = async (category: CategoryKey, subtaskId: string) => {
    if (!confirm(`确认删除子任务 ${subtaskId}？预设子任务不能删除。`)) return;
    setSavingKey(`${category}/${subtaskId}`);
    setError("");
    setSuccess("");
    try {
      const resp = await fetch("/api/admin/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "delete-service-subtask",
          category,
          subtaskId,
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${resp.status}`);
      }
      setSuccess(`已删除子任务 ${subtaskId}`);
      await fetchSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setSavingKey(null);
    }
  };

  const setDefaultSubtask = async (category: CategoryKey, subtaskId: string) => {
    setSavingKey(`${category}/default`);
    setError("");
    setSuccess("");
    try {
      const resp = await fetch("/api/admin/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "set-default-subtask",
          category,
          subtaskId,
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${resp.status}`);
      }
      setSuccess(`已设置 ${category} 默认 = ${subtaskId}`);
      await fetchSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "设置失败");
    } finally {
      setSavingKey(null);
    }
  };

  const addCustomSubtask = async (category: CategoryKey) => {
    const id = prompt("请输入子任务 ID（仅小写字母/数字/下划线/横线）:");
    if (!id) return;
    const safeId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!safeId) {
      setError("ID 格式不合法");
      return;
    }
    if (catalog?.[category].subtasks[safeId]) {
      setError(`子任务 ${safeId} 已存在`);
      return;
    }
    const displayName = prompt("请输入展示名（中文）:") || safeId;
    setSavingKey(`${category}/${safeId}`);
    try {
      const resp = await fetch("/api/admin/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "update-service-subtask",
          category,
          subtaskId: safeId,
          patch: {
            displayName,
            baseUrl: "",
            model: "",
            isEnabled: false,
          },
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${resp.status}`);
      }
      setSuccess(`已新增 ${category} / ${displayName}`);
      await fetchSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "新增失败");
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) {
    return (
      <Card className="bg-slate-800/50 border-slate-700/70 backdrop-blur-sm">
        <CardContent className="py-10 text-center text-sm text-slate-400">
          <RefreshCw className="mx-auto mb-2 h-5 w-5 animate-spin" />
          正在加载内置 AI 服务清单…
        </CardContent>
      </Card>
    );
  }

  if (!catalog) {
    return (
      <Card className="bg-slate-800/50 border-slate-700/70 backdrop-blur-sm">
        <CardContent className="py-6 text-sm text-red-400">
          加载失败：{error || "未知错误"}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-slate-800/50 border-slate-700/70 backdrop-blur-sm shadow-lg">
      <CardHeader className="space-y-2 pb-4 border-b border-slate-700/60">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base text-white">
            <KeyRound className="h-5 w-5 text-indigo-400" />
            AI 服务清单
          </CardTitle>
          {encryptionConfigured ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-xs text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              加密已启用
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md bg-orange-500/15 px-2 py-1 text-xs text-orange-300">
              <ShieldAlert className="h-3.5 w-3.5" />
              未配置加密密钥（明文落库）
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        {!!error && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2.5 text-sm text-red-300">
            {error}
          </div>
        )}
        {!!success && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-sm text-emerald-300">
            {success}
          </div>
        )}

        <div className="rounded-lg border border-dashed border-slate-600/70 bg-slate-900/40 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-indigo-400" />
            <span className="text-sm font-medium text-slate-200">通用凭据 · 一键写入全部子任务</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-400">BaseURL</Label>
              <Input
                value={bulkBaseUrl}
                onChange={(e) => setBulkBaseUrl(e.target.value)}
                placeholder={BASE_URL_PLACEHOLDER}
                className="bg-slate-900/70 border-slate-600 text-slate-100 placeholder:text-slate-500"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-400">API Key</Label>
              <div className="relative">
                <Input
                  type={bulkApiKeyVisible ? "text" : "password"}
                  value={bulkApiKey}
                  onChange={(e) => setBulkApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="bg-slate-900/70 border-slate-600 text-slate-100 placeholder:text-slate-500 pr-9"
                />
                <button
                  type="button"
                  onClick={() => setBulkApiKeyVisible((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                  title={bulkApiKeyVisible ? "隐藏" : "显示"}
                  aria-label={bulkApiKeyVisible ? "隐藏 API Key" : "显示 API Key"}
                >
                  {bulkApiKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={bulkEnable}
                onChange={(e) => setBulkEnable(e.target.checked)}
                className="accent-indigo-500"
              />
              同时启用所有子任务
            </label>
            <Button
              size="sm"
              onClick={applyBulkCredentials}
              disabled={bulkApplying}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {bulkApplying ? (
                <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <KeyRound className="mr-1 h-3 w-3" />
              )}
              一键应用
            </Button>
          </div>
        </div>

        <Tabs defaultValue="multimodal" className="w-full">
          <TabsList className="mb-4 grid w-full grid-cols-5 bg-slate-900/40 border border-slate-700/60 p-1 h-auto rounded-lg">
            {CATEGORY_META.map((meta) => {
              const Icon = meta.icon;
              return (
                <TabsTrigger
                  key={meta.key}
                  value={meta.key}
                  className="flex items-center gap-2 text-slate-400 data-[state=active]:bg-indigo-500/20 data-[state=active]:text-indigo-300 data-[state=active]:shadow-sm rounded-md py-2"
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden sm:inline">{catalog[meta.key]?.displayName || meta.key}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          {CATEGORY_META.map((meta) => {
            const cfg = catalog[meta.key];
            const subtasks = Object.values(cfg.subtasks).sort((a, b) => a.id.localeCompare(b.id));
            const presetIds = new Set((presets[meta.key] || []).map((p) => p.id));
            const batchSaving = batchSavingCategory === meta.key;
            return (
              <TabsContent key={meta.key} value={meta.key} className="space-y-3 mt-0">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700/60 bg-slate-900/30 px-3 py-2">
                  <span className="text-xs text-slate-400">
                    共 {subtasks.length} 个子任务 · 默认 <code className="text-indigo-300">{cfg.defaultSubtaskId}</code>
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => addCustomSubtask(meta.key)}
                      className="border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
                    >
                      <Plus className="mr-1 h-3 w-3" /> 新增子任务
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => saveCategoryAll(meta.key)}
                      disabled={batchSaving || !!savingKey}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      {batchSaving ? (
                        <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Save className="mr-1 h-3 w-3" />
                      )}
                      保存当前分类全部子任务
                    </Button>
                  </div>
                </div>

                {subtasks.map((subtask) => {
                  const isPreset = presetIds.has(subtask.id);
                  const isDefault = cfg.defaultSubtaskId === subtask.id;
                  const subtaskKey = `${meta.key}/${subtask.id}`;
                  const saving = savingKey === subtaskKey;
                  const probing = probingKey === subtaskKey;
                  const probeResult = probeResults[subtaskKey];
                  const datalistId = DATALIST_ID(meta.key, subtask.id);
                  const datalistOptions = probeResult?.ok ? probeResult.models : [];
                  return (
                    <Card
                      key={subtask.id}
                      className="bg-slate-900/40 border-slate-700/60 shadow-sm"
                    >
                      <CardHeader className="pb-3 border-b border-slate-700/40">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <CardTitle className="text-sm text-slate-100">{subtask.displayName}</CardTitle>
                            <code className="text-xs text-slate-500">{subtask.id}</code>
                            {isDefault && (
                              <span className="inline-flex items-center gap-1 rounded bg-yellow-500/15 px-1.5 py-0.5 text-xs text-yellow-300">
                                <Star className="h-3 w-3" /> 默认
                              </span>
                            )}
                            {isPreset && (
                              <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-xs text-blue-300">
                                预设
                              </span>
                            )}
                            {subtask.isEnabled ? (
                              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300">
                                启用
                              </span>
                            ) : (
                              <span className="rounded bg-slate-500/20 px-1.5 py-0.5 text-xs text-slate-400">
                                未启用
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            {!isDefault && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setDefaultSubtask(meta.key, subtask.id)}
                                disabled={saving}
                                title="设为默认子任务"
                                className="text-slate-400 hover:text-yellow-300 hover:bg-slate-700/50"
                              >
                                <StarOff className="h-4 w-4" />
                              </Button>
                            )}
                            {!isPreset && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => deleteSubtask(meta.key, subtask.id)}
                                disabled={saving}
                                className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                                title="删除"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3 pt-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label className="text-xs text-slate-400">Model</Label>
                            <Input
                              list={datalistOptions.length ? datalistId : undefined}
                              value={subtask.model}
                              onChange={(e) =>
                                updateSubtaskField(meta.key, subtask.id, "model", e.target.value)
                              }
                              placeholder="gpt-4o / gpt-image-1 / sora-1 ..."
                              className="bg-slate-900/70 border-slate-600 text-slate-100 placeholder:text-slate-500"
                            />
                            {datalistOptions.length > 0 && (
                              <datalist id={datalistId}>
                                {datalistOptions.map((m) => (
                                  <option key={m} value={m} />
                                ))}
                              </datalist>
                            )}
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-slate-400">展示名</Label>
                            <Input
                              value={subtask.displayName}
                              onChange={(e) =>
                                updateSubtaskField(meta.key, subtask.id, "displayName", e.target.value)
                              }
                              placeholder="子任务展示名"
                              className="bg-slate-900/70 border-slate-600 text-slate-100 placeholder:text-slate-500"
                            />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-slate-400">BaseURL</Label>
                          <Input
                            value={subtask.baseUrl}
                            onChange={(e) =>
                              updateSubtaskField(meta.key, subtask.id, "baseUrl", e.target.value)
                            }
                            placeholder={BASE_URL_PLACEHOLDER}
                            className="bg-slate-900/70 border-slate-600 text-slate-100 placeholder:text-slate-500"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-slate-400">API Key</Label>
                          <div className="relative">
                            <Input
                              type={visibleApiKeys[subtaskKey] ? "text" : "password"}
                              value={subtask.apiKey}
                              onChange={(e) =>
                                updateSubtaskField(meta.key, subtask.id, "apiKey", e.target.value)
                              }
                              placeholder={isMaskedApiKey(subtask.apiKey) ? subtask.apiKey : "sk-..."}
                              className="bg-slate-900/70 border-slate-600 text-slate-100 placeholder:text-slate-500 pr-9"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setVisibleApiKeys((prev) => ({
                                  ...prev,
                                  [subtaskKey]: !prev[subtaskKey],
                                }))
                              }
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                              title={visibleApiKeys[subtaskKey] ? "隐藏" : "显示"}
                              aria-label={visibleApiKeys[subtaskKey] ? "隐藏 API Key" : "显示 API Key"}
                            >
                              {visibleApiKeys[subtaskKey] ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                          {isMaskedApiKey(subtask.apiKey) && visibleApiKeys[subtaskKey] && (
                            <p className="text-[11px] text-slate-500">
                              出于安全考虑，已存储的 Key 仅显示掩码尾部；如需完整值请重新填写后保存。
                            </p>
                          )}
                        </div>

                        {probeResult && (
                          <div
                            className={`rounded-md border p-2.5 text-xs ${
                              probeResult.ok
                                ? probeResult.authVerifiedVia === "chat"
                                  ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                                : "border-red-500/40 bg-red-500/10 text-red-300"
                            }`}
                          >
                            {probeResult.ok ? (
                              <div className="flex items-start gap-2">
                                <CircleCheck className="h-4 w-4 mt-0.5 shrink-0" />
                                <span>
                                  {probeResult.authVerifiedVia === "chat"
                                    ? probeResult.notice ||
                                      "上游 /models 端点拒绝该 Key，但 chat/completions 已验证 Key 可用，请手动填写 Model。"
                                    : `连接成功 · 拉到 ${probeResult.models.length} 个模型，已写入下拉列表（点击 Model 输入框查看）`}
                                </span>
                              </div>
                            ) : (
                              <div className="flex items-start gap-2">
                                <CircleX className="h-4 w-4 mt-0.5 shrink-0" />
                                <span>{probeResult.error || `HTTP ${probeResult.status || 0}`}</span>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                          <label className="flex items-center gap-2 text-xs text-slate-300">
                            <input
                              type="checkbox"
                              checked={subtask.isEnabled}
                              onChange={(e) =>
                                updateSubtaskField(meta.key, subtask.id, "isEnabled", e.target.checked)
                              }
                              className="accent-indigo-500"
                            />
                            启用
                          </label>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => probeSubtask(meta.key, subtask.id)}
                              disabled={probing || saving}
                              className="border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
                              title="用当前 BaseURL + API Key 测试连通性并拉取上游模型列表"
                            >
                              {probing ? (
                                <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                              ) : (
                                <Plug className="mr-1 h-3 w-3" />
                              )}
                              测试连接 + 拉模型
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => saveSubtask(meta.key, subtask.id)}
                              disabled={saving}
                              className="bg-blue-600 hover:bg-blue-700 text-white"
                            >
                              {saving ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
                              保存
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </TabsContent>
            );
          })}
        </Tabs>
      </CardContent>
    </Card>
  );
}
