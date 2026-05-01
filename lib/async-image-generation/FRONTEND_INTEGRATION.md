# 前端集成指南 - 异步图片生成

本文档说明如何在前端组件中集成异步图片生成功能。

## 概述

异步图片生成功能通过以下流程工作：

1. **提交请求** - 前端发送图片生成请求到 `/api/ai/image`
2. **获取任务 ID** - API 立即返回任务 ID（而不是等待图片生成完成）
3. **轮询状态** - 前端每 2 秒查询一次任务状态
4. **获取结果** - 当任务完成时，获取生成的图片或错误信息

## 使用自定义 Hook

### 1. 导入 Hook

```typescript
import { useAsyncImageGeneration } from '@/lib/async-image-generation/use-async-image-generation';
```

### 2. 在组件中使用

```typescript
function MyComponent() {
  const {
    // 状态
    isLoading,      // 是否正在加载（提交请求或轮询中）
    isPolling,      // 是否正在轮询
    taskId,         // 任务 ID
    status,         // 任务状态: 'pending' | 'processing' | 'completed' | 'failed'
    resultImage,    // 生成的图片（base64）
    errorMessage,   // 错误信息
    pollCount,      // 轮询次数
    
    // 操作
    generateImage,  // 提交图片生成请求
    reset,          // 重置状态
  } = useAsyncImageGeneration();

  // 提交请求
  const handleGenerate = async () => {
    await generateImage({
      prompt: 'A beautiful sunset',
      provider: 'openai',
      // ... 其他参数
    });
  };

  return (
    <div>
      {isLoading && <p>生成中... ({pollCount}/30)</p>}
      {resultImage && <img src={`data:image/png;base64,${resultImage}`} />}
      {errorMessage && <p>错误: {errorMessage}</p>}
    </div>
  );
}
```

## Hook 配置

### 轮询配置

- **轮询间隔**: 2 秒（`POLL_INTERVAL_MS = 2000`）
- **最大轮询次数**: 30 次（`MAX_POLL_ATTEMPTS = 30`）
- **最大等待时间**: 60 秒（30 次 × 2 秒）

### 停止条件

轮询会在以下情况下自动停止：

1. 任务状态变为 `completed`（成功）
2. 任务状态变为 `failed`（失败）
3. 达到最大轮询次数（30 次）

## 状态说明

### 任务状态

| 状态 | 说明 |
|------|------|
| `pending` | 任务已创建，等待处理 |
| `processing` | 任务正在处理中 |
| `completed` | 任务完成，图片已生成 |
| `failed` | 任务失败，查看 errorMessage |

### Hook 状态

| 字段 | 类型 | 说明 |
|------|------|------|
| `isLoading` | boolean | 是否正在加载（包括提交和轮询） |
| `isPolling` | boolean | 是否正在轮询状态 |
| `taskId` | string \| null | 任务 ID |
| `status` | TaskStatus \| null | 任务状态 |
| `resultImage` | string \| null | 生成的图片（base64） |
| `errorMessage` | string \| null | 错误信息 |
| `pollCount` | number | 当前轮询次数 |

## 完整示例

查看 `components/async-image-generation-example.tsx` 获取完整的示例组件。

## 向后兼容性

Hook 同时支持异步模式和同步模式：

- **异步模式**: API 返回 `{ taskId, status }` - Hook 自动开始轮询
- **同步模式**: API 返回 `{ image }` - Hook 直接显示结果

这确保了即使在异步功能未启用时，前端代码也能正常工作。

## 错误处理

Hook 会自动处理以下错误：

1. **网络错误** - 请求失败时显示错误信息
2. **超时错误** - 达到最大轮询次数时显示超时信息
3. **API 错误** - 任务失败时显示 API 返回的错误信息

## 最佳实践

### 1. 显示进度指示器

```typescript
{isPolling && (
  <div>
    <Spinner />
    <p>正在生成图片... ({pollCount}/30)</p>
    <p>预计还需 {(30 - pollCount) * 2} 秒</p>
  </div>
)}
```

### 2. 提供取消功能

```typescript
<button onClick={reset} disabled={!isLoading}>
  取消
</button>
```

### 3. 显示任务 ID

```typescript
{taskId && (
  <p>任务 ID: {taskId}</p>
)}
```

这样用户可以保存任务 ID，稍后查询结果。

### 4. 处理超时

```typescript
{pollCount >= 30 && status !== 'completed' && (
  <div>
    <p>生成时间较长，请稍后查询</p>
    <p>任务 ID: {taskId}</p>
  </div>
)}
```

## 集成到现有组件

如果你已经有图片生成组件，可以这样集成：

```typescript
// 原有的同步代码
const handleGenerate = async () => {
  const response = await fetch('/api/ai/image', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
  const data = await response.json();
  setImage(data.image);
};

// 改为使用 Hook
const { generateImage, resultImage } = useAsyncImageGeneration();

const handleGenerate = async () => {
  await generateImage({ prompt });
};

// 使用 resultImage 而不是 image
```

## 环境变量

确保设置以下环境变量以启用异步模式：

```bash
ENABLE_ASYNC_IMAGE_GENERATION=true
```

如果未设置，API 将使用同步模式（向后兼容）。

## 测试

### 手动测试

1. 启动开发服务器
2. 打开包含异步图片生成的页面
3. 提交图片生成请求
4. 观察轮询过程和结果显示

### 自动化测试

参考 `lib/async-image-generation/__tests__/` 目录中的测试文件。

## 故障排查

### 问题：轮询一直不停止

**原因**: 任务状态未正确更新

**解决方案**: 
1. 检查后端日志，确认任务状态是否正确更新
2. 检查数据库中的任务记录
3. 确认 `/api/ai/image/status` 端点返回正确的状态

### 问题：图片未显示

**原因**: base64 数据格式错误

**解决方案**:
1. 检查 `resultImage` 是否包含完整的 base64 数据
2. 确认图片 URL 格式: `data:image/png;base64,${resultImage}`
3. 检查浏览器控制台是否有图片加载错误

### 问题：轮询过快或过慢

**原因**: 轮询间隔配置不当

**解决方案**:
修改 `use-async-image-generation.ts` 中的配置：

```typescript
const POLL_INTERVAL_MS = 2000; // 调整这个值
const MAX_POLL_ATTEMPTS = 30;  // 调整这个值
```

## 性能优化

### 1. 避免重复轮询

Hook 会自动清理旧的轮询间隔，确保不会有多个轮询同时运行。

### 2. 组件卸载时清理

Hook 会在组件卸载时自动清理轮询间隔，避免内存泄漏。

### 3. 使用 useCallback

Hook 内部使用 `useCallback` 优化函数引用，避免不必要的重新渲染。

## 相关文档

- [异步图片生成使用指南](../../docs/async-image-generation-guide.md)
- [API 文档](../../app/api/ai/image/status/README.md)
- [测试指南](../../app/api/ai/image/status/TESTING.md)
