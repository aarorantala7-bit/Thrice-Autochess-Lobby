'use strict';
// Test-only live integration against the deployed Thrice server.
// Creates one disposable test profile and one normal tournament match.
const BASE='https://thrice-autochess-lobby-test.onrender.com';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function request(path,body,acceptable=[200]){
 const response=await fetch(BASE+path,{method:body===undefined?'GET':'POST',
   headers:body===undefined?{}:{'Content-Type':'application/json'},
   body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const value=await response.json();
 if(!acceptable.includes(response.status))throw Error(path+' returned HTTP '+response.status);
 return value;
}
function check(test,message){if(!test)throw Error(message)}
async function poll(fn,{maxMs=40000,interval=1000}={}){
 const limit=Date.now()+maxMs;
 for(;;){
  const result=await fn();if(result)return result;
  if(Date.now()>=limit)throw Error('Timed out waiting for server phase');
  await sleep(interval);
 }
}
let identity,lobby;
let stage='health';
try{
 const health=await request('/health');
 check(health.ok&&health.protocol===3&&health.profileDatabase,'Protocol-3/Postgres not healthy');
 identity=await request('/api/profileRegister',{});
 check(identity.profileId&&identity.profileSecret,'Profile registration failed');
 const auth=d=>({...d,profileId:identity.profileId,profileSecret:identity.profileSecret});
 stage='lobby';
 lobby=await request('/api/create',auth({name:'AIReadySmoke',mode:'normalTournament',rankTier:0,mmr:1000}));
 const code=lobby.code,token=lobby.token;
 await request('/api/ready',auth({code,token,ready:true}));
 await request('/api/queue',auth({code,token}));
 const matchId=await poll(async()=>{
  const room=await request('/api/lobby/'+code);
  return room.matchId||null;
 },{maxMs:40000,interval:1000});
 stage='accept';
 await request('/api/matchAccept',{matchId,token});
 const state=()=>request('/api/matchState',{matchId,token,since:0});
 const prep=await poll(async()=>{
  const r=await state();return r.state?.phase==='preparation'?r:null;
 },{maxMs:20000,interval:900});
 check(prep.state.protocol===3&&prep.state.serverOwnedCountdowns===true,'Shared server clock flag missing');
 check(prep.state.players.filter(p=>p.bot).length===7,'Expected exactly seven AI players');
 check(prep.state.serverAction.readyExpected===8,'AI missing from expected Ready count');
 const prepRevision=prep.state.phaseRevision,deadline=prep.state.phaseEndsAt;
 stage='preparation';
 const ready=await request('/api/matchReady',{matchId,token,phase:'preparation',round:1,phaseRevision:prepRevision});
 check(ready.state.phase==='preparation'&&ready.state.readyCount>=1,'Human Ready skipped preparation');
 const full=await poll(async()=>{
  const r=await state();
  if(r.state?.phase!=='preparation')throw Error('Preparation ended before all AI checks');
  return r.state.readyCount===8?r:null;
 },{maxMs:44000,interval:1000});
 check(full.state.phaseEndsAt===deadline,'Preparation deadline moved');
 check(full.state.serverAction.aiReadyCount===7,'AI actions not recorded individually');
 const aiEvents=full.events.filter(x=>x.type==='phase_ready'&&x.detail?.source==='server_ai'&&x.detail?.phase==='preparation');
 check(new Set(aiEvents.map(x=>x.playerId)).size===7,'Missing distinct AI Ready events');
 stage='prep_sync';
 const sync=await poll(async()=>{
  const r=await state();return r.state?.phase==='prep_sync'?r:null;
 },{maxMs:18000,interval:900});
 check(sync.state.readyCount===0,'Readiness did not reset for prebattle');
 const syncDeadline=sync.state.phaseEndsAt;
 await request('/api/matchReady',{matchId,token,phase:'prep_sync',round:1,phaseRevision:sync.state.phaseRevision});
 const botSync=await poll(async()=>{
  const r=await state();return r.state?.phase==='prep_sync'&&r.state.readyCount===8?r:null;
 },{maxMs:8000,interval:900});
 check(botSync.state.phase==='prep_sync','Combat started before full prebattle window');
 stage='combat';
 const combat=await poll(async()=>{
  const r=await state();return r.state?.phase==='combat'?r:null;
 },{maxMs:15000,interval:700});
 check(combat.state.phaseStartsAt>=syncDeadline,'Combat began before the server deadline');
 console.log(JSON.stringify({result:'passed',profileRegistration:true,aiReadyActions:7,
   readyCountBeforeCombat:'8/8',preparationDeadlinePreserved:true,
   prebattleDeadlinePreserved:true,combatPhaseRevision:combat.state.phaseRevision,credentialsPrinted:false}));
}catch(e){console.error(JSON.stringify({result:'failed',stage,error:e.message}));process.exitCode=1;}
finally{
 if(lobby&&identity){const auth=d=>({...d,profileId:identity.profileId,profileSecret:identity.profileSecret});
  try{
   const room=await request('/api/lobby/'+lobby.code);
   if(room.matchId)try{await request('/api/matchLeave',{matchId:room.matchId,token:lobby.token});}catch{}
   await request('/api/leave',auth({code:lobby.code,token:lobby.token}));
  }catch{}
 }
}