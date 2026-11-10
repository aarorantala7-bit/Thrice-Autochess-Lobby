'use strict';
/** Thrice Autochess test coordinator v2 (protocol 3).
 * Pure state machine: this module does not implement or claim authoritative combat.
 * Results from clients must be corroborated by both participants until a server combat
 * simulation is available. No ranked rewards are awarded here.
 */
const DURATION = Object.freeze({
  awaiting_acceptance:15000, connection_check:60000,
  preparation_first:45000, preparation:35000, prep_sync:12000,
  combat:35000, results:10000, boss_results:10000, special_shop:20000
});
const OFFLINE_MS=8000;
const STARTUP_MIN_MS=1000;
const STATUS=Object.freeze({FIGHTING:'fighting',WON:'won',LOST:'lost',DRAW:'draw',WAITING:'waiting'});
const OUTCOME=Object.freeze({WON:'won',LOST:'lost',DRAW:'draw',FIGHTING:'fighting'});
const n = v => Number.isFinite(Number(v)) ? Number(v) : NaN;
const isBoss = round => round>0 && round%5===0;
const isLive = p => !p.eliminated;
const isBot = p => !!p.bot;
const liveHumans = m => m.players.filter(p=>isLive(p)&&!isBot(p));
const liveParticipants = m => m.players.filter(isLive);
const nowReady = (m, now) => liveHumans(m).every(p=>now-p.lastSeenAt<=OFFLINE_MS);
const READY_PHASES = new Set(['preparation','prep_sync','results','boss_results','special_shop']);
// Each AI receives a deterministic, per-player/per-phase simulated action time.
// This is server-owned: the client never submits readiness on behalf of bots.
function aiReadyDelay(m,p,phase,duration) {
  let hash=2166136261;
  const seed=String(p.id)+'|'+m.round+'|'+m.phaseRevision+'|'+phase;
  for(let i=0;i<seed.length;i++)hash=Math.imul(hash^seed.charCodeAt(i),16777619)>>>0;
  const portion=(hash%1000)/1000;
  const range=phase==='preparation'?[0.50,0.82]:
    phase==='special_shop'?[0.40,0.78]:
    phase==='prep_sync'?[0.12,0.30]:[0.15,0.48];
  return Math.min(Math.max(0,duration-250),Math.floor(duration*(range[0]+(range[1]-range[0])*portion)));
}
function create({record,finishMatch,clock=Date.now}) {
  if(typeof record!=='function'||typeof finishMatch!=='function')throw Error('Missing record/finishMatch hooks');
  const emit=(m,type,detail,player=null)=>record(m,player,type,detail);
  const current=()=>clock();
  const validPhase=(m,input)=>input&&String(input.phase)===m.phase&&n(input.round)===m.round&&n(input.phaseRevision)===m.phaseRevision;
  function init(m) {
    const now=current();m.protocol=3;m.phase='awaiting_acceptance';m.round=1;
    m.phaseRevision=0;m.phaseStartsAt=now;m.phaseEndsAt=now+DURATION.awaiting_acceptance;
    m.acceptDeadline=m.phaseEndsAt;m.phaseReady=new Set();m.aiReadyAt={};
    m.initialConnectionChecked=false;m.initialConnectionStartedAt=0;
    m.battlefields=[];m.playerBattleStatus={};m.battleRevision=0;
    for(const p of m.players){p.accepted=isBot(p);p.lastSeenAt=isBot(p)?now:0;p.connected=isBot(p);p.forfeitedBeforeStart=false;}
    return m;
  }
  function startPhase(m,phase,now=current()) {
    if(m.ended)return;
    if(phase==='connection_check'&&m.initialConnectionChecked)throw Error('Startup connection check must run only once');
    if(phase==='preparation'&&m.phaseRevision>0&&m.phase!=='connection_check')m.round++;
    if(phase==='preparation')m.initialConnectionChecked=true;
    m.phase=phase;m.phaseRevision++;m.phaseStartsAt=now;
    const duration=phase==='preparation'?(m.round===1?DURATION.preparation_first:DURATION.preparation):DURATION[phase];
    m.phaseEndsAt=now+duration;m.phaseReady=new Set();m.aiReadyAt={};
    for(const p of m.players){
      p.ready=false;
      if(isBot(p)&&isLive(p)&&READY_PHASES.has(phase))
        m.aiReadyAt[p.id]=now+aiReadyDelay(m,p,phase,duration);
    }
    if(phase==='connection_check')m.initialConnectionStartedAt=now;
    if(phase==='combat')assignFields(m);
    emit(m,'phase_start',{phase,round:m.round,phaseRevision:m.phaseRevision,phaseStartsAt:now,phaseEndsAt:m.phaseEndsAt});
  }
  function assignFields(m){
    const survivors=m.players.filter(isLive); const boss=isBoss(m.round);const fields=[];
    // Stable rotating pairing so ghost matches are distributed, not perpetual byes.
    const rotation=survivors.length?(m.round-1)%survivors.length:0;
    const active=boss?survivors:survivors.slice(rotation).concat(survivors.slice(0,rotation));
    const eliminated=m.players.filter(p=>p.eliminated);
    const ghostSource=(!boss&&/tournament/i.test(m.mode||'')&&active.length%2===1&&eliminated.length)?eliminated[(m.round-1)%eliminated.length]:null;
    for(let i=0;i<active.length;i+=(boss?1:2)){
      const players=active.slice(i,i+(boss?1:2));const ghost=!boss&&players.length===1&&!!ghostSource;
      const id=`${m.id}:R${m.round}:${boss?'BOSS':ghost?'GHOST':'PVP'}${fields.length+1}`;
      fields.push({id,round:m.round,phaseRevision:m.phaseRevision,kind:boss?'boss':ghost?'ghost':'pvp',
        playerIds:players.map(p=>p.id),ghostSourceId:ghost?ghostSource.id:null,
        ghostDice:ghost?(ghostSource.dice||[]).filter(d=>d.zone==='board').map(d=>({kind:d.kind,index:d.index,rank:d.rank||1})):[],
        status:'in_progress',
        reports:{},checks:{},winnerId:null,completedAt:null,unverified:false});
    }
    m.battlefields=fields;m.battleRevision++;
    m.playerBattleStatus={};
    for(const p of active)m.playerBattleStatus[p.id]=STATUS.FIGHTING;
    emit(m,'battlefields_assigned',{round:m.round,phaseRevision:m.phaseRevision,
      fields:fields.map(f=>({id:f.id,kind:f.kind,playerIds:f.playerIds,checks:{...(f.checks||{})},ghostSourceId:f.ghostSourceId||null}))});
  }
  function accept(m,p){
    const now=current();if(m.phase!=='awaiting_acceptance'){
      if(p.accepted)return;throw Error('Acceptance closed');
    }
    if(now>m.acceptDeadline)throw Error('Acceptance expired');
    if(!p.accepted){p.accepted=true;emit(m,'accept',{},p);}
    seen(m,p);
    if(m.players.every(x=>x.accepted))startPhase(m,'connection_check',now);
  }
  function seen(m,p){
    const now=current();p.lastSeenAt=now;p.connected=true;
    // Presence is reported through state snapshots and phase events, not as a revision every second.
  }
  // Human and AI Ready checks go through the same server bookkeeping/event path.
  // Duplicate acknowledgments are idempotent within a single phase revision.
  function markReady(m,p,source){
    if(m.phaseReady.has(p.id))return false;
    m.phaseReady.add(p.id);p.ready=true;
    emit(m,'phase_ready',{phase:m.phase,round:m.round,phaseRevision:m.phaseRevision,
      source},p);
    return true;
  }
  function simulateAiReady(m,now){
    if(!READY_PHASES.has(m.phase))return;
    for(const p of m.players){
      if(!isBot(p)||!isLive(p)||!p.accepted||m.phaseReady.has(p.id))continue;
      if(now>=(m.aiReadyAt?.[p.id]??Infinity))markReady(m,p,'server_ai');
    }
  }
  function ready(m,p,data){
    if(isBot(p))throw Error('AI readiness is server controlled');
    if(!p.accepted||!isLive(p))throw Error('Not an active accepted player');
    if(!validPhase(m,data))throw Error('Stale phase; request updated match state');
    if(!READY_PHASES.has(m.phase))throw Error('This phase does not accept ready acknowledgments');
    seen(m,p);
    markReady(m,p,'player');
    tick(m);
  }
  function confirmBattlefield(m,p,data){
    if(m.phase!=='combat'||!validPhase(m,data))throw Error('Battlefield check does not match current combat phase');
    if(!isLive(p)||!p.accepted)throw Error('Not an active player');
    const field=m.battlefields.find(f=>f.id===data.battlefieldId);
    if(!field||!field.playerIds.includes(p.id))throw Error('Invalid battlefield sub-ID');
    seen(m,p);
    field.checks=field.checks||{};
    if(!field.checks[p.id]){
      field.checks[p.id]=true;
      emit(m,'battlefield_checked',{id:field.id,round:m.round,phaseRevision:m.phaseRevision},p);
    }
    return field;
  }
  function battleReport(m,p,data){
    if(m.phase!=='combat'||!validPhase(m,data))throw Error('Battle report does not match current combat phase');
    if(!isLive(p)||!p.accepted)throw Error('Not an active player');
    const field=m.battlefields.find(f=>f.id===data.battlefieldId);
    if(!field||!field.playerIds.includes(p.id))throw Error('Invalid battlefield sub-ID');
    const alive=n(data.aliveUnits);
    if(!Number.isInteger(alive)||alive<0||alive>100)throw Error('Invalid surviving dice count');
    const enemyInput=data.enemyAliveUnits;
    const enemy=enemyInput===null||enemyInput===undefined?null:n(enemyInput);
    if(enemy!==null&&(!Number.isInteger(enemy)||enemy<0||enemy>100))throw Error('Invalid enemy surviving dice count');
    const observed=alive===0?(enemy===0?OUTCOME.DRAW:OUTCOME.LOST):(enemy===0?OUTCOME.WON:OUTCOME.FIGHTING);
    if(data.outcome!==undefined&&data.outcome!==observed)throw Error('Battle outcome conflicts with surviving dice count');
    seen(m,p);
    field.checks=field.checks||{};field.checks[p.id]=true; // implicit acknowledgment for older clients
    if(field.status==='completed')return;
    const prev=field.reports[p.id];
    field.reports[p.id]={aliveUnits:alive,at:current(),claimedEnemyAlive:enemy,outcome:observed};
    if(!prev||prev.aliveUnits!==alive||prev.claimedEnemyAlive!==enemy||prev.outcome!==observed){
      m.battleRevision++;
      emit(m,'battle_status_report',{battlefieldId:field.id,round:m.round,
        playerId:p.id,aliveUnits:alive,enemyAliveUnits:enemy,outcome:observed},p);
    }
    resolveField(m,field);
    tick(m);
  }
  function resolveField(m,f){
    if(f.status==='completed')return;
    if(f.kind==='ghost'){
      const id=f.playerIds[0],report=f.reports[id];
      if(report?.outcome===OUTCOME.DRAW){finishField(m,f,null,true);return;}
      if(report?.outcome===OUTCOME.LOST){finishField(m,f,'ghost',true);return;}
      if(report?.outcome===OUTCOME.WON){finishField(m,f,id,true);return;}
      return;
    }
    if(f.kind==='pvp'&&f.playerIds.length===2){
      const [a,b]=f.playerIds,ra=f.reports[a],rb=f.reports[b];
      // Mutual elimination is a draw, including when one client reports that
      // both sides have fallen before the other client can send a report.
      if(ra?.outcome===OUTCOME.DRAW||rb?.outcome===OUTCOME.DRAW||
         ra?.aliveUnits===0&&rb?.aliveUnits===0){
        finishField(m,f,null,true);return;
      }
      // Self-reported defeat may settle a provisional casual battlefield.
      // A *winning* claim from one client cannot settle a human-vs-human
      // battlefield on its own: wait for the opponent's own loss observation.
      if(ra?.outcome===OUTCOME.LOST){finishField(m,f,b,true);return;}
      if(rb?.outcome===OUTCOME.LOST){finishField(m,f,a,true);return;}
      const pa=m.players.find(p=>p.id===a),pb=m.players.find(p=>p.id===b);
      const humanId=pa?.bot&&!pb?.bot?b:pb?.bot&&!pa?.bot?a:null;
      if(humanId){
        // Bot and ghost simulation still run on the client in this test build.
        const report=f.reports[humanId],botId=humanId===a?b:a;
        if(report?.outcome===OUTCOME.WON){finishField(m,f,humanId,true);return;}
        if(report?.outcome===OUTCOME.LOST){finishField(m,f,botId,true);return;}
      }
      return;
    }
    if(f.kind==='pvp'&&f.playerIds.length===1){
      // A bye is a server-assigned result and requires no client report.
      finishField(m,f,f.playerIds[0],false);return;
    }
    if(f.kind==='boss'){
      const id=f.playerIds[0],report=f.reports[id];
      if(report?.outcome===OUTCOME.LOST||report?.outcome===OUTCOME.DRAW){
        finishField(m,f,null,true);return;
      }
      if(report?.outcome===OUTCOME.WON){
        // Boss is locally simulated for now. This is not a ranked verification.
        finishField(m,f,id,true);return;
      }
    }
  }
  function finishField(m,f,winner,unverified){
    if(f.status==='completed')return;
    f.status='completed';f.winnerId=winner;f.completedAt=current();f.unverified=!!unverified;
    for(const id of f.playerIds)m.playerBattleStatus[id]=winner===null?STATUS.DRAW:(winner===id?STATUS.WON:STATUS.LOST);
    m.battleRevision++;
    emit(m,'battlefield_completed',{id:f.id,round:m.round,winnerId:winner,unverified:!!unverified,
      playerStatuses:Object.fromEntries(f.playerIds.map(id=>[id,m.playerBattleStatus[id]]))});
  }
  // Explicit, token-authenticated voluntary leave. A player cannot erase an
  // online match just by clearing their own local save.
  function forfeit(m,p){
    if(!m||!p||!m.players.includes(p)||isBot(p))throw Error('Invalid human participant');
    if(p.eliminated)return {forfeited:true,already:true};
    if(m.ended)throw Error('Match is already finished');
    p.eliminated=true;p.ready=false;p.connected=false;
    p.forfeitedBeforeStart=['awaiting_acceptance','connection_check'].includes(m.phase);
    p.accepted=true; // Do not block surviving players in the acceptance gate.
    m.phaseReady.delete(p.id);
    const field=(m.battlefields||[]).find(f=>f.status==='in_progress'&&f.playerIds.includes(p.id));
    if(field){
      const winner=field.kind==='pvp'?field.playerIds.find(id=>id!==p.id&&m.players.some(x=>x.id===id&&!x.eliminated))||null:null;
      // A forfeit is server-confirmed, not a client-reported combat result.
      finishField(m,field,winner,false);
      m.playerBattleStatus[p.id]=STATUS.LOST;
    }else{
      m.playerBattleStatus[p.id]=STATUS.LOST;
      m.battleRevision++;
    }
    emit(m,'player_forfeit',{playerId:p.id,round:m.round,phase:m.phase,phaseRevision:m.phaseRevision},p);
    const stillLive=m.players.filter(isLive);
    if(stillLive.length<=1){finishMatch(m,'player-forfeit');}
    else if(m.phase==='awaiting_acceptance'&&m.players.every(x=>x.accepted))startPhase(m,'connection_check');
    else tick(m);
    return {forfeited:true,already:false};
  }
  function expireCombat(m){
    for(const f of m.battlefields){if(f.status==='completed')continue;
      // Expire unresolved reports without inventing verified winners.
      finishField(m,f,null,true);
    }
  }
  function tick(m){
    if(m.ended)return;
    const now=current();
    simulateAiReady(m,now);
    if(m.phase==='awaiting_acceptance'){

      if(now>=m.phaseEndsAt)finishMatch(m,'match-acceptance-timeout');return;
    }
    if(m.phase==='connection_check'){
      // ONLY before Round 1. Do not reenter from any later phase.
      if(now>=m.phaseStartsAt+STARTUP_MIN_MS&&nowReady(m,now)){
        startPhase(m,'preparation',now);return;
      }
      if(now>=m.phaseEndsAt){
        for(const p of liveHumans(m))if(now-p.lastSeenAt>OFFLINE_MS){p.eliminated=true;p.forfeitedBeforeStart=true;emit(m,'startup_disconnected',{playerId:p.id},p);}
        if(!m.players.some(isLive)){finishMatch(m,'no-players-connected');return;}
        startPhase(m,'preparation',now);
      }
      return;
    }
    if(m.phase==='preparation'){
      // Never shorten the shared preparation clock, even with 8/8 Ready.
      if(now>=m.phaseEndsAt)startPhase(m,'prep_sync',now);
      return;
    }
    if(m.phase==='prep_sync'){
      // The full server-owned synchronization window prevents an early start.
      if(now>=m.phaseEndsAt)startPhase(m,'combat',now);
      return;
    }
    if(m.phase==='combat'){
      const done=m.battlefields.every(f=>f.status==='completed');
      if(done||now>=m.phaseEndsAt){
        if(!done)expireCombat(m);
        startPhase(m,isBoss(m.round)?'boss_results':'results',now);
      }return;
    }
    if(m.phase==='results'||m.phase==='boss_results'){
      if(now>=m.phaseEndsAt)startPhase(m,m.phase==='boss_results'?'special_shop':'preparation',now);
      return;
    }
    if(m.phase==='special_shop'&&now>=m.phaseEndsAt)startPhase(m,'preparation',now);
  }
  // Read-only coordinator status for diagnostics. Never includes tokens or
  // secret test-state; phase and acknowledgments are scoped per match.
  function serverAction(m){
    const participants=liveParticipants(m);
    const bots=participants.filter(isBot);
    const ready=participants.filter(p=>m.phaseReady.has(p.id)).length;
    const total=participants.length;
    const labels={
      awaiting_acceptance:'Waiting for match acceptance',
      connection_check:'Checking player connections',
      preparation:'Waiting for ready checks',
      prep_sync:'Awaiting pre-battle acknowledgments',
      combat:'Monitoring assigned battlefields',
      results:'Publishing battle results',
      boss_results:'Publishing boss results',
      special_shop:'Waiting for special-shop deadline'
    };
    const fields=m.battlefields||[];
    const checked=fields.reduce((sum,f)=>sum+Object.values(f.checks||{}).filter(Boolean).length,0);
    const expected=fields.reduce((sum,f)=>sum+f.playerIds.filter(id=>participants.some(p=>p.id===id&&!isBot(p))).length,0);
    return {code:m.phase,label:labels[m.phase]||'Updating match',
      round:m.round,phaseRevision:m.phaseRevision,readyCount:ready,readyExpected:total,
      aiReadyCount:bots.filter(p=>m.phaseReady.has(p.id)).length,aiReadyExpected:bots.length,
      checkedFields:checked,expectedFieldChecks:expected,
      completedFields:fields.filter(f=>f.status==='completed').length,totalFields:fields.length};
  }
  function publicState(m,base){
    if(m.protocol!==3)return base;
    return {...base,protocol:3,serverOwnedCountdowns:true,phase:m.phase,round:m.round,
      phaseRevision:m.phaseRevision,phaseStartsAt:m.phaseStartsAt,phaseEndsAt:m.phaseEndsAt,
      acceptDeadline:m.acceptDeadline,initialConnectionChecked:m.initialConnectionChecked,
      readyCount:liveParticipants(m).filter(p=>m.phaseReady.has(p.id)).length,battleRevision:m.battleRevision,serverAction:serverAction(m),
      battlefields:m.battlefields.map(f=>({id:f.id,round:f.round,phaseRevision:f.phaseRevision,
        kind:f.kind,playerIds:f.playerIds,checks:{...(f.checks||{})},ghostSourceId:f.ghostSourceId||null,ghostDice:f.ghostDice||[],status:f.status,winnerId:f.winnerId,
        unverified:f.unverified,reportedOutcomes:Object.fromEntries(Object.entries(f.reports).map(([id,r])=>[id,r.outcome]))})),
      playerBattleStatus:{...m.playerBattleStatus},
      players:base.players.map(bp=>{const p=m.players.find(v=>v.id===bp.id);return {...bp,
        accepted:!!p.accepted,connected:!!p.bot||(current()-p.lastSeenAt<=OFFLINE_MS),bot:!!p.bot,
        ready:m.phaseReady.has(p.id),forfeitedBeforeStart:!!p.forfeitedBeforeStart};})
    };
  }
  return {init,startPhase,accept,seen,ready,confirmBattlefield,battleReport,forfeit,tick,publicState,
    constants:{DURATION,OFFLINE_MS,STATUS}};
}
module.exports={create};