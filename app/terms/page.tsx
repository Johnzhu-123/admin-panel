"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { TermsOfServiceModal } from "@/components/terms-of-service-modal";

export default function TermsAcceptancePage() {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.replace("/sign-in?redirect_url=/terms");
  }, [isLoaded, isSignedIn, router]);

  const accept = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/terms/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ termsVersion: "1.0" }),
      });
      if (!response.ok) throw new Error("条款接受记录未成功保存，请重试。");
      router.replace("/");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "条款接受失败，请重试。");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isLoaded || !isSignedIn) {
    return <div className="min-h-screen bg-[#0b0b0d]" />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0b0b0d] p-6 text-white">
      <div className="text-center">
        <h1 className="mb-4 text-2xl font-bold">完成账号设置</h1>
        <p className="text-gray-400">请阅读并确认当前用户协议与隐私政策。</p>
        {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}
        {submitting ? <p className="mt-2 text-sm text-gray-400">正在安全保存您的选择…</p> : null}
      </div>
      <TermsOfServiceModal open onAccept={accept} onDecline={() => router.push("/")} />
    </div>
  );
}
