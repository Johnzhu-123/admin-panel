# 部署清单 - 异步图片生成功能

本文档提供异步图片生成功能的完整部署清单。

## 开发环境验证 ✓

### 1. 代码完成度

- [x] **任务管理器** (`lib/async-image-generation/task-manager.ts`)
  - createTask() 函数
  - updateTaskStatus() 函数
  - getTaskStatus() 函数
  - 错误处理和日志记录

- [x] **图片生成器** (`lib/async-image-generation/image-generator.ts`)
  - generateAsync() 函数
  - 60 秒超时控制
  - 集成现有图片生成逻辑
  - 状态更新和结果存储

- [x] **错误处理** (`lib/async-image-generation/error-handler.ts`)
  - handleError() 函数
  - 7 种错误分类
  - 用户友好错误消息映射

- [x] **清理功能** (`lib/async-image-generation/cleanup.ts`)
  - cleanupExpiredTasks() 函数
  - 24 小时过期任务清理

- [x] **API 端点**
  - POST /api/ai/image (异步模式支持)
  - GET /api/ai/image/status (状态查询)

- [x] **前端 Hook** (`lib/async-image-generation/use-async-image-generation.ts`)
  - useAsyncImageGeneration Hook
  - 轮询逻辑（2 秒间隔，最多 30 次）
  - 状态管理和错误处理

- [x] **示例组件** (`components/async-image-generation-example.tsx`)
  - 完整的使用示例
  - UI 组件和交互逻辑

### 2. 测试覆盖

- [x] **单元测试** (66 个测试全部通过)
  - task-manager.test.ts (21 tests)
  - image-generator.test.ts (13 tests)
  - error-handler.test.ts (32 tests)

- [x] **集成测试** (11 个测试全部通过)
  - integration.test.ts (11 tests)
  - 完整工作流测试
  - 并发任务测试
  - 错误处理测试

- [x] **测试覆盖率**
  - 所有核心功能已测试
  - 错误路径已覆盖
  - 边界条件已验证

### 3. 文档完整性

- [x] **使用文档**
  - docs/async-image-generation-guide.md
  - 完整的功能说明和使用指南

- [x] **API 文档**
  - app/api/ai/image/status/README.md
  - 端点说明和示例

- [x] **测试文档**
  - app/api/ai/image/status/TESTING.md
  - 测试指南和示例

- [x] **前端集成文档**
  - lib/async-image-generation/FRONTEND_INTEGRATION.md
  - Hook 使用指南和最佳实践

- [x] **手动测试指南**
  - lib/async-image-generation/MANUAL_TESTING_GUIDE.md
  - 完整的测试场景和验证步骤

## 数据库准备 ⚠️

### 1. 数据库表

- [x] **表结构定义**
  - `image_generation_tasks` 表已定义
  - 所有必需字段已包含

- [ ] **表已创建** (需要在部署环境执行)
  ```sql
  -- 在 Vercel Dashboard 或使用脚本执行
  -- 参考: lib/built-in-api-service/db.ts
  ```

- [x] **索引已定义**
  - idx_image_tasks_user_id
  - idx_image_tasks_status
  - idx_image_tasks_created_at

- [ ] **索引已创建** (需要在部署环境执行)

### 2. 数据库迁移

- [x] **迁移脚本**
  - scripts/init-database.mjs 已更新
  - 包含表创建和索引创建

- [ ] **迁移已执行** (需要在部署环境执行)
  ```bash
  # 本地测试
  npm run init-db
  
  # 或访问
  http://localhost:3000/api/admin/init-database
  ```

## 环境配置 ⚠️

### 1. 环境变量

- [ ] **本地环境** (.env.local)
  ```bash
  # 启用异步图片生成
  ENABLE_ASYNC_IMAGE_GENERATION=true
  
  # 数据库连接（已有）
  POSTGRES_URL=...
  POSTGRES_PRISMA_URL=...
  POSTGRES_URL_NON_POOLING=...
  ```

- [ ] **Vercel 环境变量**
  - 在 Vercel Dashboard 中添加
  - 项目设置 → Environment Variables
  - 添加: `ENABLE_ASYNC_IMAGE_GENERATION=true`

### 2. 功能开关

- [x] **默认行为**: 同步模式（向后兼容）
- [x] **异步模式**: 通过环境变量启用
- [x] **降级策略**: 环境变量未设置时使用同步模式

## 本地测试 ⚠️

### 1. 自动化测试

- [x] **运行所有测试**
  ```bash
  npm test -- lib/async-image-generation/__tests__/
  ```
  结果: ✓ 66 tests passed

- [x] **集成测试**
  ```bash
  npm test -- lib/async-image-generation/__tests__/integration.test.ts
  ```
  结果: ✓ 11 tests passed

### 2. 手动测试

- [ ] **场景 1**: 创建异步任务
  - 发送 POST 请求
  - 验证立即返回 taskId
  - 响应时间 < 1 秒

- [ ] **场景 2**: 查询任务状态
  - 使用 taskId 查询
  - 验证状态变化: pending → processing → completed

- [ ] **场景 3**: 获取生成结果
  - 任务完成后查询
  - 验证返回 base64 图片数据
  - 验证图片可以正常显示

- [ ] **场景 4**: 错误处理
  - 测试无效参数
  - 测试任务不存在
  - 验证错误消息友好

- [ ] **场景 5**: 向后兼容性
  - 禁用异步模式
  - 验证同步模式正常工作

参考: `lib/async-image-generation/MANUAL_TESTING_GUIDE.md`

