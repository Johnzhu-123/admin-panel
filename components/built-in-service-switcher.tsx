/**
 * Built-in API Service Switcher Component
 * Provides one-click switching between built-in and custom API services
 * Validates: Requirements 1.1, 1.2, 1.3, 3.2
 */

"use client";

import React, { useState, useEffect } from 'react';
import { useUser } from '@clerk/nextjs';

// Types
interface ServiceOption {
  id: string;
  name: string;
  description: string;
  provider: string;
  isBuiltIn: boolean;
  isAvailable: boolean;
}

interface ServiceStatus {
  isUsingBuiltIn: boolean;
  currentService: ServiceOption;
  lastSwitched: Date;
}

interface SwitchResult {
  success: boolean;
  serviceId: string;
  message: string;
  error?: string;
}

interface BuiltInServiceSwitcherProps {
  onServiceChange?: (isUsingBuiltIn: boolean, serviceId: string) => void;
  className?: string;
  style?: React.CSSProperties;
}

// Styles matching the existing app design
const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
    padding: '20px',
    background: 'linear-gradient(180deg, #1a1a1f 0%, #151519 100%)',
    border: '1px solid #2b2b31',
    borderRadius: '16px',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 8px 24px rgba(0,0,0,0.35)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '8px',
  },
  title: {
    margin: 0,
    fontSize: '1rem',
    fontWeight: 700,
    color: '#f1f1f5',
    letterSpacing: '0.01em',
  },
  badge: {
    background: '#facc15',
    color: '#000',
    fontSize: '0.6rem',
    padding: '2px 6px',
    borderRadius: '4px',
    fontWeight: 800,
    letterSpacing: '0.05em',
  },
  description: {
    margin: 0,
    fontSize: '0.85rem',
    color: '#9a9aa3',
    lineHeight: 1.5,
    marginBottom: '16px',
  },
  statusCard: {
    padding: '16px',
    background: '#17171b',
    border: '1px solid #2b2b31',
    borderRadius: '12px',
    marginBottom: '16px',
  },
  statusTitle: {
    margin: 0,
    fontSize: '0.9rem',
    fontWeight: 600,
    color: '#f1f1f5',
    marginBottom: '8px',
  },
  statusText: {
    margin: 0,
    fontSize: '0.8rem',
    color: '#9a9aa3',
    lineHeight: 1.4,
  },
  statusIndicator: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '0.8rem',
    fontWeight: 600,
    marginTop: '8px',
  },
  builtInIndicator: {
    color: '#22c55e',
  },
  customIndicator: {
    color: '#3b82f6',
  },
  servicesList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
    marginBottom: '16px',
  },
  serviceOption: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    background: '#17171b',
    border: '1px solid #2b2b31',
    borderRadius: '10px',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  serviceOptionActive: {
    background: 'rgba(250, 204, 21, 0.15)',
    border: '1px solid #facc15',
  },
  serviceOptionDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  serviceInfo: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  serviceName: {
    fontSize: '0.9rem',
    fontWeight: 600,
    color: '#f1f1f5',
    margin: 0,
  },
  serviceDescription: {
    fontSize: '0.75rem',
    color: '#9a9aa3',
    margin: 0,
  },
  switchButton: {
    padding: '6px 12px',
    borderRadius: '6px',
    border: 'none',
    fontSize: '0.75rem',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    minWidth: '60px',
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
  errorMessage: {
    padding: '12px',
    background: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    borderRadius: '8px',
    color: '#ef4444',
    fontSize: '0.8rem',
    marginTop: '12px',
  },
  successMessage: {
    padding: '12px',
    background: 'rgba(34, 197, 94, 0.1)',
    border: '1px solid rgba(34, 197, 94, 0.3)',
    borderRadius: '8px',
    color: '#22c55e',
    fontSize: '0.8rem',
    marginTop: '12px',
  },
  unauthorizedMessage: {
    padding: '16px',
    background: 'rgba(59, 130, 246, 0.1)',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    borderRadius: '12px',
    color: '#3b82f6',
    fontSize: '0.85rem',
    lineHeight: 1.5,
    textAlign: 'center' as const,
  },
};

// Add CSS animation for loading spinner
const spinKeyframes = `
@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
`;

