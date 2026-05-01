"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
} from "lucide-react";

interface CategoryConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  isEnabled: boolean;
  updatedAt?: string;
}

const CATEGORY_META: Array<{
  key: "multimodal" | "text" | "image" | "tts" | "video";
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  models: string[];
  baseUrlPlaceholder: string;
}> = [
  {
    key: "multimodal",
    label: "多模态 AI",
    description: "图文混合输入、视觉理解、文档分析（如 GPT-4o、Gemini-1.5-Pro 等）",
    icon: Boxes,
    models: ["gpt-4o-mini", "gpt-4o", "gemini-1.5-pro", "claude-3-5-sonnet-20241022"],
    baseUrlPlaceholder: "https://api.seeyjys.eu.org/v1",
  },
  {
    key: "text",
    label: "文本 AI",
    description: "纯文本生成、大纲、配音脚本撰写（如 DeepSeek-Chat、GPT-4o-mini 等）",
    icon: FileText,
    models: ["deepseek-chat", "gpt-4o-mini", "qwen2.5-72b-instruct"],
    baseUrlPlaceholder: "https://api.seeyjys.eu.org/v1",
  },
  {
    key: "image",
    label: "图像 AI",
    description: "文生图、图生图（如 GPT-Image-1、DALL·E 3、Flux 等）",
    icon: ImageIcon,
    models: ["gpt-image-1", "dall-e-3", "flux-1.1-pro", "stable-diffusion-3-large"],
    baseUrlPlaceholder: "https://api.seeyjys.eu.org/v1",
  },
  {
    key: "tts",
    label: "配音 TTS",
    description: "OpenAI 兼容的语音合成（tts-1、tts-1-hd、IndexTTS 等）",
    icon: AudioLines,
    models: ["tts-1", "tts-1-hd", "indextts2"],
    baseUrlPlaceholder: "https://api.seeyjys.eu.org/v1",
  },
  {
    key: "video",
    label: "视频 AI",
    description: "文生视频（Sora-1、可灵、Vidu Q1 等）",
    icon: Video,
    models: ["sora-1", "kling-v1-pro", "vidu-q1"],
    baseUrlPlaceholder: "https://api.seeyjys.eu.org/v1",
  },
];

type Catalog = Record<(typeof CATEGORY_META)[number]["key"], CategoryConfig>;

const EMPTY_CONFIG: CategoryConfig = {
  baseUrl: "",
  apiKey: "",
  model: "",
  isEnabled: false,
};

function buildEmptyCatalog(): Catalog {
  return CATEGORY_META.reduce((acc, item) => {
    acc[item.key] = { ...EMPTY_CONFIG };
    return acc;
  }, {} as Catalog);
}

