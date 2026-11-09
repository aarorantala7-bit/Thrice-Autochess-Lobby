'use strict';
/** Thrice Autochess test coordinator v2 (protocol 3).
 * Battle reports are client-supplied, NOT authoritative combat simulation.
 * Ranked reward validation requires a future server-side battle engine.
 */
const DURATION=Object.freeze({awaiting_acceptance:15000,connection_check:60000,preparation_first:45000,preparation:35000,prep_sync:12000,combat:35000,results:10000,boss_results:10000,special_shop:20000});
const OFFLINE_MS=8000,STARTUP_MIN_MS=1000;
const STATUS=Object.freeze({FIGHTING:'fighting',WON:'won',LOST:'lost',DRAW:'draw',WAITING:'waiting'});
const n=v=>Number.isFinite(Number(v))?Number(v):NaN;
const isBoss=r=>r>0&&r%5===0,isLive=p=>!p.eliminated,isBot=p=>!!p.bot;
const humans=m=>m.players.filter(p=>isLive(p)&&!isBot(p));
function create({record,finishMatch,clock=Date.now}){
 const emit=(m,type,detail,p=null)=>record(m,p,type,detail),now=()=>clock();
 const valid=(m,d)=>d&&d.phase===m.phase&&n(d.round)===m.round&&n(d.phaseRevision)===m.phaseRevision;
 const connected=(m,t)=>humans(m).every(p=>t-p.lastSeenAt<=OFFLINE_MS);
 const allReady=m=>humans(m).every(p=>m.phaseReady.has(p.id));
 function init(m){
  const t=now();m.protocol=3;m.phase='awaiting_acceptance';m.round=1;m.phaseRevision=0;
  m.phaseStartsAt=t;m.phaseEndsAt=t+DURATION.awaiting_acceptance;m.acceptDeadline=m.phaseEndsAt;
  m.phaseReady=new Set();m.initialConnectionChecked=false;m.battlefields=[];m.battleRevision=0;m.playerBattleStatus={};
  for(const p of m.players){p.accepted=!!p.bot;p.lastSeenAt=p.bot?t:0;p.connected=!!p.bot;p.forfeitedBeforeStart=false;}
  return m;
 }
 function fields(m){
  const survivors=m.players.filter(isLive),boss=isBoss(m.round);
  // Rotate the pairing order each round so a single player never receives
  // the ghost assignment permanently in an odd-survivor tournament.
  const shift=survivors.length?(m.round-1)%survivors.length:0;
  const players=boss?survivors:survivors.slice(shift).concat(survivors.slice(0,shift));
  const eliminated=m.players.filter(p=>p.eliminated);
  const ghostSource=(!boss&&/tournament/i.test(m.mode||'')&&players.length%2===1&&eliminated.length)
   ?eliminated[(m.round-1)%eliminated.length]:null;
  m.battlefields=[];m.playerBattleStatus={};
  for(let i=0;i<players.length;i+=boss?1:2){
   const seats=players.slice(i,i+(boss?1:2));
   const ghost=!!ghostSource&&!boss&&seats.length===1;
   m.battlefields.push({id:m.id+':R'+m.round+':'+(boss?'BOSS':ghost?'GHOST':'PVP')+(m.battlefields.length+1),round:m.round,phaseRevision:m.phaseRevision,
    kind:boss?'boss':ghost?'ghost':'pvp',playerIds:seats.map(p=>p.id),
    ghostSourceId:ghost?ghostSource.id:null,ghostDice:ghost?(ghostSource.dice||[]).filter(d=>d.zone==='board').map(d=>({kind:d.kind,index:d.index,rank:d.rank||1})):[],
    status:'in_progress',reports:{},winnerId:null,unverified:false});
  }
  for(const p of players)m.playerBattleStatus[p.id]=STATUS.FIGHTING;
  m.battleRevision++;
  emit(m,'battlefields_assigned',{round:m.round,phaseRevision:m.phaseRevision,
   fields:m.battlefields.map(f=>({id:f.id,kind:f.kind,playerIds:f.playerIds,ghostSourceId:f.ghostSourceId||null}))});
 }
 function startPhase(m,phase,t=now()){
  if(m.ended)return;
  if(phase==='connection_check'&&m.initialConnectionChecked)throw Error('Initial connection check is only allowed before Round 1');
  if(phase==='preparation'&&m.phaseRevision>0&&m.phase!=='connection_check')m.round++;
  if(phase==='preparation')m.initialConnectionChecked=true;
  m.phase=phase;m.phaseRevision++;m.phaseStartsAt=t;
  m.phaseEndsAt=t+(phase==='preparation'?(m.round===1?DURATION.preparation_first:DURATION.preparation):DURATION[phase]);
  m.phaseReady=new Set();m.players.forEach(p=>p.ready=false);
  if(phase==='combat')fields(m);
  emit(m,'phase_start',{phase,round:m.round,phaseRevision:m.phaseRevision,phaseStartsAt:t,phaseEndsAt:m.phaseEndsAt});
 }
 function seen(m,p){p.lastSeenAt=now();p.connected=true;}
 function accept(m,p){
  const t=now();
  if(m.phase!=='awaiting_acceptance'){if(p.accepted)return;throw Error('Acceptance closed');}
  if(t>m.acceptDeadline)throw Error('Acceptance expired');
  if(!p.accepted){p.accepted=true;emit(m,'accept',{},p);}seen(m,p);
  if(m.players.every(p=>p.accepted))startPhase(m,'connection_check',t);
 }
 function ready(m,p,d){
  if(!p.accepted||!isLive(p))throw Error('Player is not accepted and active');
  if(!valid(m,d))throw Error('Stale phase, refresh match state');
  if(!['preparation','prep_sync','results','boss_results','special_shop'].includes(m.phase))throw Error('This phase does not accept ready');
  seen(m,p);
  if(!m.phaseReady.has(p.id)){m.phaseReady.add(p.id);p.ready=true;emit(m,'phase_ready',{phase:m.phase,round:m.round,phaseRevision:m.phaseRevision},p);}
  tick(m);
 }
 function finishField(m,f,winner,unverified=false){
  if(f.status==='completed')return;
  f.status='completed';f.winnerId=winner;f.unverified=unverified;f.completedAt=now();
  for(const id of f.playerIds)m.playerBattleStatus[id]=winner===null?STATUS.DRAW:winner===id?STATUS.WON:STATUS.LOST;
  m.battleRevision++;
  emit(m,'battlefield_completed',{id:f.id,round:m.round,winnerId:winner,unverified,
   playerStatuses:Object.fromEntries(f.playerIds.map(id=>[id,m.playerBattleStatus[id]]))});
 }
 function resolveField(m,f){
  if(f.status==='completed')return;
  if(f.kind==='pvp'&&f.playerIds.length===1){finishField(m,f,f.playerIds[0]);return;}
  if(f.kind==='ghost'){
   const p=f.playerIds[0],r=f.reports[p];
   if(r?.aliveUnits===0)finishField(m,f,'ghost',true);
   else if(r?.claimedEnemyAlive===0)finishField(m,f,p,true);
   return;
  }
  if(f.kind==='pvp'){
   const [a,b]=f.playerIds,x=f.reports[a],y=f.reports[b];
   // An OWN zero-survivor report completes the battlefield immediately.
   // Client-supplied outcomes remain unverified without server combat simulation.
   if(x?.aliveUnits===0 || y?.aliveUnits===0){
    finishField(m,f,x?.aliveUnits===0&&y?.aliveUnits===0?null:x?.aliveUnits===0?b:a,true);return;
   }
   // A client may have stopped polling when it observed the enemy die;
   // provisional result for casual/playtest matches only, never ranked rewards.
   if(x?.claimedEnemyAlive===0 || y?.claimedEnemyAlive===0){
    finishField(m,f,x?.claimedEnemyAlive===0?a:b,true);return;
   }
   else {
    // Bots have no remote client; a human's local AI report is provisional only.
    const pa=m.players.find(p=>p.id===a),pb=m.players.find(p=>p.id===b);
    const humanId=pa?.bot&&!pb?.bot?b:pb?.bot&&!pa?.bot?a:null;
    if(humanId){
     const rp=f.reports[humanId],botId=humanId===a?b:a;
     if(rp&&(rp.aliveUnits===0||rp.claimedEnemyAlive===0))
      finishField(m,f,rp.aliveUnits>0?humanId:botId,true);
    }
   }
  }else if(f.kind==='boss'){
   const x=f.reports[f.playerIds[0]];
   if(x?.aliveUnits===0)finishField(m,f,null);
   else if(x?.claimedEnemyAlive===0&&x.aliveUnits>0)
    finishField(m,f,f.playerIds[0],true); // local boss simulator; NOT ranked verified
  }
 }
 function battleReport(m,p,d){
  if(m.phase!=='combat'||!valid(m,d))throw Error('Stale battle phase');
  if(!isLive(p)||!p.accepted)throw Error('Player not active');
  const f=m.battlefields.find(f=>f.id===d.battlefieldId);
  if(!f||!f.playerIds.includes(p.id))throw Error('Invalid battlefield sub-ID');
  const alive=n(d.aliveUnits);
  if(!Number.isInteger(alive)||alive<0||alive>100)throw Error('Invalid surviving unit count');
  seen(m,p);if(f.status==='completed')return;
  const prior=f.reports[p.id];
  f.reports[p.id]={aliveUnits:alive,at:now(),claimedEnemyAlive:Number.isInteger(n(d.enemyAliveUnits))&&n(d.enemyAliveUnits)>=0?n(d.enemyAliveUnits):null};
  if(!prior||prior.aliveUnits!==alive){
   m.battleRevision++;emit(m,'battle_status_report',{battlefieldId:f.id,round:m.round,playerId:p.id,aliveUnits:alive},p);
  }
  resolveField(m,f);tick(m);
 }
 function tick(m){
  if(m.ended)return;
  const t=now();
  if(m.phase==='awaiting_acceptance'){if(t>=m.phaseEndsAt)finishMatch(m,'match-acceptance-timeout');return;}
  if(m.phase==='connection_check'){
   if(t>=m.phaseStartsAt+STARTUP_MIN_MS&&connected(m,t)){startPhase(m,'preparation',t);return;}
   if(t>=m.phaseEndsAt){
    for(const p of humans(m))if(t-p.lastSeenAt>OFFLINE_MS){p.eliminated=true;p.forfeitedBeforeStart=true;emit(m,'startup_disconnected',{playerId:p.id},p);}
    if(!m.players.some(isLive)){finishMatch(m,'no-players-connected');return;}
    startPhase(m,'preparation',t);
   }
   return;
  }
  if(m.phase==='preparation'){if(allReady(m)||t>=m.phaseEndsAt)startPhase(m,'prep_sync',t);return;}
  if(m.phase==='prep_sync'){if(allReady(m)||t>=m.phaseEndsAt)startPhase(m,'combat',t);return;}
  if(m.phase==='combat'){
   const done=m.battlefields.every(f=>f.status==='completed');
   if(done||t>=m.phaseEndsAt){
    if(!done)for(const f of m.battlefields)if(f.status!=='completed')finishField(m,f,null,true);
    startPhase(m,isBoss(m.round)?'boss_results':'results',t);
   }
   return;
  }
  if(m.phase==='results'||m.phase==='boss_results'){
   if(t>=m.phaseEndsAt)startPhase(m,m.phase==='boss_results'?'special_shop':'preparation',t);return;
  }
  if(m.phase==='special_shop'&&t>=m.phaseEndsAt)startPhase(m,'preparation',t);
 }
 function publicState(m,base){
  if(m.protocol!==3)return base;
  return {...base,protocol:3,phase:m.phase,round:m.round,phaseRevision:m.phaseRevision,
   phaseStartsAt:m.phaseStartsAt,phaseEndsAt:m.phaseEndsAt,acceptDeadline:m.acceptDeadline,
   initialConnectionChecked:m.initialConnectionChecked,readyCount:m.phaseReady.size,
   battleRevision:m.battleRevision,
   battlefields:m.battlefields.map(f=>({id:f.id,round:f.round,phaseRevision:f.phaseRevision,
    kind:f.kind,playerIds:f.playerIds,ghostSourceId:f.ghostSourceId||null,ghostDice:f.ghostDice||[],status:f.status,winnerId:f.winnerId,unverified:f.unverified})),
   playerBattleStatus:{...m.playerBattleStatus},
   players:base.players.map(bp=>{const p=m.players.find(p=>p.id===bp.id);return {...bp,
    accepted:!!p.accepted,connected:!!p.bot||now()-p.lastSeenAt<=OFFLINE_MS,bot:!!p.bot,
    ready:m.phaseReady.has(p.id),forfeitedBeforeStart:!!p.forfeitedBeforeStart};})
  };
 }
 return {init,startPhase,accept,seen,ready,battleReport,tick,publicState};
}
module.exports={create};