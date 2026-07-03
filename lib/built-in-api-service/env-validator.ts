/**
 * Environment Variables Validator
 * Validates required and optional environment variables
 */

export interface EnvValidationResult {
  isValid: boolean;
  missingRequired: string[];
  missingOptional: string[];
  warnings: string[];
  info: string[];
}

/**
 * Validate all environment variables
 */
export function validateEnvironmentVariables(): EnvValidationResult {
  const result: EnvValidationResult = {
    isValid: true,
    missingRequired: [],
    missingOptional: [],
    warnings: [],
    info: []
  };

  // 必需的环境变量（只有4个！）
  const required: Record<string, string> = {
    'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY': 'Clerk公钥（用于用户认证）',
    'CLERK_SECRET_KEY': 'Clerk密钥（用于服务端认证）',
    'GEMINI_BUILT_IN_API_KEY': 'Gemini API密钥（用于内置服务）',
    'ADMIN_PASSWORD': '管理员密码（用于访问管理面板）'
  };

  for (const [key, description] of Object.entries(required)) {
    if (!process.env[key]) {
      result.missingRequired.push(`${key} - ${description}`);
      result.isValid = false;
    }
  }

  // 可选的环境变量（使用默认值）
  const optional: Record<string, { description: string; defaultValue: string }> = {
    'GEMINI_BUILT_IN_BASE_URL': {
      description: 'API基础URL',
      // 🔧 FIX (2026-05 #19): seeyjys.zeabur.app 是已下线的旧网关。当前生产
      //   网关是 api.seeyjys.eu.org（部署在 Render）。本文件目前没有 import
      //   方调用（dead code），但默认值仍要修对避免误导。
      defaultValue: 'https://api.seeyjys.eu.org/v1'
    },
    'BUILT_IN_SERVICE_NAME': {
      description: '服务名称',
      defaultValue: '行云API'
    },
    'BUILT_IN_SERVICE_MODEL': {
      description: '模型名称',
      defaultValue: 'gemini-2.5-pro'
    },
    'BUILT_IN_SERVICE_ENABLED': {
      description: '启用内置服务',
      defaultValue: 'true'
    },
    'AUTHORIZED_USERS': {
      description: '初始授权用户',
      defaultValue: '通过管理员面板添加'
    }
  };

  for (const [key, config] of Object.entries(optional)) {
    if (!process.env[key]) {
      result.missingOptional.push(key);
      result.info.push(`${key}: 使用默认值 "${config.defaultValue}"`);
    }
  }

  // 检查数据库配置
  if (!process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    result.warnings.push(
      '未检测到数据库配置。请在Vercel中创建Postgres数据库并连接到项目。'
    );
  }

  return result;
}

/**
 * 在应用启动时验证环境变量并输出日志
 */
export function validateOnStartup(): void {
  console.log('\n🔍 验证环境变量配置...\n');
  
  const result = validateEnvironmentVariables();

  if (!result.isValid) {
    console.error('❌ 缺少必需的环境变量：\n');
    result.missingRequired.forEach(item => {
      console.error(`   ✗ ${item}`);
    });
    console.error('\n请在Vercel项目设置中配置这些环境变量。');
    console.error('详见文档：环境变量精简方案.md\n');
  } else {
    console.log('✅ 所有必需的环境变量已配置\n');
  }

  if (result.info.length > 0) {
    console.log('ℹ️  使用默认配置：\n');
    result.info.forEach(info => {
      console.log(`   • ${info}`);
    });
    console.log('');
  }

  if (result.warnings.length > 0) {
    console.log('⚠️  警告：\n');
    result.warnings.forEach(warning => {
      console.log(`   ! ${warning}`);
    });
    console.log('');
  }

  // 输出配置摘要
  console.log('📊 配置摘要：');
  console.log(`   必需变量：${4 - result.missingRequired.length}/4 已配置`);
  console.log(`   可选变量：${5 - result.missingOptional.length}/5 已配置`);
  console.log(`   使用默认值：${result.missingOptional.length} 项\n`);
}

/**
 * 获取配置摘要（用于管理面板显示）
 */
export function getConfigurationSummary(): {
  requiredConfigured: number;
  requiredTotal: number;
  optionalConfigured: number;
  optionalTotal: number;
  usingDefaults: string[];
  isFullyConfigured: boolean;
} {
  const result = validateEnvironmentVariables();
  
  return {
    requiredConfigured: 4 - result.missingRequired.length,
    requiredTotal: 4,
    optionalConfigured: 5 - result.missingOptional.length,
    optionalTotal: 5,
    usingDefaults: result.missingOptional,
    isFullyConfigured: result.isValid
  };
}