export const BuiltInServiceSwitcher: React.FC<BuiltInServiceSwitcherProps> = ({
  onServiceChange,
  className,
  style,
}) => {
  const { isSignedIn, user } = useUser();
  
  // State
  const [isAuthorized, setIsAuthorized] = useState<boolean>(false);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [currentStatus, setCurrentStatus] = useState<ServiceStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');

  // Check authorization and load initial data
  useEffect(() => {
    if (isSignedIn && user?.primaryEmailAddress?.emailAddress) {
      loadServiceData();
    } else {
      setLoading(false);
    }
  }, [isSignedIn, user]);

  const loadServiceData = async () => {
    const userEmail = user?.primaryEmailAddress?.emailAddress;
    if (!userEmail) return;

    try {
      setLoading(true);
      setError('');

      // Check authorization
      const authResponse = await fetch(`/api/ai/built-in-service?action=authorization&userId=${encodeURIComponent(userEmail)}`);
      if (authResponse.ok) {
        const authData = await authResponse.json();
        setIsAuthorized(authData.isAuthorized);
      }

      // Get available services
      const servicesResponse = await fetch(`/api/ai/built-in-service?action=services&userId=${encodeURIComponent(userEmail)}`);
      if (servicesResponse.ok) {
        const servicesData = await servicesResponse.json();
        setServices(servicesData.services || []);
      }

      // Get current status
      const statusResponse = await fetch(`/api/ai/built-in-service?action=status&userId=${encodeURIComponent(userEmail)}`);
      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        setCurrentStatus(statusData.status);
      }

    } catch (error) {
      console.error('Error loading service data:', error);
      setError('加载服务信息失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchService = async (serviceId: string, isBuiltIn: boolean) => {
    const userEmail = user?.primaryEmailAddress?.emailAddress;
    if (!userEmail || switching) return;

    try {
      setSwitching(serviceId);
      setError('');
      setSuccess('');

      let response: Response;
      
      if (isBuiltIn) {
        // Switch to built-in service
        response = await fetch('/api/ai/built-in-service', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: userEmail,
            action: 'switch-to-built-in',
            serviceId,
          }),
        });
      } else {
        // Switch to custom service (placeholder - would need custom config)
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
      }

      if (response.ok) {
        const result = await response.json();
        if (result.result?.success) {
          setSuccess(result.result.message);
          await loadServiceData(); // Reload to get updated status
          onServiceChange?.(isBuiltIn, serviceId);
        } else {
          setError(result.result?.message || '切换服务失败');
        }
      } else {
        setError('网络请求失败，请稍后重试');
      }

    } catch (error) {
      console.error('Error switching service:', error);
      setError('切换服务时发生错误');
    } finally {
      setSwitching(null);
    }
  };

  // Add CSS for animations
  useEffect(() => {
    const styleElement = document.createElement('style');
    styleElement.textContent = spinKeyframes;
    document.head.appendChild(styleElement);
    return () => {
      document.head.removeChild(styleElement);
    };
  }, []);

  if (!isSignedIn) {
    return (
      <div style={{ ...styles.container, ...style }} className={className}>
        <div style={styles.unauthorizedMessage}>
          请先登录以使用内置API服务功能
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ ...styles.container, ...style }} className={className}>
        <div style={styles.header}>
          <h3 style={styles.title}>内置API服务</h3>
          <span style={styles.badge}>PRO</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#9a9aa3' }}>
          <div style={styles.loadingSpinner}></div>
          <span>加载服务信息...</span>
        </div>
      </div>
    );
  }

  if (!isAuthorized) {
    return (
      <div style={{ ...styles.container, ...style }} className={className}>
        <div style={styles.header}>
          <h3 style={styles.title}>内置API服务</h3>
          <span style={styles.badge}>PRO</span>
        </div>
        <div style={styles.unauthorizedMessage}>
          <p style={{ margin: '0 0 8px 0', fontWeight: 600 }}>🔒 需要授权访问</p>
          <p style={{ margin: 0 }}>
            内置API服务仅对授权用户开放。如需使用此功能，请联系管理员或继续使用自定义API配置。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...styles.container, ...style }} className={className}>
      <div style={styles.header}>
        <h3 style={styles.title}>内置API服务</h3>
        <span style={styles.badge}>PRO</span>
      </div>
      
      <p style={styles.description}>
        一键切换到维护者提供的稳定API服务，无需配置密钥，开箱即用。
      </p>

      {/* Current Status */}
      {currentStatus && (
        <div style={styles.statusCard}>
          <h4 style={styles.statusTitle}>当前状态</h4>
          <p style={styles.statusText}>
            正在使用：{currentStatus.currentService.name}
          </p>
          <div style={{
            ...styles.statusIndicator,
            ...(currentStatus.isUsingBuiltIn ? styles.builtInIndicator : styles.customIndicator)
          }}>
            <span>{currentStatus.isUsingBuiltIn ? '🟢' : '🔵'}</span>
            <span>{currentStatus.isUsingBuiltIn ? '内置服务' : '自定义配置'}</span>
          </div>
        </div>
      )}

      {/* Services List */}
      <div style={styles.servicesList}>
        {services.map((service) => {
          const isActive = currentStatus?.currentService.id === service.id;
          const isSwitching = switching === service.id;
          const canSwitch = service.isAvailable && !isSwitching;

          return (
            <div
              key={service.id}
              style={{
                ...styles.serviceOption,
                ...(isActive ? styles.serviceOptionActive : {}),
                ...(!canSwitch ? styles.serviceOptionDisabled : {}),
              }}
              onClick={() => canSwitch && handleSwitchService(service.id, service.isBuiltIn)}
            >
              <div style={styles.serviceInfo}>
                <h5 style={styles.serviceName}>{service.name}</h5>
                <p style={styles.serviceDescription}>{service.description}</p>
              </div>
              
              <button
                style={{
                  ...styles.switchButton,
                  ...(isActive 
                    ? styles.switchButtonSecondary 
                    : canSwitch 
                      ? styles.switchButtonPrimary 
                      : styles.switchButtonDisabled
                  ),
                }}
                disabled={!canSwitch}
                onClick={(e) => {
                  e.stopPropagation();
                  if (canSwitch) handleSwitchService(service.id, service.isBuiltIn);
                }}
              >
                {isSwitching ? (
                  <div style={styles.loadingSpinner}></div>
                ) : isActive ? (
                  '使用中'
                ) : service.isAvailable ? (
                  '切换'
                ) : (
                  '不可用'
                )}
              </button>
            </div>
          );
        })}
      </div>

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
    </div>
  );
};

export default BuiltInServiceSwitcher;
