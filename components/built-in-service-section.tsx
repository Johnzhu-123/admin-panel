/**
 * Built-in API Service Section Component
 * Compact component for integration into existing API configuration modal
 * Validates: Requirements 1.1, 1.2, 1.3, 3.2
 */

"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useUser } from '@clerk/nextjs';

interface ServiceStatus {
  isUsingBuiltIn: boolean;
  currentService: {
    id: string;
    name: string;
    description: string;
    provider: string;
    isBuiltIn: boolean;
    isAvailable: boolean;
  };
  lastSwitched: Date;
}

interface BuiltInServiceSectionProps {
  onServiceChange?: (isUsingBuiltIn: boolean, serviceId: string) => void;
}

type BuiltInUserSummary = {
  group: string;
  dailyRequests: number;
  monthlyRequests: number;
  dailyUsed: number;
  monthlyUsed: number;
};

// Styles matching the existing API modal design
const styles = {
  section: {
    borderTop: '1px solid #2b2b31',
    paddingTop: '16px',
    marginTop: '16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '0.95rem',
    fontWeight: 700,
    color: '#f1f1f5',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  badge: {
    background: '#facc15',
    color: '#000',
    fontSize: '0.6rem',
    padding: '2px 6px',
    borderRadius: '3px',
    fontWeight: 800,
    letterSpacing: '0.05em',
  },
  description: {
    margin: 0,
    fontSize: '0.8rem',
    color: '#9a9aa3',
    lineHeight: 1.5,
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    background: '#17171b',
    border: '1px solid #2b2b31',
    borderRadius: '8px',
  },
  quotaRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: '8px',
    padding: '12px 16px',
    background: '#111116',
    border: '1px solid #2b2b31',
    borderRadius: '8px',
  },
  quotaBlock: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  quotaLabel: {
    fontSize: '0.7rem',
    color: '#9a9aa3',
    margin: 0,
  },
  quotaValue: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: '#f1f1f5',
    margin: 0,
  },
  usageRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '8px',
    padding: '12px 16px',
    background: '#0f0f13',
    border: '1px solid #2b2b31',
    borderRadius: '8px',
  },
  usageBlock: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  usageLabel: {
    fontSize: '0.7rem',
    color: '#9a9aa3',
    margin: 0,
  },
  usageValue: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: '#e2e8f0',
    margin: 0,
  },
  statusInfo: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  statusLabel: {
    fontSize: '0.8rem',
    color: '#9a9aa3',
    margin: 0,
  },
  statusValue: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: '#f1f1f5',
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  switchButton: {
    padding: '8px 16px',
    borderRadius: '6px',
    border: 'none',
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    minWidth: '80px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
  },
  switchButtonPrimary: {
    background: '#facc15',
    color: '#000',
  },
  switchButtonSecondary: {
    background: '#3b3b42',
    color: '#f1f1f5',
  },
  switchButtonDisabled: {
    background: '#2b2b31',
    color: '#6b7280',
    cursor: 'not-allowed',
  },
  loadingSpinner: {
    display: 'inline-block',
    width: '12px',
    height: '12px',
    border: '2px solid #3b3b42',
    borderTop: '2px solid #facc15',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  unauthorizedCard: {
    padding: '16px',
    background: 'rgba(59, 130, 246, 0.1)',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    borderRadius: '8px',
    color: '#3b82f6',
    fontSize: '0.8rem',
    lineHeight: 1.5,
    textAlign: 'center' as const,
  },
  errorMessage: {
    padding: '8px 12px',
    background: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    borderRadius: '6px',
    color: '#ef4444',
    fontSize: '0.75rem',
    marginTop: '8px',
  },
  successMessage: {
    padding: '8px 12px',
    background: 'rgba(34, 197, 94, 0.1)',
    border: '1px solid rgba(34, 197, 94, 0.3)',
    borderRadius: '6px',
    color: '#22c55e',
    fontSize: '0.75rem',
    marginTop: '8px',
  },
};

