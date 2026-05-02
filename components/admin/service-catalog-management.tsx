"use client";

import { useEffect, useMemo, useState } from "react";
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

export function ServiceCatalogManagement() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [presets, setPresets] = useState<Record<CategoryKey, SubtaskPreset[]>>({} as Record<CategoryKey, SubtaskPreset[]>);
  const [encryptionConfigured, setEncryptionConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [bulkBaseUrl, setBulkBaseUrl] = useState("");
  const [bulkApiKey, setBulkApiKey] = useState("");
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

  const saveSubtask = async (category: CategoryKey, subtaskId: string) => {
    if (!catalog) return;
    const subtask = catalog[category].subtasks[subtaskId];
    if (!subtask) return;
    setSavingKey(`${category}/${subtaskId}`);
    setError("");
    setSuccess("");
    try {
      const patch: Record<string, unknown> = {
        displayName: subtask.displayName,
        description: subtask.description,
        baseUrl: subtask.baseUrl,
        model: subtask.model,
        isEnabled: subtask.isEnabled,
      };
      // 只有 apiKey 不为空字符串时才发送（避免误清空）
      if (subtask.apiKey && !subtask.apiKey.startsWith("****")) {
        patch.apiKey = subtask.apiKey;
      }
      const resp = await fetch("/api/admin/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "update-service-subtask",
          category,
          subtaskId,
          patch,
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
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          <RefreshCw className="mx-auto mb-2 h-5 w-5 animate-spin" />
          正在加载内置 AI 服务清单...
        </CardContent>
      </Card>
    );
  }

  if (!catalog) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">
          加载失败：{error || "未知错误"}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-5 w-5" />
            AI 服务清单
          </CardTitle>
          {encryptionConfigured ? (
            <span className="inline-flex items-center gap-1 text-xs text-green-600">
              <ShieldCheck className="h-4 w-4" />
              加密已启用
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-orange-600">
              <ShieldAlert className="h-4 w-4" />
              未配置加密密钥（API Key 明文落库）
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!!error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {!!success && (
          <div className="rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-600">
            {success}
          </div>
        )}

        <Card className="border-dashed">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <KeyRound className="h-4 w-4" /> 通用凭据 · 一键写入全部子任务
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">BaseURL</Label>
                <Input
                  value={bulkBaseUrl}
                  onChange={(e) => setBulkBaseUrl(e.target.value)}
                  placeholder={BASE_URL_PLACEHOLDER}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">API Key</Label>
                <Input
                  type="password"
                  value={bulkApiKey}
                  onChange={(e) => setBulkApiKey(e.target.value)}
                  placeholder="sk-..."
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={bulkEnable}
                  onChange={(e) => setBulkEnable(e.target.checked)}
                />
                同时启用所有子任务
              </label>
              <Button size="sm" onClick={applyBulkCredentials} disabled={bulkApplying}>
                {bulkApplying ? (
                  <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <KeyRound className="mr-1 h-3 w-3" />
                )}
                一键应用
              </Button>
            </div>
          </CardContent>
        </Card>

        <Tabs defaultValue="multimodal" className="w-full">
          <TabsList className="mb-4 grid w-full grid-cols-5">
            {CATEGORY_META.map((meta) => {
              const Icon = meta.icon;
              return (
                <TabsTrigger key={meta.key} value={meta.key} className="flex items-center gap-2">
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
            return (
              <TabsContent key={meta.key} value={meta.key} className="space-y-3">
                <div className="flex items-center justify-end">
                  <Button size="sm" variant="outline" onClick={() => addCustomSubtask(meta.key)}>
                    <Plus className="mr-1 h-3 w-3" /> 新增子任务
                  </Button>
                </div>

                {subtasks.map((subtask) => {
                  const isPreset = presetIds.has(subtask.id);
                  const isDefault = cfg.defaultSubtaskId === subtask.id;
                  const saving = savingKey === `${meta.key}/${subtask.id}`;
                  return (
                    <Card key={subtask.id} className="border">
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <CardTitle className="text-sm">{subtask.displayName}</CardTitle>
                            <code className="text-xs text-muted-foreground">{subtask.id}</code>
                            {isDefault && (
                              <span className="inline-flex items-center gap-1 rounded bg-yellow-500/15 px-1.5 py-0.5 text-xs text-yellow-700">
                                <Star className="h-3 w-3" /> 默认
                              </span>
                            )}
                            {isPreset && (
                              <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-xs text-blue-700">
                                预设
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
                                className="text-destructive hover:text-destructive"
                                title="删除"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3 pt-0">
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="space-y-1">
                            <Label className="text-xs">Model</Label>
                            <Input
                              value={subtask.model}
                              onChange={(e) =>
                                updateSubtaskField(meta.key, subtask.id, "model", e.target.value)
                              }
                              placeholder="gpt-4o / gpt-image-1 / sora-1 ..."
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">展示名</Label>
                            <Input
                              value={subtask.displayName}
                              onChange={(e) =>
                                updateSubtaskField(meta.key, subtask.id, "displayName", e.target.value)
                              }
                              placeholder="子任务展示名"
                            />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">BaseURL</Label>
                          <Input
                            value={subtask.baseUrl}
                            onChange={(e) =>
                              updateSubtaskField(meta.key, subtask.id, "baseUrl", e.target.value)
                            }
                            placeholder={BASE_URL_PLACEHOLDER}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">API Key</Label>
                          <Input
                            type="password"
                            value={subtask.apiKey}
                            onChange={(e) =>
                              updateSubtaskField(meta.key, subtask.id, "apiKey", e.target.value)
                            }
                            placeholder={subtask.apiKey?.startsWith("****") ? subtask.apiKey : "sk-..."}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={subtask.isEnabled}
                              onChange={(e) =>
                                updateSubtaskField(meta.key, subtask.id, "isEnabled", e.target.checked)
                              }
                            />
                            启用
                          </label>
                          <Button
                            size="sm"
                            onClick={() => saveSubtask(meta.key, subtask.id)}
                            disabled={saving}
                          >
                            {saving ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
                            保存
                          </Button>
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