### 3. 性能测试

- [ ] **响应时间**
  - 任务创建 < 1 秒
  - 状态查询 < 500ms

- [ ] **并发测试**
  - 同时创建 5-10 个任务
  - 验证所有任务正常处理

- [ ] **超时测试**
  - 验证 60 秒超时机制
  - 验证超时后任务标记为 failed

## Vercel 部署准备 ⚠️

### 1. 部署配置

- [x] **Next.js 配置**
  - maxDuration: 60 (已设置)
  - runtime: nodejs (已设置)

- [x] **API 路由配置**
  - POST /api/ai/image 支持异步模式
  - GET /api/ai/image/status 已实现

### 2. 数据库配置

- [ ] **Neon 数据库**
  - 确认连接正常
  - 确认有足够的连接池

- [ ] **数据库初始化**
  - 在 Vercel 环境执行迁移
  - 验证表和索引已创建

### 3. 环境变量

- [ ] **Vercel Dashboard 配置**
  - 添加 `ENABLE_ASYNC_IMAGE_GENERATION=true`
  - 验证其他环境变量正确

### 4. 部署验证

- [ ] **部署到 Preview 环境**
  - 创建 PR 触发 Preview 部署
  - 在 Preview 环境测试功能

- [ ] **Preview 环境测试**
  - 运行手动测试场景
  - 验证数据库连接
  - 验证异步任务创建和查询

- [ ] **部署到 Production**
  - 合并 PR 触发 Production 部署
  - 监控部署日志

## 生产环境验证 ⚠️

### 1. 功能验证

- [ ] **基本功能**
  - 创建异步任务
  - 查询任务状态
  - 获取生成结果

- [ ] **错误处理**
  - 无效参数处理
  - 任务不存在处理
  - API 错误处理

- [ ] **性能验证**
  - 响应时间符合预期
  - 并发处理正常

### 2. 监控设置

- [ ] **日志监控**
  - 在 Vercel Dashboard 查看日志
  - 监控错误和警告

- [ ] **性能监控**
  - 监控 API 响应时间
  - 监控数据库查询性能

- [ ] **错误追踪**
  - 设置错误告警
  - 监控失败率

### 3. 数据库监控

- [ ] **任务统计**
  ```sql
  -- 查看任务状态分布
  SELECT status, COUNT(*) 
  FROM image_generation_tasks 
  GROUP BY status;
  ```

- [ ] **性能监控**
  - 查询响应时间
  - 索引使用情况

- [ ] **清理任务**
  - 定期清理过期任务
  - 监控数据库大小

## 回滚计划 ⚠️

### 1. 快速回滚

如果发现严重问题，可以快速禁用异步模式：

```bash
# 在 Vercel Dashboard 中
# 删除或设置为 false
ENABLE_ASYNC_IMAGE_GENERATION=false
```

这将立即切换回同步模式，不影响现有功能。

### 2. 数据清理

如果需要清理测试数据：

```sql
-- 删除所有异步任务记录
DELETE FROM image_generation_tasks;

-- 或删除特定用户的任务
DELETE FROM image_generation_tasks 
WHERE user_id = 'test-user';
```

### 3. 完全回滚

如果需要完全回滚代码：

```bash
# 回滚到上一个版本
git revert <commit-hash>
git push origin main
```

## 后续优化 📋

### 短期优化 (1-2 周)

- [ ] **前端集成**
  - 在主应用中集成 useAsyncImageGeneration Hook
  - 添加轮询进度显示
  - 优化用户体验

- [ ] **监控和告警**
  - 设置任务失败率告警
  - 设置响应时间告警
  - 添加性能仪表板

- [ ] **清理任务自动化**
  - 设置定时任务清理过期记录
  - 优化数据库存储

### 中期优化 (1-2 月)

- [ ] **性能优化**
  - 优化数据库查询
  - 添加缓存层
  - 优化轮询策略

- [ ] **功能增强**
  - 支持任务取消
  - 支持任务优先级
  - 支持批量任务

- [ ] **用户体验**
  - 添加 WebSocket 实时通知
  - 优化错误提示
  - 添加任务历史记录

### 长期优化 (3-6 月)

- [ ] **架构优化**
  - 考虑使用消息队列
  - 考虑使用专门的任务调度系统
  - 考虑使用 CDN 缓存结果

- [ ] **扩展性**
  - 支持更多图片生成提供商
  - 支持更多图片格式
  - 支持图片编辑功能

## 检查清单总结

### 必须完成（部署前）

- [x] 代码开发完成
- [x] 单元测试通过
- [x] 集成测试通过
- [x] 文档完整
- [ ] 数据库表已创建
- [ ] 环境变量已配置
- [ ] 本地手动测试通过
- [ ] Preview 环境测试通过

### 建议完成（部署后）

- [ ] 生产环境验证
- [ ] 监控设置完成
- [ ] 性能基准测试
- [ ] 用户反馈收集

### 可选完成（后续优化）

- [ ] 前端完整集成
- [ ] WebSocket 实时通知
- [ ] 高级功能（取消、优先级等）
- [ ] 性能优化

## 联系和支持

如有问题，请参考：
- [使用文档](../../docs/async-image-generation-guide.md)
- [手动测试指南](./MANUAL_TESTING_GUIDE.md)
- [前端集成指南](./FRONTEND_INTEGRATION.md)
- [API 文档](../../app/api/ai/image/status/README.md)

---

**最后更新**: 2026-01-26
**版本**: 1.0.0
**状态**: 准备部署
