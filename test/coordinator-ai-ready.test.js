'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {create}=require('../coordinator-v2');
function harness(playerCount=8,bots=0){
 let t=1000000;const events=[];const endings=[];
 const core=create({clock:()=>t,record:(m,p,type,detail)=>events.push({type,detail,playerId:p?.id||null}),finishMatch:(m,r)=>{m.ended=true;endings.push(r)}});
 const m={id:'match-test',round:1,phase:'',ended:false,players:Array.from({length:playerCount},(_,i)=>({id:'P'+(i+1),bot:i>=playerCount-bots,eliminated:false}))};
 core.init(m);
 const step=ms=>{t+=ms;core.tick(m)};
 const acceptAll=()=>{for(const p of m.players.filter(p=>!p.bot))core.accept(m,p)};
 const readyAll=()=>{for(const p of m.players.filter(p=>!p.bot&&!p.eliminated))core.ready(m,p,{phase:m.phase,round:m.round,phaseRevision:m.phaseRevision})};
 const advanceToCombat=()=>{
  if(m.phase==='preparation')step(m.phaseEndsAt-t+1);
  if(m.phase==='prep_sync')step(m.phaseEndsAt-t+1);
  assert.equal(m.phase,'combat');
 };
 return {core,m,step,acceptAll,readyAll,advanceToCombat,events,endings,now:()=>t};
}
test('only one connection gate before round one; later rounds bypass it',()=>{
 const h=harness(8);h.acceptAll();assert.equal(h.m.phase,'connection_check');h.step(1001);assert.equal(h.m.phase,'preparation');assert.equal(h.m.round,1);
 h.readyAll();assert.equal(h.m.phase,'preparation');h.advanceToCombat();assert.equal(h.m.battlefields.length,4);
 h.step(35001);assert.equal(h.m.phase,'results');h.step(10001);assert.equal(h.m.phase,'preparation');assert.equal(h.m.round,2);
 assert.equal(h.events.filter(e=>e.detail.phase==='connection_check').length,1);assert.equal(h.m.initialConnectionChecked,true);
});
test('all field reports verified pairwise; indicators come from coordinator and skip combat timer',()=>{
 const h=harness(8);h.acceptAll();h.step(1001);h.advanceToCombat();assert.equal(h.m.phase,'combat');
 const rev=h.m.phaseRevision;
 for(const f of h.m.battlefields){
  const [a,b]=f.playerIds;
  h.core.battleReport(h.m,h.m.players.find(p=>p.id===a),{phase:'combat',round:1,phaseRevision:rev,battlefieldId:f.id,aliveUnits:2});
  assert.equal(f.status,'in_progress');
  h.core.battleReport(h.m,h.m.players.find(p=>p.id===b),{phase:'combat',round:1,phaseRevision:rev,battlefieldId:f.id,aliveUnits:0});
  assert.equal(h.m.playerBattleStatus[a],'won');assert.equal(h.m.playerBattleStatus[b],'lost');
 }
 assert.equal(h.m.phase,'results');assert.equal(h.events.filter(e=>e.type==='battlefield_completed').length,4);
});
test('stale reports and third-party battlefield tampering are rejected',()=>{
 const h=harness(8);h.acceptAll();h.step(1001);h.advanceToCombat();const f=h.m.battlefields[0];
 const base={phase:'combat',round:1,phaseRevision:h.m.phaseRevision,battlefieldId:f.id,aliveUnits:1};
 assert.throws(()=>h.core.battleReport(h.m,h.m.players[2],base),/Invalid battlefield/);
 assert.throws(()=>h.core.battleReport(h.m,h.m.players[0],{...base,phaseRevision:0}),/current combat phase/);
});
test('boss round has independent player sub-IDs and results -> shop -> prep, no ordinary results',()=>{
 const h=harness(8,0);h.acceptAll();h.step(1001);
 for(let r=1;r<=4;r++){
  h.advanceToCombat();assert.equal(h.m.phase,'combat');h.step(35001);assert.equal(h.m.phase,'results');h.step(10001);
  assert.equal(h.m.round,r+1);assert.equal(h.m.phase,'preparation');
 }
 h.advanceToCombat();assert.equal(h.m.round,5);assert.equal(h.m.battlefields.length,8);
 assert.ok(h.m.battlefields.every(f=>f.kind==='boss'&&f.playerIds.length===1));
 h.step(35001);assert.equal(h.m.phase,'boss_results');h.step(10001);assert.equal(h.m.phase,'special_shop');
 h.step(20001);assert.equal(h.m.phase,'preparation');assert.equal(h.m.round,6);
 assert.equal(h.events.filter(e=>e.detail.phase==='connection_check').length,1);
 assert.equal(h.endings.length,0);
});
test('startup connection wait expires once and forfeits absent human but match continues',()=>{
 const h=harness(2);h.acceptAll();assert.equal(h.m.phase,'connection_check');
 // Only P1 continues polling; P2 is absent for the full startup grace.
 h.step(50000);h.core.seen(h.m,h.m.players[0]);h.step(9999);h.core.seen(h.m,h.m.players[0]);h.step(2);
 assert.equal(h.m.phase,'preparation');assert.equal(h.m.players[1].forfeitedBeforeStart,true);assert.equal(h.m.round,1);
});
test('time limits advance every phase without a forced match-end on missed acknowledgements',()=>{
 const h=harness(2);h.acceptAll();h.step(1001);
 h.step(45001);assert.equal(h.m.phase,'prep_sync');
 h.step(12001);assert.equal(h.m.phase,'combat');
 h.step(35001);assert.equal(h.m.phase,'results');
 h.step(10001);assert.equal(h.m.phase,'preparation');assert.deepEqual(h.endings,[]);
});
test('AI opponent and boss reports can close provisional practice fights (never ranked-verified)',()=>{
 const h=harness(2,1);h.acceptAll();h.step(1001);h.advanceToCombat();assert.equal(h.m.phase,'combat');
 const f=h.m.battlefields[0];h.core.battleReport(h.m,h.m.players[0],{
  phase:'combat',round:1,phaseRevision:h.m.phaseRevision,battlefieldId:f.id,aliveUnits:1,enemyAliveUnits:0});
 assert.equal(h.m.phase,'results');assert.equal(f.unverified,true);
 const boss=harness(1);boss.acceptAll();boss.step(1001);
 for(let r=1;r<=4;r++){boss.advanceToCombat();boss.step(35001);boss.step(10001);}
 boss.advanceToCombat();const field=boss.m.battlefields[0];assert.equal(field.kind,'boss');
 boss.core.battleReport(boss.m,boss.m.players[0],{
   phase:'combat',round:5,phaseRevision:boss.m.phaseRevision,battlefieldId:field.id,aliveUnits:1,enemyAliveUnits:0});
 assert.equal(boss.m.phase,'boss_results');assert.equal(field.unverified,true);
});
test('one player reporting zero survivors immediately completes PvP and updates both icons',()=>{
 const h=harness(8);h.acceptAll();h.step(1001);h.advanceToCombat();
 const field=h.m.battlefields[0],round=h.m.round,rev=h.m.phaseRevision;
 h.core.battleReport(h.m,h.m.players[1],{phase:'combat',round,phaseRevision:rev,battlefieldId:field.id,aliveUnits:0});
 assert.equal(field.status,'completed');
 assert.equal(h.m.playerBattleStatus['P1'],'won');
 assert.equal(h.m.playerBattleStatus['P2'],'lost');
 assert.equal(field.unverified,true);
 assert.equal(h.m.phase,'combat'); // Other three battlefields still in progress.
});
test('four single-death reports finish combat without waiting on second players',()=>{
 const h=harness(8);h.acceptAll();h.step(1001);h.advanceToCombat();
 const fields=[...h.m.battlefields],rev=h.m.phaseRevision;
 for(const field of fields){const victim=field.playerIds[1];const p=h.m.players.find(x=>x.id===victim);
  h.core.battleReport(h.m,p,{phase:'combat',round:1,phaseRevision:rev,battlefieldId:field.id,aliveUnits:0});}
 assert.equal(h.m.phase,'results');
 assert.equal(h.events.filter(e=>e.type==='battlefield_completed').length,4);
});
test('prep-sync requires separate acknowledgment after prepare, resets each round',()=>{
 const h=harness(2);h.acceptAll();h.step(1001);
 h.core.ready(h.m,h.m.players[0],{phase:'preparation',round:1,phaseRevision:h.m.phaseRevision});
 assert.equal(h.m.phase,'preparation');assert.equal(h.m.phaseReady.size,1);
 h.core.ready(h.m,h.m.players[1],{phase:'preparation',round:1,phaseRevision:h.m.phaseRevision});
 assert.equal(h.m.phase,'preparation');assert.equal(h.m.phaseReady.size,2);
 h.step(h.m.phaseEndsAt-h.now()+1);
 assert.equal(h.m.phase,'prep_sync');assert.equal(h.m.phaseReady.size,0);
 h.core.ready(h.m,h.m.players[0],{phase:'prep_sync',round:1,phaseRevision:h.m.phaseRevision});
 assert.equal(h.m.phase,'prep_sync');
 h.core.ready(h.m,h.m.players[1],{phase:'prep_sync',round:1,phaseRevision:h.m.phaseRevision});
 assert.equal(h.m.phase,'prep_sync');
 h.step(h.m.phaseEndsAt-h.now()+1);
 assert.equal(h.m.phase,'combat');
});

