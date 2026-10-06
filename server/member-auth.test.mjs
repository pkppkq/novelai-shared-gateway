import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from './member-auth.js';
test('密码散列、账户唯一、会话过期及重置撤销',async()=>{
 const db={users:[{id:'a',enabled:true},{id:'b',enabled:true}]};
 await auth.setMemberCredentials(db,'a',{username:'MemberOne',password:'A-valid-test-password-123'});
 assert.equal(db.users[0].memberAuth.username,'memberone');assert.ok(!JSON.stringify(db).includes('A-valid-test-password'));
 await assert.rejects(auth.setMemberCredentials(db,'b',{username:'MEMBERONE',password:'A-valid-test-password-123'}),e=>e.statusCode===409);
 await assert.rejects(auth.loginMember(db,'memberone','bad'),e=>e.statusCode===401);
 await assert.rejects(auth.loginMember(db,'missing','bad'),e=>e.statusCode===401);
 const user=await auth.loginMember(db,'MEMBERONE','A-valid-test-password-123');
 const token=auth.createMemberSession(user,1000);assert.equal(auth.authenticateMemberSession(db,token,1001).id,'a');assert.equal(auth.authenticateMemberSession(db,token,1000+12*3600000),null);
 const next=auth.createMemberSession(user);await auth.setMemberCredentials(db,'a',{username:'memberone',password:'Another-valid-password-456'});assert.equal(auth.authenticateMemberSession(db,next),null);
 const disabled=auth.createMemberSession(db.users[0]);db.users[0].enabled=false;assert.equal(auth.authenticateMemberSession(db,disabled),null);
 await assert.rejects(auth.loginMember(db,'memberone','Another-valid-password-456'),e=>e.statusCode===401);
});
test('登录尝试在密码验证前限流且到期可恢复',()=>{
 for(let i=0;i<10;i++)auth.checkMemberLoginRate('rate-user','test-peer',1000);
 assert.throws(()=>auth.checkMemberLoginRate('rate-user','test-peer',1001),e=>e.statusCode===429);
 assert.doesNotThrow(()=>auth.checkMemberLoginRate('rate-user','test-peer',1000+15*60000));
});
