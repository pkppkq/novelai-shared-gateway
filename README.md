# NovelAI Shared Gateway

**共享 Opus 的自托管网关，源码可查看，仅限非商业用途。禁止售卖、付费分发、商业托管和未经许可的商用。** 新增及修改部分见 [LICENSE](LICENSE)，上游 MIT 部分见 [NOTICE.md](NOTICE.md)。这不是 NovelAI 官方项目，也不是不受限的开源许可证。

## 功能

- 管理员创建成员账号，成员独立登录、查看自己的 Key、额度和任务。
- 逐人填写具体百分比，合计 100%；也可配置四个顶层组及组内权重，只有管理员能修改分配。
- 共用一个 Opus 上游，全局最多 4 个并发，超出排队。
- V5 恢复额度、订阅 Anlas、购买 Anlas 分账，预扣与失败退款持久化。
- 可选“个人 V5 不足转扣本地 Anlas”，参数不变，默认关闭，由管理员开启。
- 查看官方共享额度状态；兼容酒馆 Native NovelAI 和 OpenAI 风格生图接口。
- 不提供公开注册、兑换码、充值商城或旧图库管理。

## 管理员分配与成员管理

在“分组与额度”中逐人填写 0–100% 的份额，预览后保存。0% 成员保留已有余额，但不再获得后续恢复和新增额度。直接分配默认勾选“同步分配当前剩余余额”：保留各组总额，在组内按权重重分；跨组余额转移使用成员行的“调整额度”。取消勾选则只调整未来分配，当前余额不变。

成员行支持复制分发信息、重置密码、停用/恢复、精确转移 V5 或两类 Anlas，以及删除。删除先预览余额接收者，再输入用户名确认；旧登录及 Key 失效，任务和账本历史保留。启用的未分组账户可直接接替原成员的分组位置、份额及全部余额。停用仅禁止登录与调用，不自动回收额度。

有排队、运行或额度预留时暂不能修改分配。保存校验配置版本，避免覆盖其他管理操作；预览后的余额仍可能因生成或恢复变化。删除转入或调低容量后，已有 V5 可暂时超过容量，超额期间不继续恢复。

## Docker 部署

需要 Linux Docker Compose。复制示例配置并生成随机管理员密钥：

```sh
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
mkdir -p data
sudo chown 1000:1000 data
chmod 700 data
```

在 `.env` 中填写 `ADMIN_TOKEN`、自己的 `NOVELAI_TOKEN`（PST）和公网域名。管理员密钥至少 32 位，不能使用示例值。**不要把 .env 提交到 Git。**

先初始化，再启动服务：

```sh
docker compose build
docker compose run --rm gateway node scripts/bootstrap.mjs
docker compose up -d
```

初始化只允许全新数据目录，拒绝覆盖已有数据库。它创建一个上游、四个等份成员，随机密码与成员 Key 写入 `data/bootstrap-credentials.json`，不会打印到日志。请私下将对应凭据交给成员。首次查询到有效 Opus 后才分配官方额度；初始化不会生图，也不会创造官方余额。

本机管理入口：`http://127.0.0.1:18081/admin`，使用 `.env` 中的管理员密钥。需要远程管理时可用 SSH 隧道：

```sh
ssh -N -L 19080:127.0.0.1:18081 your-user@your-server
```

随后访问 `http://127.0.0.1:19080/admin`。后台支持组与成员管理、续用策略、上游状态、暂停/启用和更新 PST。更新 PST 后需要刷新额度、再明确启用；应只轮换同一官方账户的凭据，替换为另一官方账户前必须另行处理原账本。

## 公网与客户端

Compose 只绑定回环地址。使用 HTTPS 反向代理对外提供服务，参考 [Caddyfile.example](Caddyfile.example)，修改域名并保持与 `PUBLIC_HOST` 一致。管理员路由不能公开，代理不能把外部请求伪装成 localhost。不要记录 Authorization 或带 token 的完整 URL。

- 成员门户：`https://your-domain/`
- API Base：`https://your-domain/v1`
- Key：成员门户中“查看我的 API Key”，不要给成员上游 PST 或管理员密钥。

接口包括 `GET /v1/models`、`POST /v1/chat/completions`、`POST /ai/generate-image` 和 `POST /v1/ai/generate-image`。Native 接口接收 NovelAI 的 `input/model/action/parameters` 并返回 ZIP。所有生成接口都要求成员 Bearer Key；具体酒馆插件的 Base 拼接方式以插件说明为准。

## 额度语义与限制

V5 用量按图片像素与步数估算，并根据官方快照和恢复周期校准。官方可能只返回整数百分比，**个人小数额度是估计值，不是官方逐张账单**。规则可能随官方套餐变化，需要维护。

标准 1024×1024、23 步 V5 估算为约 0.057803 个百分点；转为完整 Anlas 估价时为 26 Anlas。开启续用后，个人 V5 不足便从本人的本地 Anlas 钱包扣费；失败退款，余额不足拒绝。**这仅是本地分配：上游仍可能使用公共 V5，官方 Anlas 未减少也不退本地扣款。** 公共恢复可能先偿还这种估算消耗，其他人的实际可用量仍受共享余量限制。

订阅与购买点数不混用。购买 Anlas 需要 `allowPurchasedAnlas: true`，并满足官方固定余额耗尽等条件。符合免费尺寸/步数条件的 V4.5 及更早支持模型不扣这两类额度，但仍排队。

目前共享计价支持单张纯文生图；参考图、编辑、多张等请求可能被拒绝。4 并发是本网关设置，并非官方承诺的固定速率。429 等上游失败不自动换号重试。

## 数据与测试

SQLite、图片和凭据均存于 `data/`，服务重启后保留，网页登录会话需重新建立。默认不自动删除图片/历史，请自行监控磁盘并备份。公开仓库不含生产数据、真实凭据、个人地址或部署历史。

本地开发使用 Node.js 22+：

```sh
npm ci
npm run check
npm test
```

测试使用合成账户与临时目录，不调用官方生图。不要用生产数据运行初始化测试，也不要把测试临时凭据或运行日志上传。
