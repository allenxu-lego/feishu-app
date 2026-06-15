# Feishu Bitable Sync & Knowledge Graph Generator

从飞书 Bitable 获取项目和能力数据，构建关系网络，并生成交互式知识图谱 HTML 文件。

## 环境变量

在项目根目录创建 `.env` 文件（本地开发），或配置 GitHub Secrets（CI/CD）：

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `FS_APP_ID` | 飞书应用 ID | `cli_xxxxxxxx` |
| `FS_APP_SECRET` | 飞书应用密钥 | `xxxxxxxxxxxx` |
| `BITABLE_APP_TOKEN` | Bitable 应用 Token | `OHROwXnaXisvoUkHr4TcPO1Mnoc` |
| `PROJECT_TABLE_ID` | 项目表 Table ID | `tblsA6yttRFfFaoT` |
| `CAPACITY_TABLE_ID` | 能力表 Table ID | `tblIkoU8YInDjpLt` |

## 使用方法

```bash
# 安装依赖
npm install

# 本地运行（需要 .env 文件）
npm run sync
```

## 输出

运行后将在 `docs/dynamic/` 目录下生成 `project-capability-graph.html` 文件，用浏览器打开即可查看交互式知识图谱。

## 工作流程

1. 通过飞书 API 获取 Tenant Access Token
2. 从 Bitable 获取 Projects 和 Capabilities 数据
3. 构建关系：Project↔Capability、Project↔Domain、Capability↔Domain、Capability↔Digital Owner
4. 生成知识图谱配置 JSON
5. 生成自包含的交互式 HTML（基于 D3.js 力导向图）
6. 保存到 `docs/dynamic/project-capability-graph.html`
