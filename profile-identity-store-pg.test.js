'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {create}=require('./profile-identity-store-pg');
function fakePool(){
 const map=new Map();return {async query(sql,params=[]){
  if(sql.startsWith('CREATE'))return {rows:[]};
  if(sql.startsWith('INSERT')){const [id,hash]=params;if(map.has(id)){const e=Error('dup');e.code='23505';throw e;}map.set(id,hash);return {rows:[]};}
  if(sql.startsWith('SELECT credential_hash'))return {rows:map.has(params[0])?[{credential_hash:map.get(params[0])}]:[]};
  if(sql.startsWith('SELECT 1'))return {rows:[{ok:1}]};
  throw Error('Unexpected SQL');
 }};
}
test('create two distinct persistent IDs; verify only correct credentials',async()=>{
 const pool=fakePool(),a=create({pool}),r1=await a.register(),r2=await a.register();assert.notEqual(r1.profileId,r2.profileId);
 assert.equal(await a.verify(r1.profileId,r1.profileSecret),true);
 assert.equal(await a.verify(r1.profileId,r2.profileSecret),false);
 assert.equal(await a.verify(r2.profileId,r2.profileSecret),true);
 assert.equal(await a.verify('PRF-'.padEnd(36,'0'),r1.profileSecret),false);
 const reboot=create({pool});assert.equal(await reboot.verify(r1.profileId,r1.profileSecret),true);
 assert.equal(await reboot.health(),true);
});
test('rejects missing database connection and malformed credentials',async()=>{
 assert.throws(()=>create({}),/DATABASE_URL/);
 const repo=create({pool:fakePool()});assert.equal(await repo.verify(null,'x'),false);
});