test('odd-survivor tournament assigns exactly one Ghost battlefield using an eliminated player',()=>{
 const h=harness(8);h.m.mode='normalTournament';h.m.players[0].dice=[{kind:'flare',zone:'board',index:4,rank:2}];h.m.players[0].eliminated=true;
 h.acceptAll();h.step(1001);
 h.advanceToCombat();
 assert.equal(h.m.phase,'combat');
 assert.equal(h.m.battlefields.length,4);
 const ghosts=h.m.battlefields.filter(f=>f.kind==='ghost');
 assert.equal(ghosts.length,1);assert.equal(ghosts[0].playerIds.length,1);
 assert.equal(ghosts[0].ghostSourceId,'P1');
 assert.equal(ghosts[0].ghostDice[0].kind,'flare');
 const p=h.m.players.find(p=>p.id===ghosts[0].playerIds[0]);
 h.core.battleReport(h.m,p,{phase:'combat',round:1,phaseRevision:h.m.phaseRevision,battlefieldId:ghosts[0].id,aliveUnits:3,enemyAliveUnits:0});
 assert.equal(ghosts[0].status,'completed');assert.equal(h.m.playerBattleStatus[p.id],'won');
 assert.equal(h.m.playerBattleStatus.P1,undefined);
});


test('a lone uncorroborated PvP victory claim cannot declare the opponent defeated',()=>{
 const h=harness(2);h.acceptAll();h.step(1001);h.advanceToCombat();
 const f=h.m.battlefields[0],base={phase:'combat',round:1,phaseRevision:h.m.phaseRevision,battlefieldId:f.id};
 h.core.battleReport(h.m,h.m.players[0],{...base,aliveUnits:3,enemyAliveUnits:0,outcome:'won'});
 assert.equal(f.status,'in_progress');assert.equal(h.m.playerBattleStatus.P1,'fighting');
 assert.equal(h.m.playerBattleStatus.P2,'fighting');
 h.core.battleReport(h.m,h.m.players[1],{...base,aliveUnits:0,enemyAliveUnits:3,outcome:'lost'});
 assert.equal(f.status,'completed');assert.equal(f.winnerId,'P1');assert.equal(f.unverified,true);
 assert.equal(h.m.playerBattleStatus.P1,'won');assert.equal(h.m.playerBattleStatus.P2,'lost');
 assert.equal(h.m.phase,'results');
});
test('mutual defeat becomes a provisional draw and is synchronized to both player indicators',()=>{
 const h=harness(2);h.acceptAll();h.step(1001);h.advanceToCombat();
 const f=h.m.battlefields[0];
 h.core.battleReport(h.m,h.m.players[0],{phase:'combat',round:1,phaseRevision:h.m.phaseRevision,
  battlefieldId:f.id,aliveUnits:0,enemyAliveUnits:0,outcome:'draw'});
 assert.equal(f.status,'completed');assert.equal(f.winnerId,null);
 assert.deepEqual(h.m.playerBattleStatus,{P1:'draw',P2:'draw'});
 const publicState=h.core.publicState(h.m,{players:h.m.players.map(p=>({id:p.id}))});
 assert.deepEqual(publicState.playerBattleStatus,{P1:'draw',P2:'draw'});
 assert.equal(publicState.battlefields[0].unverified,true);
 assert.equal(publicState.battlefields[0].reportedOutcomes.P1,'draw');
});
test('outcome claims must agree with the reported surviving dice',()=>{
 const h=harness(2);h.acceptAll();h.step(1001);h.advanceToCombat();
 const f=h.m.battlefields[0],base={phase:'combat',round:1,phaseRevision:h.m.phaseRevision,battlefieldId:f.id};
 assert.throws(()=>h.core.battleReport(h.m,h.m.players[0],{...base,aliveUnits:3,enemyAliveUnits:1,outcome:'won'}),/conflicts/);
 assert.throws(()=>h.core.battleReport(h.m,h.m.players[0],{...base,aliveUnits:3,enemyAliveUnits:-1,outcome:'fighting'}),/Invalid enemy/);
 assert.equal(f.status,'in_progress');
});
test('server times out unconfirmed PvP outcome without inventing a winner',()=>{
 const h=harness(2);h.acceptAll();h.step(1001);h.advanceToCombat();
 const f=h.m.battlefields[0];
 h.core.battleReport(h.m,h.m.players[0],{phase:'combat',round:1,phaseRevision:h.m.phaseRevision,
  battlefieldId:f.id,aliveUnits:3,enemyAliveUnits:0,outcome:'won'});
 h.step(35001);
 assert.equal(h.m.phase,'results');assert.equal(f.winnerId,null);
 assert.equal(f.unverified,true);assert.equal(h.m.playerBattleStatus.P1,'draw');
 assert.equal(h.m.playerBattleStatus.P2,'draw');
});


