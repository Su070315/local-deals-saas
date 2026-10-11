# 子域名工作台部署

生产环境使用同一根域名下的明确子域名，不使用泛域名工作台，也不根据 `Host` 头授予任何权限。JWT 角色、租户和门店校验始终由 API 执行；子域名只用于浏览器存储隔离、入口隔离和运营职责划分。

| 子域名 | 工作台构建角色 | 使用者 | API 路径 |
| --- | --- | --- | --- |
| `platform.<根域名>` | `PLATFORM_ADMIN` | 平台管理员与合规人员 | 同源 `/api` 反向代理 |
| `agency.<根域名>` | `AGENCY_ADMIN` | 代理运营人员 | 同源 `/api` 反向代理 |
| `merchant.<根域名>` | `MERCHANT_ADMIN` | 商家管理员 | 同源 `/api` 反向代理 |
| `verify.<根域名>` | `STORE_STAFF`，仅在浏览器核销后台启用 | 门店核销员 | 同源 `/api` 反向代理 |
| `api.<根域名>` | 不部署运营前端 | 微信小程序与受控服务调用 | 仅 HTTPS API |

顾客端和核销助手小程序必须使用已备案、已在微信后台登记的 `api.<根域名>` HTTPS 合法请求域名；不得把本机地址、运营工作台域名或不受控测试域名带入发布版本。

体验版和正式版通过微信扩展配置提供 API 地址：

```json
{ "apiBase": "https://api.example.com/api/v1" }
```

两个小程序只在开发工具的 `develop` 环境允许默认本机 API。体验版或正式版没有该配置、不是 HTTPS、或路径不是精确 `/api` 时会停止网络调用并显示配置错误。

## 构建与入口

每个工作台用相同源码、不同构建参数生成独立静态包。登录页会校验 API 返回的角色，不匹配时撤销刚建立的会话，不写入该子域名的浏览器存储。

```powershell
docker build -f apps/admin/Dockerfile --build-arg VITE_WORKSPACE_ROLE=PLATFORM_ADMIN -t deals-platform .
docker build -f apps/admin/Dockerfile --build-arg VITE_WORKSPACE_ROLE=AGENCY_ADMIN -t deals-agency .
docker build -f apps/admin/Dockerfile --build-arg VITE_WORKSPACE_ROLE=MERCHANT_ADMIN -t deals-merchant .
```

每个静态包根目录包含不含密钥的 `workspace-manifest.json`，例如：

```json
{ "workspaceRole": "MERCHANT_ADMIN", "apiPath": "/api/v1/", "releaseId": "release-example" }
```

部署探针必须从每个精确子域名读取该文件并比对角色和本次发布的 `releaseId`，不得根据镜像名称、容器名或 `Host` 头推断。该文件由构建输出生成且沿用工作台的 `no-store` 缓存策略。执行 `npm run release:verify` 会构建四个角色包并校验各自清单、入口服务、同源 API 代理和安全头配置。

`assets/` 中的带 hash 文件可使用长期 immutable 缓存，但生产发布不能以新容器文件系统直接覆盖旧资源。应将每个 `RELEASE_ID` 的资源先发布到版本化静态存储或可保留历史版本的 CDN 源站，保留上一版本至少覆盖运营会话时长和灰度窗口，再切换不缓存的 `index.html`。工作台已在旧 chunk 无法加载时提示安全刷新，不会自动重试写操作；资源保留仍是避免用户中断的第一道保护。

## 本地四端验收

`docker compose up --build` 会同时启动四个固定角色的工作台。现代浏览器会把 `*.localhost` 解析为本机；若本机 DNS 策略不支持该保留域名，可在 hosts 文件将四个名称映射到 `127.0.0.1`，但不要改为同一个工作台地址。

