import { randomBytes } from 'node:crypto';
import { mkdir, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
class BootstrapError extends Error {}
const reject = message => { throw new BootstrapError(message); };

function readConfig(env) {
  const adminToken = String(env.ADMIN_TOKEN || '').trim();
  const upstreamToken = String(env.NOVELAI_TOKEN || '').trim();
  if (adminToken.length < 32 || /^(123456|change|replace|example|your[-_ ]?admin)/i.test(adminToken)) reject('ADMIN_TOKEN 必须设置为至少 32 位的随机管理员密钥。');
  if (!/^pst-[A-Za-z0-9_-]{20,}$/.test(upstreamToken)) reject('NOVELAI_TOKEN 必须是有效格式的 NovelAI PST。');
  const names = env.BOOTSTRAP_USERNAMES === undefined ? ['member01','member02','member03','member04'] : String(env.BOOTSTRAP_USERNAMES).split(',').map(s=>s.trim().toLowerCase());
  if (names.length !== 4 || new Set(names).size !== 4 || names.some(name=>!/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(name))) reject('BOOTSTRAP_USERNAMES 需要四个唯一用户名，用英文逗号分隔。');
  return { upstreamToken, names, dataDir: path.resolve(env.DATA_DIR || path.join(projectRoot, 'data')) };
}

async function ensureAbsent(filename) {
  try { await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  reject('数据目录已有数据库、初始化记录或凭据，拒绝覆盖；请在首次启动服务之前初始化。');
}

export async function bootstrap({ env=process.env, dependencies, log=console.log } = {}) {
  const config=readConfig(env);
  const protectedNames=['library.sqlite','library.sqlite-wal','library.sqlite-shm','library.json','library.json.bak','bootstrap-credentials.json','.bootstrap.lock'];
  for (const name of protectedNames) await ensureAbsent(path.join(config.dataDir,name));
  // 依赖在文件预检后加载；不会导入服务入口，不启动 HTTP 服务或上游请求。
  const deps=dependencies || {
    ...(await import('../server/store.js')),
    ...(await import('../server/member-auth.js')),
    ...(await import('../server/fair-quota.js')),
  };
  if(!dependencies) {
    // 提前验证原生 SQLite 依赖，避免依赖损坏时留下半初始化目录。
    const {default:Database}=await import('better-sqlite3');const probe=new Database(':memory:');probe.close();
  }
  const createdAt=new Date().toISOString();
  const credentials=config.names.map(username=>({ user_id:deps.createId('usr'), username, password:randomBytes(24).toString('base64url'), api_key:deps.createPublicToken('STA1N') }));
  const users=credentials.map(member=>({id:member.user_id,token:member.api_key,balance:0,enabled:true,note:member.username,createdAt}));
  const prepared={users};
  for (const member of credentials) await deps.setMemberCredentials(prepared,member.user_id,{username:member.username,password:member.password});
  const account={id:deps.createId('acct'),name:'Shared Opus',token:config.upstreamToken,enabled:true,weight:1,inFlight:0,total:0,failures:0,quotaPoints:null,quotaFixed:null,quotaPurchased:null,quotaTier:null,subscriptionActive:null,subscriptionExpiresAt:null,v5UsagePercent:null,v5UsageIsNegative:false,v5UsageTimeUntilNextPercent:null,quotaCheckedAt:'',quotaError:'',cooldownUntil:'',createdAt};
  const credentialPath=path.join(config.dataDir,'bootstrap-credentials.json');
  let store,lock;
  const oldMask=process.umask(0o077);
  try {
    await mkdir(config.dataDir,{recursive:true,mode:0o700});
    // 独占记录在成功后也保留。并发启动或中断后重试都不会覆盖另一份初始化数据。
    try {lock=await open(path.join(config.dataDir,'.bootstrap.lock'),'wx',0o600);} catch(error) {if(error.code==='EEXIST')reject('已有初始化记录，拒绝重复运行。');throw error;}
    await lock.writeFile(JSON.stringify({createdAt})+'\n','utf8');await lock.sync();await lock.close();lock=null;
    for (const name of protectedNames.filter(name=>name!=='.bootstrap.lock')) await ensureAbsent(path.join(config.dataDir,name));
    // 在持久化用户前保存一次性随机凭据，避免已建账户却无法找回初始密码。
    const output=await open(credentialPath,'wx',0o600);
    try {await output.chmod(0o600);await output.writeFile(JSON.stringify({createdAt,accounts:credentials},null,2)+'\n','utf8');await output.sync();} finally {await output.close();}
    store=new deps.JsonStore(config.dataDir);
    await store.init();
    await store.update(db=>{
      if (['users','accounts','cards','jobs','images','ledger'].some(name=>(db[name] || []).length) || db.settings?.fairQuota) reject('数据库并非空白，初始化已停止，未覆盖现有账户。');
      db.users=prepared.users;db.accounts=[account];
      deps.configureFairQuota(db,credentials.map(member=>member.user_id));
      // 不预发额度。首次官方刷新确认有效 Opus 后，才按真实剩余资源初始化。
      db.settings.fairQuota.autoAnlasFallback=false;
    },{collections:['settings','users','accounts'],includeSettings:true,immediate:true});
    await store.flush();await store.close();store=null;
  } finally {
    if(lock)await lock.close();
    if(store)await store.close();
    process.umask(oldMask);
  }
  log(`初始化完成；四个成员的登录凭据和 API Key 已保存至：${credentialPath}`);
  return {credentialPath,memberCount:4};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  bootstrap().catch(error=>{
    // 不回显异常对象，防止底层数据库或依赖错误将凭据写入控制台。
    console.error(error instanceof BootstrapError ? error.message : '初始化失败；已有文件均保留，请检查数据目录和运行权限，勿覆盖已有数据库。');
    process.exitCode=1;
  });
}