test('confirmed leave ends 1v1 on the server and is idempotent',()=>{
 const h=harness(2);h.m.mode='normal1v1';h.acceptAll();h.step(1001);h.advanceToCombat();
 const f=h.m.battlefields[0];
 const first=h.core.forfeit(h.m,h.m.players[0]);
 assert.equal(first.forfeited,true);assert.equal(first.already,false);
 assert.equal(h.m.players[0].eliminated,true);assert.equal(h.m.playerBattleStatus.P1,'lost');
 assert.equal(h.m.playerBattleStatus.P2,'won');assert.equal(f.winnerId,'P2');
 assert.equal(f.unverified,false);assert.equal(h.endings[0],'player-forfeit');
 const events=h.events.filter(x=>x.type==='player_forfeit');assert.equal(events.length,1);
 assert.deepEqual(h.core.forfeit(h.m,h.m.players[0]),{forfeited:true,already:true});
 assert.equal(h.events.filter(x=>x.type==='player_forfeit').length,1);
});
test('tournament leave affects only the forfeiting player and live round continues',()=>{
 const h=harness(8);h.m.mode='normalTournament';h.acceptAll();h.step(1001);h.advanceToCombat();
 const field=h.m.battlefields.find(f=>f.playerIds.includes('P1'));
 const otherFields=h.m.battlefields.filter(f=>f!==field);
 h.core.forfeit(h.m,h.m.players[0]);
 assert.equal(h.m.players[0].eliminated,true);assert.equal(h.m.playerBattleStatus.P1,'lost');
 assert.equal(field.status,'completed');assert.equal(otherFields.every(f=>f.status==='in_progress'),true);
 assert.equal(h.m.ended,false);assert.equal(h.m.phase,'combat');
});
test('prematch leave is server-confirmed and never blocks everyone else',()=>{
 const h=harness(3);h.m.mode='normalTournament';
 h.core.accept(h.m,h.m.players[0]);h.core.accept(h.m,h.m.players[1]);
 const r=h.core.forfeit(h.m,h.m.players[2]);
 assert.equal(r.forfeited,true);assert.equal(h.m.phase,'connection_check');
 assert.equal(h.m.players[2].forfeitedBeforeStart,true);
});
test('rejects arbitrary outsiders and bots from submitting leave',()=>{
 const h=harness(3,1);
 assert.throws(()=>h.core.forfeit(h.m,{id:'X'}),/Invalid human/);
 assert.throws(()=>h.core.forfeit(h.m,h.m.players[2]),/Invalid human/);
});

