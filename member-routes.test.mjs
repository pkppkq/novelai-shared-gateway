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
});
