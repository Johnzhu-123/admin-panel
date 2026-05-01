'use client';

import { useState } from 'react';
import { SignUp } from "@clerk/nextjs";
import { TermsOfServiceModal } from '@/components/terms-of-service-modal';
import { useRouter } from 'next/navigation';

export default function SignUpWithTermsPage() {
  const [showTerms, setShowTerms] = useState(true);
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState(false);
  const router = useRouter();

  // 检查用户是否已经接受过协议（使用 localStorage）
  const handleAcceptTerms = () => {
    localStorage.setItem('terms-accepted', 'true');
    setHasAcceptedTerms(true);
    setShowTerms(false);
  };

  const handleDeclineTerms = () => {
    router.push('/');
  };

  if (!hasAcceptedTerms) {
    return (
      <>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#0b0b0d",
            padding: "24px",
          }}
        >
          <div className="text-center text-white">
            <h1 className="text-2xl font-bold mb-4">欢迎使用 AI 图像生成服务</h1>
            <p className="text-gray-400">请先阅读并同意用户协议</p>
          </div>
        </div>
        <TermsOfServiceModal
          open={showTerms}
          onAccept={handleAcceptTerms}
          onDecline={handleDeclineTerms}
        />
      </>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0b0b0d",
        padding: "24px",
      }}
    >
      <SignUp
        appearance={{
          variables: {
            colorBackground: "#101013",
            colorPrimary: "#facc15",
            colorText: "#f1f1f5",
            colorTextSecondary: "#9a9aa3",
            colorInputBackground: "#1f1f24",
            colorInputText: "#f1f1f5",
            colorDanger: "#ef4444",
          },
        }}
        routing="path"
        path="/sign-up-with-terms"
        signInUrl="/sign-in"
      />
    </div>
  );
}