export function AdminServiceCatalogManager() {
  const [catalog, setCatalog] = useState<Catalog>(buildEmptyCatalog());
  const [draft, setDraft] = useState<Catalog>(buildEmptyCatalog());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [encryptionConfigured, setEncryptionConfigured] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchCatalog();
  }, []);

  const fetchCatalog = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/system-settings", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "加载服务配置失败");
      const incoming = (data?.settings?.serviceCatalog || {}) as Partial<Catalog>;
      const next = buildEmptyCatalog();
      for (const meta of CATEGORY_META) {
        const cfg = incoming[meta.key];
        if (cfg) {
          next[meta.key] = {
            baseUrl: typeof cfg.baseUrl === "string" ? cfg.baseUrl : "",
            apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey : "",
            model: typeof cfg.model === "string" ? cfg.model : "",
            isEnabled: cfg.isEnabled === true,
            updatedAt: cfg.updatedAt,
          };
        }
      }
      setCatalog(next);
      setDraft(next);
      setEncryptionConfigured(data?.encryption?.configured !== false);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  const updateDraft = (
    category: keyof Catalog,
    patch: Partial<CategoryConfig>
  ) => {
    setDraft((prev) => ({
      ...prev,
      [category]: { ...prev[category], ...patch },
    }));
  };

  const handleSaveCategory = async (category: keyof Catalog) => {
    setSaving(category);
    setMessage(null);
    try {
      const cfg = draft[category];
      const patch: Record<string, unknown> = {
        baseUrl: cfg.baseUrl.trim(),
        model: cfg.model.trim(),
        isEnabled: cfg.isEnabled,
      };
      if (cfg.apiKey && !cfg.apiKey.includes("*")) {
        patch.apiKey = cfg.apiKey;
      }
      const res = await fetch("/api/admin/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-service-category",
          category,
          patch,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "保存失败");
      setMessage(`${CATEGORY_META.find((m) => m.key === category)?.label} 已保存`);
      await fetchCatalog();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card className="bg-slate-800/50 border-slate-700">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-white flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-emerald-400" />
              AI 服务清单（多模态 / 文本 / 图像 / TTS / 视频）
            </CardTitle>
            <CardDescription className="text-slate-400">
              在这里维护 5 类服务各自的 BaseURL、API Key、Model；保存后授权用户的客户端将自动应用，无需手动配置。
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <div
              className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
                encryptionConfigured
                  ? "text-emerald-300 bg-emerald-500/10 border border-emerald-500/30"
                  : "text-amber-300 bg-amber-500/10 border border-amber-500/30"
              }`}
            >
              {encryptionConfigured ? (
                <>
                  <ShieldCheck className="h-3.5 w-3.5" /> 加密已启用
                </>
              ) : (
                <>
                  <ShieldAlert className="h-3.5 w-3.5" /> 未配置加密密钥
                </>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchCatalog}
              disabled={loading}
              className="border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
              刷新
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {message && (
          <div className="mb-4 text-xs text-slate-200 bg-slate-700/40 rounded px-3 py-2">
            {message}
          </div>
        )}
        <Tabs defaultValue={CATEGORY_META[0].key} className="w-full">
          <TabsList className="grid grid-cols-5 bg-slate-900/40 mb-4">
            {CATEGORY_META.map((meta) => {
              const Icon = meta.icon;
              const enabled = catalog[meta.key].isEnabled;
              return (
                <TabsTrigger
                  key={meta.key}
                  value={meta.key}
                  className="flex items-center gap-2 data-[state=active]:bg-slate-700/50 data-[state=active]:text-white text-slate-400"
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{meta.label}</span>
                  {enabled && (
                    <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {CATEGORY_META.map((meta) => {
            const cfg = draft[meta.key];
            const updatedAt = catalog[meta.key].updatedAt;
            return (
              <TabsContent key={meta.key} value={meta.key}>
                <div className="space-y-4 rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-white font-semibold flex items-center gap-2">
                        <meta.icon className="h-4 w-4" />
                        {meta.label}
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">{meta.description}</p>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-emerald-500"
                        checked={cfg.isEnabled}
                        onChange={(event) =>
                          updateDraft(meta.key, { isEnabled: event.target.checked })
                        }
                      />
                      启用此服务
                    </label>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-slate-300">BaseURL</Label>
                      <Input
                        value={cfg.baseUrl}
                        onChange={(event) =>
                          updateDraft(meta.key, { baseUrl: event.target.value })
                        }
                        placeholder={meta.baseUrlPlaceholder}
                        className="bg-slate-900/70 border-slate-600 text-slate-100"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-slate-300">Model（默认型号）</Label>
                      <div className="flex gap-2">
                        <Input
                          list={`models-${meta.key}`}
                          value={cfg.model}
                          onChange={(event) =>
                            updateDraft(meta.key, { model: event.target.value })
                          }
                          placeholder={meta.models[0]}
                          className="bg-slate-900/70 border-slate-600 text-slate-100"
                        />
                        <datalist id={`models-${meta.key}`}>
                          {meta.models.map((m) => (
                            <option key={m} value={m} />
                          ))}
                        </datalist>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-slate-300">API Key</Label>
                    <Input
                      type="password"
                      value={cfg.apiKey}
                      onChange={(event) =>
                        updateDraft(meta.key, { apiKey: event.target.value })
                      }
                      placeholder={
                        catalog[meta.key].apiKey
                          ? `当前已配置（${catalog[meta.key].apiKey}）— 留空则保留旧值`
                          : "sk-..."
                      }
                      className="bg-slate-900/70 border-slate-600 text-slate-100 font-mono"
                    />
                    <p className="text-xs text-slate-500">
                      将以 AES-256-GCM 加密存入数据库，永远不会下发到客户端。
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-4 pt-2">
                    <p className="text-xs text-slate-500">
                      {updatedAt
                        ? `最近更新：${new Date(updatedAt).toLocaleString()}`
                        : "尚未保存"}
                    </p>
                    <Button
                      onClick={() => handleSaveCategory(meta.key)}
                      disabled={saving === meta.key}
                      className="bg-emerald-600 hover:bg-emerald-700"
                    >
                      <Save className="h-3.5 w-3.5 mr-1" />
                      {saving === meta.key ? "保存中..." : "保存此项"}
                    </Button>
                  </div>
                </div>
              </TabsContent>
            );
          })}
        </Tabs>
      </CardContent>
    </Card>
  );
}
