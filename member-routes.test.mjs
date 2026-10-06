import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {handleMemberRoutes} from './server/member-routes.js';
import {setMemberCredentials} from './server/member-auth.js';
import {configureFairQuota} from './server/fair-quota.js';
test('独立登录、只读隔离、管理员权限、CSRF、重置与事务失败',async t=>{
 const db={settings:{},accounts:[],jobs:[],users:['a','b','c','d'].map(id=>({id,enabled:true,token:'STA1N-'+id,balance:0}))};
 configureFairQuota(db,['a','b','c','d']);await setMemberCredentials(db,'a',{username:'test-member-a',password:'Valid-password-member-a'});await setMemberCredentials(db,'b',{username:'test-member-b',password:'Valid-password-member-b'});
 let queue=Promise.resolve();const store={update(fn){queue=queue.catch(()=>{}).then(()=>fn(db));return queue;}};
 const deps={store,assertAdmin(req){if(req.headers['x-admin-token']!=='test-admin')throw Object.assign(new Error('admin required'),{statusCode:403});},createId:()=> 'new-user',createPublicToken:()=> 'STA1N-new'};
 const server=http.createServer(async(req,res)=>{try{const done=await handleMemberRoutes(req,res,new URL(req.url,'http://localhost'),deps);if(!done){res.writeHead(404);res.end();}}catch(e){res.writeHead(e.statusCode||500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+server.address().port;
 async function call(path,{body,headers={},cookie}={}) {return new Promise((resolve,reject)=>{const request=http.request(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{}),...headers}},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,headers:{get:name=>String(response.headers[name]||'')},json:async()=>JSON.parse(text)}));});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));});}
 let r=await call('/api/member/login',{body:{username:'test-member-a',password:'Valid-password-member-a'}});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
 r=await call('/api/member/me?userId=b',{cookie});const mine=await r.json();assert.equal(mine.username,'test-member-a');assert.equal(mine.quota.share,.25);assert.ok(!JSON.stringify(mine).includes('STA1N-'));assert.ok(!JSON.stringify(mine).includes('memberAuth'));
 r=await call('/api/member/key?userId=b',{cookie});assert.equal((await r.json()).apiKey,'STA1N-a');
 r=await call('/api/member/shared-status',{cookie});assert.equal(r.status,200);const shared=await r.json();assert.equal(shared.status,'pending_opus');assert.equal(shared.v5Percent,null);assert.ok(!JSON.stringify(shared).includes('STA1N'));
 r=await call('/api/member/shared-status');assert.equal(r.status,401);
 const streamed=await new Promise((resolve,reject)=>{const request=http.get(base+'/api/member/shared-events',{headers:{cookie,Origin:base}},response=>{assert.match(response.headers['content-type'],/text\/event-stream/);let text='';response.on('data',chunk=>{text+=chunk;if(text.includes('\n\n')){resolve(text);request.destroy();}});});request.on('error',reject);request.setTimeout(5000,()=>{request.destroy();reject(new Error('SSE timeout'));});});
 assert.match(streamed,/event: shared-status/);assert.match(streamed,/pending_opus/);assert.ok(!streamed.includes('STA1N'));
 for(const path of ['/api/member/groups','/api/member/credentials','/api/admin/member-management']){r=await call(path,{cookie,body:{action:'groups',groups:[]},headers:{authorization:'Bearer STA1N-a'}});assert.equal(r.status,403);}
 r=await call('/api/member/me',{cookie,headers:{Origin:'https://evil.invalid'}});assert.equal(r.status,403);
 r=await call('/api/member/login',{body:{},headers:{Origin:''}});assert.equal(r.status,403);
 r=await call('/api/admin/member-management',{headers:{'x-admin-token':'test-admin'}});assert.equal(r.status,200);const admin=await r.json();assert.equal(admin.groups.length,4);assert.ok(!JSON.stringify(admin).includes('memberAuth'));
 r=await call('/api/admin/member-management',{cookie,body:{action:'fallback-policy',enabled:true}});assert.equal(r.status,403);
 r=await call('/api/admin/member-management',{body:{action:'fallback-policy',enabled:true},headers:{'x-admin-token':'test-admin'}});assert.equal(r.status,200);assert.equal(db.settings.fairQuota.autoAnlasFallback,true);
 r=await call('/api/member/me',{cookie});assert.equal((await r.json()).quota.autoAnlasFallback,true);
 r=await call('/api/admin/member-management',{body:{action:'credentials',username:'invalid',password:'short'},headers:{'x-admin-token':'test-admin'}});assert.equal(r.status,400);assert.equal(db.users.length,4);
 r=await call('/api/admin/member-management',{body:{action:'credentials',userId:'a',username:'test-member-a',password:'Reset-password-member-a'},headers:{'x-admin-token':'test-admin'}});assert.equal(r.status,200);
 r=await call('/api/member/me',{cookie});assert.equal(r.status,401);
 r=await call('/api/member/login',{body:{username:'test-member-b',password:'Valid-password-member-b'},headers:{Host:'nai.example',Origin:'https://nai.example'}});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/; Secure/);
 r=await call('/api/admin/member-management',{headers:{Host:'nai.example',Origin:'https://nai.example','x-admin-token':'test-admin'}});assert.equal(r.status,404);

 // 管理新增操作使用同一私有入口；成员 Cookie 与 Key 都不能提权。
 const manage=body=>call('/api/admin/member-management',{body,headers:{'x-admin-token':'test-admin'}});
 for(const action of ['member-key','member-status','preview-groups']){r=await call('/api/admin/member-management',{body:{action,userId:'b',enabled:false,groups:[]},cookie,headers:{authorization:'Bearer STA1N-a'}});assert.equal(r.status,403);}
 r=await manage({action:'member-key',userId:'b'});assert.deepEqual(await r.json(),{apiKey:'STA1N-b'});
 r=await manage({action:'member-key',userId:'missing'});assert.equal(r.status,404);
 r=await manage({action:'member-status',userId:'b',enabled:'false'});assert.equal(r.status,400);assert.equal(db.users.find(u=>u.id==='b').enabled,true);
 r=await call('/api/admin/member-management',{body:{action:'member-key',userId:'b'},headers:{'x-admin-token':'test-admin',Origin:'https://evil.invalid'}});assert.equal(r.status,403);

 // 预览允许估算恢复与重分，但不能在真实账本留下余额、版本或审计变化。
 db.users.push({id:'e',token:'STA1N-e',enabled:true,balance:0});db.settings.fairQuota.balances.a.v5Available=8;db.settings.fairQuota.balances.a.anlasFixedAvailable=100;db.settings.fairQuota.balances.a.anlasAvailable=100;
 const proposed=structuredClone(db.settings.fairQuota.groups);proposed[0].members.push('e');const beforePreview=structuredClone(db);
 r=await manage({action:'preview-groups',groups:proposed,redistributeRemaining:true});assert.equal(r.status,200);const preview=await r.json();
 assert.equal(preview.configVersion,beforePreview.settings.fairQuota.configVersion);assert.equal(preview.redistributeRemaining,true);assert.equal(preview.users.find(u=>u.id==='a').quota.v5Available,4);assert.equal(preview.users.find(u=>u.id==='e').quota.anlasFixedAvailable,50);assert.deepEqual(db,beforePreview);assert.ok(!JSON.stringify(preview).includes('STA1N-'));
 r=await manage({action:'groups',groups:proposed,redistributeRemaining:true,expectedConfigVersion:preview.configVersion-1});assert.equal(r.status,409);assert.deepEqual(db,beforePreview);
 r=await manage({action:'groups',groups:proposed,redistributeRemaining:true,expectedConfigVersion:preview.configVersion});assert.equal(r.status,200);assert.equal((await r.json()).configVersion,preview.configVersion+1);
 const afterSave=structuredClone(db);r=await manage({action:'groups',groups:proposed,expectedConfigVersion:preview.configVersion});assert.equal(r.status,409);assert.deepEqual(db,afterSave);

 // 创建成员与加入组同事务提交，密码失败、组不存在或预留冲突不会留下半个成员。
 let beforeCreate=structuredClone(db);
 r=await manage({action:'credentials',username:'new-member',password:'Valid-password-new-member',groupId:'missing'});assert.equal(r.status,400);assert.deepEqual(db,beforeCreate);
 r=await manage({action:'credentials',username:'new-member',password:'short',groupId:proposed[0].id});assert.equal(r.status,400);assert.deepEqual(db,beforeCreate);
 db.settings.fairQuota.reservations.testHeld={userId:'a',status:'reserved',resource:'free',amount:0};beforeCreate=structuredClone(db);
 r=await manage({action:'credentials',username:'new-member',password:'Valid-password-new-member',groupId:proposed[0].id});assert.equal(r.status,409);assert.deepEqual(db,beforeCreate);
 db.settings.fairQuota.reservations.testHeld.status='refunded';
 r=await manage({action:'credentials',username:'new-member',password:'Valid-password-new-member',groupId:proposed[0].id});assert.equal(r.status,200);const created=await r.json();assert.equal(created.id,'new-user');assert.equal(created.groupId,proposed[0].id);assert.ok(db.settings.fairQuota.groups[0].members.includes(created.id));assert.equal(db.settings.fairQuota.balances[created.id].v5Available,0);
 r=await manage({action:'credentials',userId:'a',username:'test-member-a',password:'Another-password-member-a',groupId:proposed[0].id});assert.equal(r.status,400);

 // 停用保留额度与份额，立即拒绝登录；重新启用不会复活停用前的会话。
 r=await call('/api/member/login',{body:{username:'test-member-a',password:'Reset-password-member-a'}});assert.equal(r.status,200);const priorCookie=r.headers.get('set-cookie').split(';')[0];
 const quotaBeforeDisable=structuredClone(db.settings.fairQuota),tokenBefore=db.users.find(u=>u.id==='a').token;
 r=await manage({action:'member-status',userId:'a',enabled:false});assert.equal(r.status,200);assert.deepEqual(db.settings.fairQuota,quotaBeforeDisable);assert.equal(db.users.find(u=>u.id==='a').token,tokenBefore);
 r=await call('/api/member/me',{cookie:priorCookie});assert.equal(r.status,401);r=await call('/api/member/login',{body:{username:'test-member-a',password:'Reset-password-member-a'}});assert.equal(r.status,401);
 r=await manage({action:'member-status',userId:'a',enabled:true});assert.equal(r.status,200);r=await call('/api/member/me',{cookie:priorCookie});assert.equal(r.status,401);r=await call('/api/member/login',{body:{username:'test-member-a',password:'Reset-password-member-a'}});assert.equal(r.status,200);
 db.jobs.push({id:'busy',userToken:'STA1N-e',status:'queued'});r=await manage({action:'member-status',userId:'e',enabled:false});assert.equal(r.status,409);assert.equal(db.users.find(u=>u.id==='e').enabled,true);
 db.jobs.at(-1).status='failed';r=await manage({action:'member-status',userId:'e',enabled:false});assert.equal(r.status,200);
 r=await call('/api/admin/member-management',{headers:{'x-admin-token':'test-admin'}});const overview=await r.json();assert.equal(overview.configVersion,db.settings.fairQuota.configVersion);assert.equal(overview.shared.status,'pending_opus');assert.equal(overview.users.find(u=>u.id==='e').recentActivity.failed,1);assert.ok(!JSON.stringify(overview).includes('memberAuth'));assert.ok(!JSON.stringify(overview).includes('STA1N-'));

 // 删除和转账只能管理员操作，失败与预览都不能产生任何数据写入。
 for(const action of ['transfer-quota','preview-delete-member','delete-member']){r=await call('/api/admin/member-management',{body:{action,userId:'a',transferToUserId:'b'},headers:{authorization:'Bearer STA1N-a'}});assert.equal(r.status,403);}
 let deletion={action:'preview-delete-member',userId:'a',transferToUserId:'b',expectedConfigVersion:db.settings.fairQuota.configVersion};
 let beforeDelete=structuredClone(db);r=await manage(deletion);assert.equal(r.status,200);const deletePreview=await r.json();assert.equal(deletePreview.deletedUserId,'a');assert.equal(deletePreview.configVersion,deletion.expectedConfigVersion);assert.deepEqual(db,beforeDelete);assert.ok(!JSON.stringify(deletePreview).includes('STA1N-'));
 r=await manage({...deletion,action:'delete-member',expectedConfigVersion:0});assert.equal(r.status,409);assert.deepEqual(db,beforeDelete);
 r=await manage({action:'transfer-quota',fromUserId:'a',toUserId:'b',resource:'anlasFixed',amount:10,expectedConfigVersion:deletion.expectedConfigVersion});assert.equal(r.status,200);assert.equal(db.settings.fairQuota.balances.b.anlasFixedAvailable,beforeDelete.settings.fairQuota.balances.b.anlasFixedAvailable+10);
 r=await call('/api/member/login',{body:{username:'test-member-a',password:'Reset-password-member-a'}});assert.equal(r.status,200);const deletedCookie=r.headers.get('set-cookie').split(';')[0];
 deletion.expectedConfigVersion=db.settings.fairQuota.configVersion;const historicalJobs=structuredClone(db.jobs),historicalReservations=structuredClone(db.settings.fairQuota.reservations);
 r=await manage({...deletion,action:'delete-member'});assert.equal(r.status,200);assert.ok(!db.users.some(u=>u.id==='a'));assert.equal(db.settings.fairQuota.balances.a,undefined);assert.deepEqual(db.jobs,historicalJobs);assert.deepEqual(db.settings.fairQuota.reservations,historicalReservations);
 r=await call('/api/member/me',{cookie:deletedCookie});assert.equal(r.status,401);r=await call('/api/member/login',{body:{username:'test-member-a',password:'Reset-password-member-a'}});assert.equal(r.status,401);r=await manage({action:'member-key',userId:'a'});assert.equal(r.status,404);
});
