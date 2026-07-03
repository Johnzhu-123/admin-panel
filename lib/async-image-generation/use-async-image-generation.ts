/**
 * Custom Hook for Async Image Generation with Polling
 * 
 * This hook manages the async image generation workflow:
 * 1. Submit image generation request
 * 2. Poll for task status every 2 seconds
 * 3. Stop polling when completed, failed, or max attempts reached
 * 4. Return result image or error message
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Task status from API
 */
type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Hook state
 */
interface AsyncImageState {
  isLoading: boolean;
  isPolling: boolean;
  taskId: string | null;
  status: TaskStatus | null;
  resultImage: string | null;
  errorMessage: string | null;
  pollCount: number;
}

/**
 * Hook return value
 */
interface UseAsyncImageGenerationReturn {
  // State
  isLoading: boolean;
  isPolling: boolean;
  taskId: string | null;
  status: TaskStatus | null;
  resultImage: string | null;
  errorMessage: string | null;
  pollCount: number;
  
  // Actions
  generateImage: (params: any) => Promise<void>;
  reset: () => void;
}

/**
 * Configuration
 */
const POLL_INTERVAL_MS = 2000; // 2 seconds
const MAX_POLL_ATTEMPTS = 300; // 300 attempts = 600 seconds max

/**
 * Custom hook for async image generation
 */
export function useAsyncImageGeneration(): UseAsyncImageGenerationReturn {
  const [state, setState] = useState<AsyncImageState>({
    isLoading: false,
    isPolling: false,
    taskId: null,
    status: null,
    resultImage: null,
    errorMessage: null,
    pollCount: 0,
  });

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  /**
   * Poll task status
   */
  const pollTaskStatus = useCallback(async (taskId: string) => {
    try {
      console.log('[AsyncImageHook] Polling task status:', taskId);
      
      const response = await fetch(`/api/ai/image/status?taskId=${taskId}`);
      
      if (!response.ok) {
        throw new Error(`Status query failed: ${response.status}`);
      }

      const data = await response.json();
      
      if (!isMountedRef.current) return;

      console.log('[AsyncImageHook] Poll result:', {
        status: data.status,
        hasImage: !!data.resultImage,
        hasError: !!data.errorMessage,
      });

      // Update state with poll result
      setState(prev => ({
        ...prev,
        status: data.status,
        resultImage: data.resultImage || prev.resultImage,
        errorMessage: data.errorMessage || prev.errorMessage,
        pollCount: prev.pollCount + 1,
      }));

      // Check if polling should stop
      const shouldStopPolling = 
        data.status === 'completed' || 
        data.status === 'failed' ||
        state.pollCount >= MAX_POLL_ATTEMPTS;

      if (shouldStopPolling) {
        console.log('[AsyncImageHook] Stopping poll:', {
          status: data.status,
          pollCount: state.pollCount,
          reason: data.status === 'completed' ? 'completed' :
                  data.status === 'failed' ? 'failed' :
                  'max attempts reached',
        });

        // Stop polling
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }

        setState(prev => ({
          ...prev,
          isPolling: false,
          isLoading: false,
        }));

        // If max attempts reached without completion, set error
        if (state.pollCount >= MAX_POLL_ATTEMPTS && data.status !== 'completed') {
          setState(prev => ({
            ...prev,
            errorMessage: '图片生成超时，请稍后重试',
          }));
        }
      }

    } catch (error) {
      console.error('[AsyncImageHook] Poll error:', error);
      
      if (!isMountedRef.current) return;

      // Stop polling on error
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }

      setState(prev => ({
        ...prev,
        isPolling: false,
        isLoading: false,
        errorMessage: error instanceof Error ? error.message : '查询状态失败',
      }));
    }
  }, [state.pollCount]);

  /**
   * Start polling
   */
  const startPolling = useCallback((taskId: string) => {
    console.log('[AsyncImageHook] Starting poll for task:', taskId);

    // Clear any existing interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    // Reset poll count
    setState(prev => ({
      ...prev,
      isPolling: true,
      pollCount: 0,
    }));

    // Start polling immediately
    pollTaskStatus(taskId);

    // Then poll every POLL_INTERVAL_MS
    pollIntervalRef.current = setInterval(() => {
      pollTaskStatus(taskId);
    }, POLL_INTERVAL_MS);

  }, [pollTaskStatus]);

  /**
   * Generate image (submit request and start polling)
   */
  const generateImage = useCallback(async (params: any) => {
    try {
      console.log('[AsyncImageHook] Submitting image generation request');

      setState({
        isLoading: true,
        isPolling: false,
        taskId: null,
        status: null,
        resultImage: null,
        errorMessage: null,
        pollCount: 0,
      });

      // Submit image generation request
      const response = await fetch('/api/ai/image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      const data = await response.json();

      if (!isMountedRef.current) return;

      // Check if response contains taskId (async mode)
      if (data.taskId) {
        console.log('[AsyncImageHook] Task created:', data.taskId);

        setState(prev => ({
          ...prev,
          taskId: data.taskId,
          status: data.status || 'pending',
        }));

        // Start polling
        startPolling(data.taskId);

      } else if (data.image || data.imageBase64 || data.resultImage) {
        // Sync mode - image returned immediately
        console.log('[AsyncImageHook] Image returned immediately (sync mode)');
        const syncImage = data.imageBase64 || data.image || data.resultImage;

        setState({
          isLoading: false,
          isPolling: false,
          taskId: null,
          status: 'completed',
          resultImage: syncImage,
          errorMessage: null,
          pollCount: 0,
        });

      } else {
        throw new Error('Invalid response format');
      }

    } catch (error) {
      console.error('[AsyncImageHook] Generation error:', error);

      if (!isMountedRef.current) return;

      setState({
        isLoading: false,
        isPolling: false,
        taskId: null,
        status: 'failed',
        resultImage: null,
        errorMessage: error instanceof Error ? error.message : '图片生成失败',
        pollCount: 0,
      });
    }
  }, [startPolling]);

  /**
   * Reset state
   */
  const reset = useCallback(() => {
    console.log('[AsyncImageHook] Resetting state');

    // Clear polling interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    setState({
      isLoading: false,
      isPolling: false,
      taskId: null,
      status: null,
      resultImage: null,
      errorMessage: null,
      pollCount: 0,
    });
  }, []);

  return {
    // State
    isLoading: state.isLoading,
    isPolling: state.isPolling,
    taskId: state.taskId,
    status: state.status,
    resultImage: state.resultImage,
    errorMessage: state.errorMessage,
    pollCount: state.pollCount,
    
    // Actions
    generateImage,
    reset,
  };
}
