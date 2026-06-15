// scripts/sync.js
import fetch from 'node-fetch';
import { createRequire } from 'module';

// 加载 dotenv（仅用于本地开发）
const require = createRequire(import.meta.url);
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// 配置
const {
  FS_APP_ID,
  FS_APP_SECRET,
  BITABLE_APP_TOKEN,
  PROJECT_TABLE_ID,
  CAPACITY_TABLE_ID
} = process.env;

if (!FS_APP_ID || !FS_APP_SECRET || !BITABLE_APP_TOKEN || !PROJECT_TABLE_ID || !CAPACITY_TABLE_ID) {
  console.error('❌ 缺少环境变量，请检查 .env 或 GitHub Secrets');
  process.exit(1);
}

const TENANT_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/';

async function getTenantAccessToken() {
  const res = await fetch(TENANT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: FS_APP_ID, app_secret: FS_APP_SECRET })
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 token 失败: ${data.msg}`);
  }
  return data.tenant_access_token;
}



// 主流程
(async () => {
  try {
    console.log('🚀 开始同步到飞书 Bitable...');
    const token = await getTenantAccessToken();
    // await writeToBitable(token);
    console.log('🎉 同步完成！');
  } catch (err) {
    console.error('💥 错误:', err.message);
    process.exit(1);
  }
})();