// ===== v0.25.4.31b: AI Ready signals and fixed shared combat start =====
test('seven AI players press Ready independently and count toward 8-player preparation',()=>{
 const h=harness(8,7);h.acceptAll();h.step(1001);
 assert.equal(h.m.phase,'preparation');
 assert.equal(h.m.phaseReady.size,0);
 const deadline=h.m.phaseEndsAt;
 h.readyAll();
 let snapshot=h.core.publicState(h.m,{players:h.m.players.map(p=>({id:p.id}))});
 assert.equal(snapshot.readyCount,1);
 assert.equal(snapshot.serverAction.readyExpected,8);
 assert.equal(snapshot.serverAction.aiReadyExpected,7);
 const readyTimes=Object.values(h.m.aiReadyAt);
 assert.equal(readyTimes.length,7);
 assert.ok(readyTimes.every(x=>x>h.now()&&x<deadline));
 const first=Math.min(...readyTimes);
 h.step(first-h.now()-1);assert.equal(h.m.phaseReady.size,1);
 h.step(2);assert.ok(h.m.phaseReady.size>1);
 const last=Math.max(...readyTimes);
 h.step(last-h.now()+1);
 assert.equal(h.m.phaseReady.size,8);
 assert.equal(h.m.phase,'preparation'); // Even 8/8 does not start combat early
 snapshot=h.core.publicState(h.m,{players:h.m.players.map(p=>({id:p.id}))});
 assert.equal(snapshot.readyCount,8);
 assert.equal(snapshot.serverAction.aiReadyCount,7);
 assert.equal(snapshot.players.filter(p=>p.bot&&p.ready).length,7);
 const botEvents=h.events.filter(x=>x.type==='phase_ready'&&x.detail.source==='server_ai');
 assert.equal(botEvents.length,7);
 assert.equal(new Set(botEvents.map(x=>x.playerId)).size,7);
 assert.ok(botEvents.every(e=>e.detail.phase==='preparation'&&e.detail.phaseRevision===h.m.phaseRevision));
 h.step(deadline-h.now());assert.equal(h.m.phase,'prep_sync');
});

