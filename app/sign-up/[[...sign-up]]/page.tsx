'use client';

import { useState } from 'react';
import { SignUp } from "@clerk/nextjs";
import { TermsOfServiceModal } from '@/components/terms-of-service-modal';
import { useRouter } from 'next/navigation';

export default function SignUpPage() {
  const [showTerms, setShowTerms] = useState(true);
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const router = useRouter();

  // 检查用户是否已经接受过协议
  const handleAcceptTerms = async () => {
    setIsRecording(true);
    
    try {
      // 记录到数据库
      const response = await fetch('/api/terms/accept', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          termsVersion: '1.0',
          email: null // 用户还未注册，暂时为 null
        }),
      });

      if (response.ok) {
        const data = await response.json();
        console.log('Terms acceptance recorded:', data);
        
        // 保存到 localStorage
        localStorage.setItem('terms-accepted', 'true');
        localStorage.setItem('terms-accepted-date', new Date().toISOString());
        localStorage.setItem('terms-version', '1.0');
        
        setHasAcceptedTerms(true);
        setShowTerms(false);
      } else {
        console.error('Failed to record terms acceptance');
        // 即使记录失败，也允许用户继续（降级处理）
        localStorage.setItem('terms-accepted', 'true');
        localStorage.setItem('terms-accepted-date', new Date().toISOString());
        setHasAcceptedTerms(true);
        setShowTerms(false);
      }
    } catch (error) {
      console.error('Error recording terms acceptance:', error);
      // 降级处理：即使 API 调用失败，也允许用户继续
      localStorage.setItem('terms-accepted', 'true');
      localStorage.setItem('terms-accepted-date', new Date().toISOString());
      setHasAcceptedTerms(true);
      setShowTerms(false);
    } finally {
      setIsRecording(false);
    }
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
            <p className="text-gray-400">
              {isRecording ? '正在记录您的同意...' : '请先阅读并同意用户协议'}
            </p>
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
        path="/sign-up"
        signInUrl="/sign-in"
      />
    </div>
  );
}
