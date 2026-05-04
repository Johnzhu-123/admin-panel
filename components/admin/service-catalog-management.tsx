"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  CircleCheck,
  CircleX,
  Eye,
  EyeOff,
  X as XIcon,
  Trash2,
} from "lucide-react";

/**
 * 🔧 BREAKING (2026-05 #22 ARCHITECTURAL ALIGNMENT):
 *   彻底重写以与桌面端「API 设置」面板 1:1 对齐：
 *     - 5 个 Tab：多模态 / 文本 / 图像 / 配音 / 视频
 *     - 「图像」Tab 内含 2 个独立表单（图像生成 + 图像理解，分别对应 image / vision）
 *     - 其它 Tab 各 1 个表单
 *     - 每个表单：BaseURL + API Key + 模型收纳区（chips）+ 默认模型 select +
 *       加模型输入框 + 加入分类按钮 + 一键移除
 *     - Auto-probe：BaseURL + API Key 都填好后自动 GET /models 拉候选模型，
 *       结果直接灌到「加模型」输入框的 datalist 下拉里
 *
 *   旧的「subtasks 列表」「设置默认子任务」「新增子任务」「删除子任务」
 *   完全去除——admin-panel 与桌面端的拆分粒度严格相同。
 */

type CategoryKey = "multimodal" | "text" | "image" | "vision" | "tts" | "video";

interface SubtaskConfig {
  id: string;
  displayName: string;
  description?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  models?: string[];
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

type ProbeResult = {
  ok: boolean;
  models: string[];
  error?: string;
  status?: number;
  authVerifiedVia?: "models" | "chat";
  notice?: string;
  at: number;
};

/**
 * Tab 定义。「图像 AI」tab 同时承载 image (生成) + vision (理解) 两个 category。
 * 其它 tab 一对一映射。
 */
const TABS: Array<{
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  // 该 tab 内要渲染的 category 表单（按显示顺序），label 是 form 标题
  forms: Array<{ category: CategoryKey; label: string; description: string }>;
}> = [
  {
    key: "multimodal",
    label: "多模态 AI",
    icon: Boxes,
    forms: [
      {
        category: "multimodal",
        label: "多模态 AI · 分类入库与默认模型",
        description: "对应桌面端「多模态 AI」tab，处理图像/音频/文本综合理解",
      },
    ],
  },
  {
    key: "text",
    label: "文本 AI",
    icon: FileText,
    forms: [
      {
        category: "text",
        label: "文本 AI · 分类入库与默认模型",
        description: "对应桌面端「文本 AI」tab，纯文本生成、改写、摘要、规划",
      },
    ],
  },
  {
    key: "image",
    label: "图像 AI",
    icon: ImageIcon,
    forms: [
      {
        category: "image",
        label: "图像生成 AI · 分类入库与默认模型",
        description: "对应桌面端「图像 AI」tab 上半部分（文生图 / 图生图 / 图像编辑）",
      },
      {
        category: "vision",
        label: "图像理解 AI · 分类入库与默认模型",
        description: "对应桌面端「图像 AI」tab 下半部分（识别图像内容 / 视觉问答）",
      },
    ],
  },
  {
    key: "tts",
    label: "配音 TTS",
    icon: AudioLines,
    forms: [
      {
        category: "tts",
        label: "云端 TTS · 分类入库与默认模型",
        description: "对应桌面端「配音 TTS」tab 的云端部分",
      },
    ],
  },
  {
    key: "video",
    label: "视频 AI",
    icon: Video,
    forms: [
      {
        category: "video",
        label: "视频 AI · 分类入库与默认模型",
        description: "对应桌面端「视频 AI」tab，文生视频 / 图生视频",
      },
    ],
  },
];

const ALL_CATEGORIES: CategoryKey[] = TABS.flatMap((t) => t.forms.map((f) => f.category));

const BASE_URL_PLACEHOLDER = "https://api.seeyjys.eu.org/v1";

function isMaskedApiKey(value: string | undefined | null): boolean {
  if (!value) return false;
  if (/\*{4,}/.test(value)) return true;
  if (/^\*+$/.test(value)) return true;
  return false;
}

function makeEmptySubtask(): SubtaskConfig {
  return {
    id: "default",
    displayName: "default",
    baseUrl: "",
    apiKey: "",
    model: "",
    models: [],
    isEnabled: false,
  };
}

const PROBE_DEBOUNCE_MS = 800;

export function ServiceCatalogManagement() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [encryptionConfigured, setEncryptionConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [probing, setProbing] = useState<Record<CategoryKey, boolean>>({} as Record<CategoryKey, boolean>);
  const [probeResults, setProbeResults] = useState<Record<CategoryKey, ProbeResult>>({} as Record<CategoryKey, ProbeResult>);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [addInputs, setAddInputs] = useState<Record<CategoryKey, string>>({} as Record<CategoryKey, string>);
  const [visibleApiKeys, setVisibleApiKeys] = useState<Record<CategoryKey, boolean>>({} as Record<CategoryKey, boolean>);

  // bulk-apply 共享凭据（保留旧功能）
  const [bulkBaseUrl, setBulkBaseUrl] = useState("");
  const [bulkApiKey, setBulkApiKey] = useState("");
  const [bulkApiKeyVisible, setBulkApiKeyVisible] = useState(false);
  const [bulkApplying, setBulkApplying] = useState(false);

  // debounce 句柄（每个 category 独立）
  const probeDebounceRef = useRef<Record<CategoryKey, ReturnType<typeof setTimeout> | null>>(
    {} as Record<CategoryKey, ReturnType<typeof setTimeout> | null>
  );

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
      const next = {} as Catalog;
      for (const category of ALL_CATEGORIES) {
        const cat = incoming[category];
        if (cat && cat.subtasks) {
          // 提取 default subtask；若不存在用空骨架
          const ds = cat.subtasks[cat.defaultSubtaskId] || cat.subtasks.default || makeEmptySubtask();
          next[category] = {
            displayName: cat.displayName || category,
            description: cat.description,
            defaultSubtaskId: "default",
            subtasks: { default: { ...ds, id: "default" } },
          };
        } else {
          next[category] = {
            displayName: category,
            defaultSubtaskId: "default",
            subtasks: { default: makeEmptySubtask() },
          };
        }
      }
      setCatalog(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchSettings();
    return () => {
      // 清理所有 debounce
      for (const key of Object.keys(probeDebounceRef.current)) {
        const t = probeDebounceRef.current[key as CategoryKey];
        if (t) clearTimeout(t);
      }
    };
  }, []);