test('pre-battle AI Ready acknowledgments are separate and cannot shorten the synchronization window',()=>{
 const h=harness(8,7);h.acceptAll();h.step(1001);
 h.readyAll();h.step(h.m.phaseEndsAt-h.now()+1);
 assert.equal(h.m.phase,'prep_sync');
 assert.equal(h.m.phaseReady.size,0);
 const revision=h.m.phaseRevision;
 const deadline=h.m.phaseEndsAt;
 h.readyAll(); // Human acknowledges prep_sync
 h.step(Math.max(...Object.values(h.m.aiReadyAt))-h.now()+1);
 assert.equal(h.m.phaseReady.size,8);
 assert.equal(h.m.phase,'prep_sync');
 assert.equal(h.m.phaseRevision,revision);
 h.step(deadline-h.now());
 assert.equal(h.m.phase,'combat');
 assert.equal(h.m.battlefields.length,4);
 assert.equal(h.m.phaseRevision,revision+1);
});

test('one AI has one Ready event per revision; stale/forged AI readiness cannot be submitted',()=>{
 const h=harness(2,1);h.acceptAll();h.step(1001);
 assert.throws(()=>h.core.ready(h.m,h.m.players[1],{phase:h.m.phase,round:1,phaseRevision:h.m.phaseRevision}),/server controlled/);
 h.step(Math.max(...Object.values(h.m.aiReadyAt))-h.now()+1);
 const initial=h.events.filter(e=>e.type==='phase_ready'&&e.playerId==='P2');
 assert.equal(initial.length,1);
 h.step(1000);assert.equal(h.events.filter(e=>e.type==='phase_ready'&&e.playerId==='P2').length,1);
 h.step(h.m.phaseEndsAt-h.now()+1);
 assert.equal(h.m.phase,'prep_sync');
 const newRev=h.m.phaseRevision;
 assert.throws(()=>h.core.ready(h.m,h.m.players[0],{phase:'preparation',round:1,phaseRevision:newRev-1}),/Stale phase/);
 h.step(Math.max(...Object.values(h.m.aiReadyAt))-h.now()+1);
 const aiEvents=h.events.filter(e=>e.type==='phase_ready'&&e.playerId==='P2');
 assert.equal(aiEvents.length,2);
 assert.notEqual(aiEvents[0].detail.phaseRevision,aiEvents[1].detail.phaseRevision);
});