export const BuiltInServiceSection: React.FC<BuiltInServiceSectionProps> = ({
  onServiceChange,
}) => {
  const { isSignedIn, user } = useUser();
  
  // State
  const [isAuthorized, setIsAuthorized] = useState<boolean>(false);
  const [currentStatus, setCurrentStatus] = useState<ServiceStatus | null>(null);
  const [userSummary, setUserSummary] = useState<BuiltInUserSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [switching, setSwitching] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');

  // Load service data function (defined before useEffect)
  const loadServiceData = useCallback(async () => {
    const userEmail = user?.primaryEmailAddress?.emailAddress;
    if (!userEmail) return;

    try {
      setLoading(true);
      setError('');

      // Check authorization
      const authResponse = await fetch(`/api/ai/built-in-service?action=authorization&userId=${encodeURIComponent(userEmail)}`);
      let authData: { isAuthorized?: boolean } | null = null;
      if (authResponse.ok) {
        authData = await authResponse.json();
        setIsAuthorized(authData.isAuthorized);
      }

      // Get current status
      const statusResponse = await fetch(`/api/ai/built-in-service?action=status&userId=${encodeURIComponent(userEmail)}`);
      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        setCurrentStatus(statusData.status);
      }

      if (authData?.isAuthorized) {
        const summaryResponse = await fetch(
          `/api/ai/built-in-service?action=user-summary&userId=${encodeURIComponent(userEmail)}`
        );
        if (summaryResponse.ok) {
          const summaryData = await summaryResponse.json();
          setUserSummary(summaryData.user || null);
        } else {
          setUserSummary(null);
        }
      } else {
        setUserSummary(null);
      }

    } catch (error) {
      console.error('Error loading service data:', error);
      setError('加载失败');
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Load service data on mount
  useEffect(() => {
    if (isSignedIn && user?.primaryEmailAddress?.emailAddress) {
      loadServiceData();
    } else {
      setLoading(false);
    }
  }, [isSignedIn, user, loadServiceData]);

  // Listen for usage updates
  useEffect(() => {
    if (!isSignedIn) return;
    const handleUsageUpdate = () => {
      loadServiceData();
    };
    window.addEventListener('built-in-usage-updated', handleUsageUpdate);
    return () => {
      window.removeEventListener('built-in-usage-updated', handleUsageUpdate);
    };
  }, [isSignedIn, loadServiceData]);

  const handleToggleService = async () => {
    const userEmail = user?.primaryEmailAddress?.emailAddress;
    if (!userEmail || switching || !currentStatus) return;

    try {
      setSwitching(true);
      setError('');
      setSuccess('');

      const isCurrentlyBuiltIn = currentStatus.isUsingBuiltIn;
      let response: Response;
      
      if (isCurrentlyBuiltIn) {
        // Switch to custom service
        response = await fetch('/api/ai/built-in-service', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: userEmail,
            action: 'switch-to-custom',
            customConfig: {
              baseUrl: 'https://api.openai.com/v1',
              apiKey: 'user-provided-key',
              model: 'dall-e-3',
              authType: 'bearer',
            },
          }),
        });
      } else {
        // Switch to built-in service (use first available built-in service)
        const servicesResponse = await fetch(`/api/ai/built-in-service?action=services&userId=${encodeURIComponent(userEmail)}`);
        if (servicesResponse.ok) {
          const servicesData = await servicesResponse.json();
          const builtInService = servicesData.services?.find((s: any) => s.isBuiltIn && s.isAvailable);
          
          if (builtInService) {
            response = await fetch('/api/ai/built-in-service', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userId: userEmail,
                action: 'switch-to-built-in',
                serviceId: builtInService.id,
              }),
            });
          } else {
            setError('没有可用的内置服务');
            return;
          }
        } else {
          setError('获取服务列表失败');
          return;
        }
      }

      if (response!.ok) {
        const result = await response!.json();
        if (result.result?.success) {
          setSuccess(result.result.message);
          await loadServiceData(); // Reload to get updated status
          onServiceChange?.(!isCurrentlyBuiltIn, result.result.serviceId);
        } else {
          setError(result.result?.message || '切换失败');
        }
      } else {
        setError('网络请求失败');
      }

    } catch (error) {
      console.error('Error switching service:', error);
      setError('切换时发生错误');
    } finally {
      setSwitching(false);
    }
  };

  if (!isSignedIn) {
    return null; // Don't show anything if not signed in
  }

  return (
    <div style={styles.section}>
      <h4 style={styles.sectionTitle}>
        内置API服务
        <span style={styles.badge}>PRO</span>
      </h4>
      
      <p style={styles.description}>
        使用维护者提供的稳定API服务，无需配置密钥。
      </p>

      {loading ? (
        <div style={styles.statusRow}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#9a9aa3' }}>
            <div style={styles.loadingSpinner}></div>
            <span style={{ fontSize: '0.8rem' }}>检查授权状态...</span>
          </div>
        </div>
      ) : !isAuthorized ? (
        <div style={styles.unauthorizedCard}>
          <p style={{ margin: '0 0 4px 0', fontWeight: 600 }}>🔒 需要授权</p>
          <p style={{ margin: 0 }}>
            内置API服务仅对授权用户开放，请继续使用自定义API配置。
          </p>
        </div>
      ) : currentStatus ? (
        <>
          <div style={styles.statusRow}>
            <div style={styles.statusInfo}>
              <p style={styles.statusLabel}>当前服务</p>
              <p style={styles.statusValue}>
                <span>{currentStatus.isUsingBuiltIn ? '🟢' : '🔵'}</span>
                <span>{currentStatus.currentService.name}</span>
              </p>
            </div>
            
            <button
              style={{
                ...styles.switchButton,
                ...(switching 
                  ? styles.switchButtonDisabled 
                  : currentStatus.isUsingBuiltIn 
                    ? styles.switchButtonSecondary 
                    : styles.switchButtonPrimary
                ),
              }}
              disabled={switching}
              onClick={handleToggleService}
            >
              {switching ? (
                <>
                  <div style={styles.loadingSpinner}></div>
                  <span>切换中</span>
                </>
              ) : currentStatus.isUsingBuiltIn ? (
                '切换到自定义'
              ) : (
                '切换到内置'
              )}
            </button>
          </div>

          {userSummary && (
            <div style={styles.quotaRow}>
              <div style={styles.quotaBlock}>
                <p style={styles.quotaLabel}>用户分组</p>
                <p style={styles.quotaValue}>{userSummary.group}</p>
              </div>
              <div style={styles.quotaBlock}>
                <p style={styles.quotaLabel}>每日上限</p>
                <p style={styles.quotaValue}>{userSummary.dailyRequests} 张</p>
              </div>
              <div style={styles.quotaBlock}>
                <p style={styles.quotaLabel}>每月上限</p>
                <p style={styles.quotaValue}>{userSummary.monthlyRequests} 张</p>
              </div>
            </div>
          )}

          {userSummary && (
            <div style={styles.usageRow}>
              <div style={styles.usageBlock}>
                <p style={styles.usageLabel}>今日已用</p>
                <p style={styles.usageValue}>{userSummary.dailyUsed} 张</p>
              </div>
              <div style={styles.usageBlock}>
                <p style={styles.usageLabel}>本月已用</p>
                <p style={styles.usageValue}>{userSummary.monthlyUsed} 张</p>
              </div>
            </div>
          )}

          {/* Messages */}
          {error && (
            <div style={styles.errorMessage}>
              ❌ {error}
            </div>
          )}
          
          {success && (
            <div style={styles.successMessage}>
              ✅ {success}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
};

export default BuiltInServiceSection;