  /** 单个 category 的当前 default subtask */
  const getSubtask = (cat: Catalog | null, category: CategoryKey): SubtaskConfig => {
    return (
      cat?.[category]?.subtasks?.default ||
      makeEmptySubtask()
    );
  };

  const updateSubtaskField = (
    category: CategoryKey,
    field: keyof SubtaskConfig,
    value: string | boolean | string[]
  ) => {
    setCatalog((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as Catalog;
      const sub = next[category].subtasks.default;
      if (!sub) return prev;
      (sub as unknown as Record<string, unknown>)[field as string] = value;
      return next;
    });
  };

  /**
   * 触发对某分类的探测（调用 admin probe-subtask 走 stored 凭据 fallback）。
   * baseUrl/apiKey 必填；apiKey 可省略（走 stored）
   */
  const triggerProbe = async (
    category: CategoryKey,
    baseUrl: string,
    apiKey: string
  ) => {
    if (!baseUrl) return;
    setProbing((prev) => ({ ...prev, [category]: true }));
    try {
      const payload: Record<string, unknown> = {
        action: "probe-subtask",
        category,
        subtaskId: "default",
        baseUrl,
      };
      // 若用户当前编辑了 apiKey 真值，发出来；mask 化的不要发
      if (apiKey && !isMaskedApiKey(apiKey)) {
        payload.apiKey = apiKey;
      }
      const resp = await fetch("/api/admin/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
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
      setProbeResults((prev) => ({ ...prev, [category]: result }));
    } catch (e) {
      setProbeResults((prev) => ({
        ...prev,
        [category]: {
          ok: false,
          models: [],
          error: e instanceof Error ? e.message : "网络错误",
          at: Date.now(),
        },
      }));
    } finally {
      setProbing((prev) => ({ ...prev, [category]: false }));
    }
  };

  /** baseUrl 或 apiKey 改变时调度防抖探测 */
  const scheduleAutoProbe = (
    category: CategoryKey,
    baseUrl: string,
    apiKey: string
  ) => {
    const existing = probeDebounceRef.current[category];
    if (existing) clearTimeout(existing);
    if (!baseUrl) return;
    if (!/^https?:\/\//i.test(baseUrl)) return;
    // apiKey 可空（走 stored），但 baseUrl 必须合法
    probeDebounceRef.current[category] = setTimeout(() => {
      void triggerProbe(category, baseUrl, apiKey);
    }, PROBE_DEBOUNCE_MS);
  };

  /** 保存某 category 的 default subtask */
  const saveCategory = async (category: CategoryKey) => {
    if (!catalog) return;
    const subtask = catalog[category].subtasks.default;
    if (!subtask) return;
    setSavingKey(category);
    setError("");
    setSuccess("");
    try {
      const patch: Record<string, unknown> = {
        displayName: subtask.displayName || category,
        baseUrl: subtask.baseUrl,
        model: subtask.model,
        models: Array.isArray(subtask.models) ? subtask.models : (subtask.model ? [subtask.model] : []),
        isEnabled: subtask.isEnabled,
      };
      if (subtask.apiKey && !isMaskedApiKey(subtask.apiKey)) {
        patch.apiKey = subtask.apiKey;
      }
      const resp = await fetch("/api/admin/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "update-service-subtask",
          category,
          subtaskId: "default",
          patch,
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${resp.status}`);
      }
      setSuccess(`已保存：${catalog[category].displayName}`);
      // 不重新拉，保留草稿
      setCatalog((prev) => {
        if (!prev) return prev;
        const next = structuredClone(prev) as Catalog;
        const target = next[category]?.subtasks?.default;
        if (target) target.updatedAt = new Date().toISOString();
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingKey(null);
    }
  };

  /** 把当前「加模型」输入框的值加入 models[] */
  const addModel = (category: CategoryKey) => {
    const raw = (addInputs[category] || "").trim();
    if (!raw) return;
    setCatalog((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as Catalog;
      const sub = next[category].subtasks.default;
      if (!sub) return prev;
      const list = Array.isArray(sub.models) ? [...sub.models] : [];
      if (!list.includes(raw)) {
        list.push(raw);
      }
      sub.models = list;
      // 第一次加入时把 default model 也设上
      if (!sub.model) sub.model = raw;
      return next;
    });
    setAddInputs((prev) => ({ ...prev, [category]: "" }));
  };

  /** 一键添加 probe 拉到的全部模型 */
  const addAllProbed = (category: CategoryKey) => {
    const probed = probeResults[category]?.models || [];
    if (!probed.length) return;
    setCatalog((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as Catalog;
      const sub = next[category].subtasks.default;
      if (!sub) return prev;
      const seen = new Set<string>();
      const merged: string[] = [];
      const head = (sub.model || "").trim();
      if (head) {
        merged.push(head);
        seen.add(head);
      }
      for (const m of probed) {
        const t = (m || "").trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        merged.push(t);
      }
      for (const m of sub.models || []) {
        const t = (m || "").trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        merged.push(t);
      }
      sub.models = merged;
      if (!sub.model && merged.length) sub.model = merged[0];
      return next;
    });
  };

  /** 移除单个 model */
  const removeModel = (category: CategoryKey, model: string) => {
    setCatalog((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as Catalog;
      const sub = next[category].subtasks.default;
      if (!sub) return prev;
      sub.models = (sub.models || []).filter((m) => m !== model);
      if (sub.model === model) {
        sub.model = sub.models?.[0] || "";
      }
      return next;
    });
  };

  /** 一键清空 models 收纳区 */
  const clearAllModels = (category: CategoryKey) => {
    if (!confirm("确认清空当前分类的全部模型？")) return;
    setCatalog((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as Catalog;
      const sub = next[category].subtasks.default;
      if (!sub) return prev;
      sub.models = [];
      sub.model = "";
      return next;
    });
  };

  /** 一键应用 baseUrl + apiKey 到所有 6 个 category */
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
      payload.isEnabled = true;
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
      const appliedCount = data?.applied ?? "全部";
      setBulkApiKey("");
      await fetchSettings();
      setSuccess(`已把凭据写入 ${appliedCount} 个分类，请检查各 tab 并按需点「测试连接」拉模型列表`);
      // 自动给每个 category 触发 probe
      if (trimmedBase) {
        for (const cat of ALL_CATEGORIES) {
          scheduleAutoProbe(cat, trimmedBase, "");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "一键应用失败");
    } finally {
      setBulkApplying(false);
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

  /** 渲染单个 category 的整体表单（与桌面端 renderCategoryCatalogEditor 1:1 对齐） */
  const renderCategoryForm = (category: CategoryKey, label: string, description: string) => {
    const sub = getSubtask(catalog, category);
    const probeResult = probeResults[category];
    const isProbing = !!probing[category];
    const isSaving = savingKey === category;
    const candidateModels = probeResult?.ok ? probeResult.models : [];
    const datalistId = `models-options-${category}`;
    const apiKeyVisible = !!visibleApiKeys[category];
    const addInput = addInputs[category] || "";
    const models = sub.models || [];
    return (
      <Card key={category} className="bg-slate-900/40 border-slate-700/60 shadow-sm">
        <CardHeader className="pb-3 border-b border-slate-700/40">
          <CardTitle className="text-sm text-slate-100 flex items-center justify-between gap-2">
            <span>{label}</span>
            {sub.isEnabled ? (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300 font-normal">启用</span>
            ) : (
              <span className="rounded bg-slate-500/20 px-1.5 py-0.5 text-xs text-slate-400 font-normal">未启用</span>
            )}
          </CardTitle>
          <p className="text-xs text-slate-500">{description}</p>
        </CardHeader>
        <CardContent className="space-y-3 pt-3">
          {/* BaseURL */}
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400">BaseURL</Label>
            <Input
              value={sub.baseUrl}
              onChange={(e) => {
                const v = e.target.value;
                updateSubtaskField(category, "baseUrl", v);
                scheduleAutoProbe(category, v.trim(), sub.apiKey);
              }}
              placeholder={BASE_URL_PLACEHOLDER}
              className="bg-slate-900/70 border-slate-600 text-slate-100 placeholder:text-slate-500"
            />
          </div>

          {/* API Key */}
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400">API Key</Label>
            <div className="relative">
              <Input
                type={apiKeyVisible ? "text" : "password"}
                value={sub.apiKey}
                onChange={(e) => {
                  const v = e.target.value;
                  updateSubtaskField(category, "apiKey", v);
                  scheduleAutoProbe(category, sub.baseUrl.trim(), v);
                }}
                placeholder={isMaskedApiKey(sub.apiKey) ? sub.apiKey : "sk-..."}
                className="bg-slate-900/70 border-slate-600 text-slate-100 placeholder:text-slate-500 pr-9"
              />
              <button
                type="button"
                onClick={() => setVisibleApiKeys((prev) => ({ ...prev, [category]: !prev[category] }))}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                title={apiKeyVisible ? "隐藏" : "显示"}
                aria-label={apiKeyVisible ? "隐藏 API Key" : "显示 API Key"}
              >
                {apiKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {isMaskedApiKey(sub.apiKey) && apiKeyVisible && (
              <p className="text-[11px] text-slate-500">
                出于安全考虑，已存储的 Key 仅显示掩码尾部；如需完整值请重新填写后保存。
              </p>
            )}
          </div>

          {/* Probe 状态 */}
          {(isProbing || probeResult) && (
            <div
              className={`rounded-md border p-2.5 text-xs ${
                isProbing
                  ? "border-slate-500/40 bg-slate-500/10 text-slate-300"
                  : probeResult?.ok
                  ? probeResult.authVerifiedVia === "chat"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-red-500/40 bg-red-500/10 text-red-300"
              }`}
            >
              {isProbing ? (
                <div className="flex items-center gap-2">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  <span>正在调用上游 /models 拉取候选模型...</span>
                </div>
              ) : probeResult?.ok ? (
                <div className="flex items-start gap-2">
                  <CircleCheck className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    {probeResult.authVerifiedVia === "chat"
                      ? probeResult.notice ||
                        "上游 /models 端点拒绝了 Key，但 chat/completions 已验证 Key 可用，请手动填写模型。"
                      : `连接成功，已拉到 ${probeResult.models.length} 个候选模型 — 在「分类模型」输入框点击查看下拉，或点「+ 全部加入」一键导入。`}
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <CircleX className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{probeResult?.error || `HTTP ${probeResult?.status || 0}`}</span>
                </div>
              )}
            </div>
          )}

          {/* 分类模型（输入 + datalist 候选）+ 加入分类 + 一键移除 */}
          <div className="grid gap-2 md:grid-cols-[1fr_auto]">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-400">
                分类模型 <span className="text-slate-500">（来自上游 /models 的候选；可下拉选择或手动输入）</span>
              </Label>
              <Input
                list={candidateModels.length ? datalistId : undefined}
                value={addInput}
                onChange={(e) =>
                  setAddInputs((prev) => ({ ...prev, [category]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addModel(category);
                  }
                }}
                placeholder="例如 gpt-4o / gpt-image-2 / 在此粘贴模型名 ..."
                className="bg-slate-900/70 border-slate-600 text-slate-100 placeholder:text-slate-500"
              />
              {candidateModels.length > 0 && (
                <datalist id={datalistId}>
                  {candidateModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
            </div>
            <div className="flex items-end gap-2">
              <Button
                size="sm"
                onClick={() => addModel(category)}
                disabled={!addInput.trim()}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
                title="把当前输入框的模型名加入下方「模型收纳区」"
              >
                <Plus className="mr-1 h-3 w-3" /> 加入分类
              </Button>
              {candidateModels.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => addAllProbed(category)}
                  className="border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
                  title={`把上游 ${candidateModels.length} 个候选模型一次性导入收纳区`}
                >
                  <Plus className="mr-1 h-3 w-3" /> 全部加入 ({candidateModels.length})
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => clearAllModels(category)}
                disabled={!models.length}
                className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                title="一键清空收纳区"
              >
                <Trash2 className="mr-1 h-3 w-3" /> 一键移除
              </Button>
            </div>
          </div>

          {/* 默认模型 select */}
          {models.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-400">默认模型</Label>
              <select
                value={sub.model}
                onChange={(e) => updateSubtaskField(category, "model", e.target.value)}
                className="w-full rounded-md bg-slate-900/70 border border-slate-600 text-slate-100 px-3 py-2 text-sm focus:outline-none focus:border-indigo-500/60"
              >
                <option value="">请选择默认模型</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 模型收纳区 chips */}
          <div className="rounded-md border border-slate-700/60 bg-slate-900/40">
            <div className="flex items-center justify-between border-b border-slate-700/40 px-3 py-2">
              <span className="text-xs text-slate-400">模型收纳区</span>
              <span className="text-[11px] text-slate-500">{models.length} 个</span>
            </div>
            {models.length ? (
              <div className="flex flex-wrap gap-2 p-3">
                {models.map((m) => {
                  const isDefault = m === sub.model;
                  return (
                    <div
                      key={`${category}-chip-${m}`}
                      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                        isDefault
                          ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-200"
                          : "border-slate-600/60 bg-slate-800/50 text-slate-200"
                      }`}
                    >
                      {isDefault && <span title="默认模型">⭐</span>}
                      <span className="font-mono">{m}</span>
                      <button
                        type="button"
                        onClick={() => removeModel(category, m)}
                        className="ml-1 rounded p-0.5 text-slate-400 hover:bg-slate-700/60 hover:text-red-300"
                        title="移除该模型"
                        aria-label={`移除 ${m}`}
                      >
                        <XIcon className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-6 text-center text-xs text-slate-500">
                暂无已加入模型 — 在上方填写 BaseURL+API Key 等待自动探测，或手动在「分类模型」输入框输入后点「加入分类」
              </div>
            )}
          </div>

          {/* 启用 + 测试连接 + 保存 */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={sub.isEnabled}
                onChange={(e) => updateSubtaskField(category, "isEnabled", e.target.checked)}
                className="accent-indigo-500"
              />
              启用本分类
            </label>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => triggerProbe(category, sub.baseUrl, sub.apiKey)}
                disabled={isProbing || isSaving || !sub.baseUrl}
                className="border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
                title="手动重新拉取 /models"
              >
                {isProbing ? (
                  <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3 w-3" />
                )}
                测试连接 + 重拉模型
              </Button>
              <Button
                size="sm"
                onClick={() => saveCategory(category)}
                disabled={isSaving}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                {isSaving ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
                保存
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <Card className="bg-slate-800/50 border-slate-700/70 backdrop-blur-sm shadow-lg">
      <CardHeader className="space-y-2 pb-4 border-b border-slate-700/60">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base text-white">
            <KeyRound className="h-5 w-5 text-indigo-400" />
            AI 服务清单 — 与桌面端「API 设置」面板 1:1 对齐
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

        {/* 通用凭据 — 一键写入全部 6 个 category */}
        <div className="rounded-lg border border-dashed border-slate-600/70 bg-slate-900/40 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-indigo-400" />
            <span className="text-sm font-medium text-slate-200">
              通用凭据 · 一键写入全部分类（多模态 / 文本 / 图像生成 / 图像理解 / TTS / 视频）
            </span>
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
          <div className="flex items-center justify-end pt-1">
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

        {/* 5 个 Tab，与桌面端完全对齐 */}
        <Tabs defaultValue="multimodal" className="w-full">
          <TabsList className="mb-4 grid w-full grid-cols-5 bg-slate-900/40 border border-slate-700/60 p-1 h-auto rounded-lg">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <TabsTrigger
                  key={tab.key}
                  value={tab.key}
                  className="flex items-center gap-2 text-slate-400 data-[state=active]:bg-indigo-500/20 data-[state=active]:text-indigo-300 data-[state=active]:shadow-sm rounded-md py-2"
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden sm:inline">{tab.label}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          {TABS.map((tab) => (
            <TabsContent key={tab.key} value={tab.key} className="space-y-3 mt-0">
              {tab.forms.map((form) => renderCategoryForm(form.category, form.label, form.description))}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