| 本地入口 | 固定角色 | 演示账号 |
| --- | --- | --- |
| `http://platform.localhost:5173` | `PLATFORM_ADMIN` | `platform@demo.local` |
| `http://agency.localhost:5174` | `AGENCY_ADMIN` | `agency@demo.local` |
| `http://merchant.localhost:5175` | `MERCHANT_ADMIN` | `merchant@demo.local` |
| `http://verify.localhost:5176` | `STORE_STAFF` | `staff@demo.local` |

即使手工把其他角色账号带到错误入口，API 也会在创建会话前拒绝登录；前端的角色包、浏览器存储和 API 登录来源校验三层同时生效。开发服务器 `npm run dev:admin` 仍是综合调试入口，不代表生产工作台边界。

入口层为每个精确域名配置独立 TLS 证书、WAF 策略和到各自静态工作台的路由。工作台的 `/api/` 只代理到内网 API 网关；网关再以健康 API 副本池转发请求，并保留工作台创建的 `X-Request-Id` 与受控转发地址。连接失败可切换副本，但网关禁止配置 Nginx 的 `non_idempotent` 重试，任何 POST 的安全重试只能依赖 API 的幂等契约。API 与 Worker 实例都不直接暴露公网端口；`TRUST_PROXY_HOPS` 必须精确等于边缘到 API 的受控代理层数。不要用一个通配 `server_name` 同时承载全部生产工作台。

## API 允许来源

共享环境必须配置精确的 `CORS_ORIGINS`，例如：

```dotenv
CORS_ORIGINS=https://platform.example.com,https://agency.example.com,https://merchant.example.com,https://verify.example.com
WORKSPACE_ORIGIN_ROLES={"https://platform.example.com":"PLATFORM_ADMIN","https://agency.example.com":"AGENCY_ADMIN","https://merchant.example.com":"MERCHANT_ADMIN","https://verify.example.com":"STORE_STAFF"}
```

该配置只接受 HTTPS、无路径、无凭据的完整来源，且拒绝重复项。`WORKSPACE_ORIGIN_ROLES` 必须包含平台、代理和商户工作台，并且每个来源必须同时出现在 `CORS_ORIGINS`。浏览器登录时，API 会在成功验密前核对 `Origin` 对应的唯一角色；未知来源或错端账号不会创建会话。即使各工作台经同源 `/api` 代理而通常不触发浏览器 CORS，也应保留该白名单，避免未来直连 API 或运维工具扩大来源范围。

核销助手小程序不经过浏览器工作台，也不会携带浏览器 `Origin`。新版本只能调用 `POST /api/v1/auth/verifier-login`，并携带 `X-Operator-Client: verifier-miniprogram-v1`；该入口拒绝任何 `Origin`，且服务端把登录角色固定为 `STORE_STAFF`。此通道用于原生请求兼容性，不是微信身份或设备证明的替代方案；真实发布仍须在微信身份能力验收后替换为受签名保护的原生登录适配器。

支付服务商回调统一落到 `https://api.<根域名>/api/payments/webhooks/<provider>`，不属于任何浏览器工作台，也不应出现在 `CORS_ORIGINS`。边缘层可额外做服务商 IP、TLS、请求体大小和速率限制；订单入账仍必须由 API 内的适配器对原始请求体完成验签。

## 发布检查

1. DNS、备案、TLS 和微信合法域名均已完成，且四个工作台没有重定向到错误子域名。
2. 每个静态包的 `VITE_WORKSPACE_ROLE` 与入口子域名一致；部署探针读取 `workspace-manifest.json` 验证角色和 `releaseId`，使用错角色账号登录被拒绝。
3. `CORS_ORIGINS` 只包含精确生产工作台来源，API 公网入口仅保留必要的微信回调与小程序请求面。
4. 入口、API 与对象存储访问日志使用同一请求 ID；API 健康响应与 `X-Release-Id` 响应头、四个工作台清单中的版本必须一致；平台安全审计与审计链完整性检查通过。
5. 真实支付、微信身份和小程序注册适配器仍须在签约、沙箱、备案和合规审查完成后单独打开。