test('special-shop AI players press Ready, but full shop timer remains authoritative',()=>{
 const h=harness(2,1);h.acceptAll();h.step(1001);
 for(let round=1;round<=5;round++){
   h.advanceToCombat();
   h.step(35001);
   assert.equal(h.m.phase,round===5?'boss_results':'results');
   h.step(10001);
 }
 assert.equal(h.m.phase,'special_shop');
 const shopEnd=h.m.phaseEndsAt;
 h.readyAll();assert.equal(h.m.phaseReady.size,1);
 h.step(Math.max(...Object.values(h.m.aiReadyAt))-h.now()+1);
 assert.equal(h.m.phaseReady.size,2);
 assert.equal(h.m.phase,'special_shop');
 assert.equal(h.m.phaseEndsAt,shopEnd);
 h.step(shopEnd-h.now()+1);
 assert.equal(h.m.phase,'preparation');assert.equal(h.m.round,6);
});

test('mixed human and AI readiness excludes eliminated players without phantom Ready counts',()=>{
 const h=harness(8,5);h.acceptAll();h.step(1001);
 h.m.players[7].eliminated=true; // An AI eliminated by earlier round history
 const human=h.m.players[0];h.core.ready(h.m,human,{phase:'preparation',round:1,phaseRevision:h.m.phaseRevision});
 h.step(Math.max(...Object.values(h.m.aiReadyAt))-h.now()+1);
 const snapshot=h.core.publicState(h.m,{players:h.m.players.map(p=>({id:p.id}))});
 assert.equal(snapshot.serverAction.readyExpected,7);
 assert.equal(snapshot.serverAction.aiReadyExpected,4);
 assert.equal(snapshot.serverAction.aiReadyCount,4);
 assert.equal(snapshot.serverAction.readyCount,5);
 assert.equal(h.m.phase,'preparation');
});