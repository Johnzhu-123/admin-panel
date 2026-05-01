/**
 * Gemini Business2API 兼容性配置
 * 专门处理 https://github.com/Johnzhu-123/gemini-business2api 项目的 API 兼容性
 */

import { ProviderConfig, ImageGenerationRequest, ImageGenerationResponse } from '../types';

export const geminiBusiness2ApiConfig: ProviderConfig = {
  id: 'gemini-business2api',
  name: 'Gemini Business2API',
  baseUrl: '', // Will be set dynamically
  authType: 'bearer',
  supportedFormats: ['b64_json', 'base64', 'url'],
  pathMappings: {
    chat: '/chat/completions',
    images: '/images/generations',
    models: '/models'
  },
  customHeaders: {},
  retryConfig: {
    maxRetries: 2,
    backoffMs: 2000,
    retryableErrors: ['429', '500', '502', '503', '504']
  },
  timeoutMs: 300000, // 5分钟超时，因为 Gemini 生图较慢
  rateLimits: {
    requestsPerMinute: 10,
    requestsPerHour: 100,
    burstLimit: 3
  },
  
  // 响应格式适配
  responseAdapter: {
    // 从聊天响应中提取图片
    extractImageFromChat: (response: any): string => {
      console.log('Gemini Business2API response analysis:', {
        hasChoices: !!response.choices,
        choicesLength: response.choices?.length || 0,
        firstChoiceContent: response.choices?.[0]?.message?.content?.substring(0, 200)
      });
      
      // 检查聊天响应中的图片
      if (response.choices && response.choices.length > 0) {
        const content = response.choices[0].message?.content || '';
        
        // 方法1: 查找 HTTP/HTTPS 图片 URL（优先级最高）
        const httpUrlMatch = content.match(/(https?:\/\/[^\s)]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s)]*)?)/i);
        if (httpUrlMatch) {
          console.log('Found HTTP image URL in chat response');
          return httpUrlMatch[1]; // 返回完整 URL
        }
        
        // 方法2: 查找 Markdown 格式的 HTTP 图片
        const markdownHttpMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s)]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s)]*)?)\)/i);
        if (markdownHttpMatch) {
          console.log('Found Markdown HTTP image in chat response');
          return markdownHttpMatch[1];
        }
        
        // 方法3: 查找 data:image/ 格式的图片（可能被截断）
        const dataUrlMatch = content.match(/data:image\/[^,]+,([A-Za-z0-9+/=]+)/);
        if (dataUrlMatch) {
          const base64Data = dataUrlMatch[1];
          // 检查是否被截断（正常 base64 应该以 = 结尾或长度合理）
          const isLikelyTruncated = base64Data.length < 1000 || 
                                   (!base64Data.endsWith('=') && !base64Data.endsWith('==') && base64Data.length % 4 !== 0);
          
          if (isLikelyTruncated) {
            console.warn('Base64 data appears to be truncated, length:', base64Data.length);
            return ''; // 返回空，让系统尝试其他方法
          }
          
          console.log('Found complete data URL in chat response');
          return base64Data; // 返回 base64 部分
        }
        
        // 方法4: 查找 Markdown 图片格式（可能被截断）
        const markdownMatch = content.match(/!\[.*?\]\(data:image\/[^,]+,([A-Za-z0-9+/=]+)\)/);
        if (markdownMatch) {
          const base64Data = markdownMatch[1];
          const isLikelyTruncated = base64Data.length < 1000 || 
                                   (!base64Data.endsWith('=') && !base64Data.endsWith('==') && base64Data.length % 4 !== 0);
          
          if (isLikelyTruncated) {
            console.warn('Markdown base64 data appears to be truncated, length:', base64Data.length);
            return '';
          }
          
          console.log('Found complete Markdown image in chat response');
          return base64Data;
        }
        
        // 方法5: 查找纯 base64 数据（最后尝试）
        if (content.length > 1000 && /^[A-Za-z0-9+/=\s]+$/.test(content.trim())) {
          const cleanBase64 = content.replace(/\s/g, '');
          if (cleanBase64.length > 1000) {
            console.log('Found pure base64 content in chat response');
            return cleanBase64;
          }
        }
      }
      
      return '';
    },
    
    // 标准化响应格式
    normalizeResponse: (response: any): ImageGenerationResponse => {
      // 如果是标准的图片生成响应
      if (response.data && Array.isArray(response.data)) {
        return {
          images: response.data.map((item: any) => ({
            b64_json: item.b64_json || item.base64 || '',
            url: item.url || ''
          }))
        };
      }
      
      // 如果是聊天响应，尝试提取图片
      const imageData = geminiBusiness2ApiConfig.responseAdapter!.extractImageFromChat!(response);
      if (imageData) {
        // 判断是 URL 还是 base64
        if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
          return {
            images: [{
              b64_json: '',
              url: imageData
            }]
          };
        } else {
          return {
            images: [{
              b64_json: imageData,
              url: ''
            }]
          };
        }
      }
      
      // 无法提取图片
      return { images: [] };
    }
  },
  
  // 请求参数映射
  parameterMapping: {
    // 图片生成参数映射
    mapImageRequest: (request: ImageGenerationRequest) => {
      // 对于 Gemini Business2API，建议使用聊天接口生成图片
      return {
        model: request.model || 'gemini-3-pro-preview',
        messages: [
          {
            role: 'system',
            content: 'You are an image generator. Generate the requested image and return it as a data URL (data:image/png;base64,<base64_data>) or embed it in markdown format.'
          },
          {
            role: 'user',
            content: request.prompt
          }
        ],
        stream: false,
        max_tokens: 4000
      };
    }
  },
  
  // 错误处理
  errorHandling: {
    // 处理常见错误
    handleError: (error: any, response?: any) => {
      const status = response?.status || error.status || 500;
      const message = error.message || response?.statusText || 'Unknown error';
      
      // 超时错误
      if (message.includes('timeout') || message.includes('aborted') || status === 408) {
        return {
          canRetry: true,
          userMessage: 'Gemini 图片生成超时，这是正常现象。请稍等片刻再试。',
          technicalDetails: `Request timeout after ${geminiBusiness2ApiConfig.timeoutMs}ms`,
          suggestions: [
            '增加超时时间设置',
            '使用更快的模型（如 gemini-2.5-pro）',
            '简化图片描述以加快生成速度'
          ]
        };
      }
      
      // 429 错误（速率限制）
      if (status === 429) {
        return {
          canRetry: true,
          userMessage: 'API 调用频率过高，请稍后再试',
          technicalDetails: 'Rate limit exceeded',
          suggestions: [
            '等待 1-2 分钟后重试',
            '检查 API 配额使用情况',
            '考虑升级 API 套餐'
          ]
        };
      }
      
      // 504 错误（网关超时）
      if (status === 504) {
        return {
          canRetry: true,
          userMessage: '服务器处理超时，但图片可能已在后台生成',
          technicalDetails: 'Gateway timeout',
          suggestions: [
            '检查后台日志确认是否生成成功',
            '稍后重试请求',
            '联系 API 提供商确认服务状态'
          ]
        };
      }
      
      return {
        canRetry: false,
        userMessage: `API 请求失败: ${message}`,
        technicalDetails: message,
        suggestions: ['检查 API 配置', '验证网络连接', '查看详细错误日志']
      };
    }
  }
};

// 检测是否为 Gemini Business2API
export const isGeminiBusiness2Api = (baseUrl: string): boolean => {
  // 根据你的项目特征进行检测
  const indicators = [
    'gemini-business2api',
    'business2api',
    // 可以根据你的域名或特殊路径添加更多标识
  ];
  
  return indicators.some(indicator => 
    baseUrl.toLowerCase().includes(indicator)
  );
};

// 应用配置
export const applyGeminiBusiness2ApiConfig = (baseUrl: string) => {
  if (isGeminiBusiness2Api(baseUrl)) {
    console.log('Detected Gemini Business2API, applying specialized configuration');
    return geminiBusiness2ApiConfig;
  }
  return null;
};
