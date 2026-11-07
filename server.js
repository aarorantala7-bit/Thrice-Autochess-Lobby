'use strict';
// Thrice Autochess online lobby prototype: shared party presence, not synchronized battles.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const port=Number(process.env.PORT)||8765;
const root=path.join(__dirname,'public');
const rooms=new Map();

const matches=new Map();
const completedMatches=new Map();
const soloTickets=new Map();
const DICE_COSTS=Object.freeze({pebble:2,flare:2,tide:2,bolt:2,snowpea:2,spark:2,copper:2,emberseed:2});
const MATCH_TTL_MS=60*60*1000;
const RESULT_TTL_MS=2*60*1000;
const MAX_EVENTS=160;
const safeSince=n=>clamp(n,0,1000000000,0);
function createMatch(players,mode,roomCode=''){
  const id=crypto.randomBytes(12).toString('hex');
  const match={
    id,mode,roomCode,phase:'preparation',round:1,createdAt:Date.now(),
    updatedAt:Date.now(),revision:0,events:[],ended:false,
    players:players.map(p=>({
      id:p.id,token:p.token,name:p.name,rankTier:p.rankTier,mmr:p.mmr,
      gold:12,ready:false,eliminated:false,dice:[],lastEmoteAt:0
    }))
  };
  matches.set(id,match);return match;
}
function accessibleMatch(id,token){
  const m=matches.get(String(id||''));
  if(!m)throw err('Match ended or expired.',404);
  const p=m.players.find(p=>p.token===token);
  if(!p)throw err('Not a participant in this match.',403);
  return {m,p};
}
function publicMatch(m){
  return {
    id:m.id,mode:m.mode,phase:m.phase,round:m.round,revision:m.revision,
    players:m.players.map(p=>({
      id:p.id,name:p.name,gold:p.gold,ready:p.ready,eliminated:p.eliminated,
      dice:p.dice.map(d=>({id:d.id,kind:d.kind,zone:d.zone,index:d.index,price:d.price}))
    }))
  };
}
function record(m,player,type,detail){
  const event={revision:++m.revision,at:Date.now(),playerId:player?.id||null,type,detail};
  m.events.push(event);if(m.events.length>MAX_EVENTS)m.events.shift();
  m.updatedAt=Date.now();return event;
}
function shareMatch(m,since=0){
  return {finished:false,state:publicMatch(m),events:m.events.filter(e=>e.revision>safeSince(since))};
}
function finishMatch(m,reason,winnerId=null){
  if(!matches.has(m.id))return;
  record(m,null,'match_end',{reason,winnerId});
  const summary={
    matchId:m.id,mode:m.mode,reason,winnerId,finishedAt:Date.now(),
    players:m.players.map(p=>({id:p.id,name:p.name,eliminated:p.eliminated})),
    lastRevision:m.revision
  };
  // Active instance is deleted immediately; only a small, expiring completion receipt remains.
  matches.delete(m.id);
  completedMatches.set(m.id,{summary,expiresAt:Date.now()+RESULT_TTL_MS,
    tokens:new Set(m.players.map(p=>p.token))});
  if(m.roomCode){
    const r=rooms.get(m.roomCode);
    if(r?.matchId===m.id){
      r.matchId=null;r.queued=false;r.players.forEach(p=>p.ready=false);
    }
  }
  for(const [id,t] of soloTickets)if(t.matchId===m.id)soloTickets.delete(id);
}
function assertPreparation(m){
  if(m.phase!=='preparation')throw err('Dice changes are allowed only during preparation.');
}
function takeAction(m,p,a){
  if(p.eliminated)throw err('Eliminated players cannot act.');
  const type=String(a.type||'');
  if(type==='buy'){
    assertPreparation(m);
    const kind=String(a.kind||'').toLowerCase();
    const cost=DICE_COSTS[kind];
    if(!cost)throw err('Unknown test die.');
    if(p.gold<cost)throw err('Not enough gold.');
    const occupied=new Set(p.dice.filter(d=>d.zone==='bench').map(d=>d.index));
    let index=-1;for(let i=0;i<8;i++)if(!occupied.has(i)){index=i;break;}
    if(index<0)throw err('Bench full.');
    const die={id:crypto.randomUUID(),kind,zone:'bench',index,price:cost};
    p.gold-=cost;p.dice.push(die);
    record(m,p,'buy',{die:{...die}});return;
  }
  if(type==='move'){
    assertPreparation(m);
    const die=p.dice.find(d=>d.id===a.dieId);
    if(!die)throw err('You can only move your own dice.');
    const zone=a.zone;
    if(zone!=='bench'&&zone!=='board')throw err('Invalid destination.');
    const index=clamp(a.index,-1,20,-1);
    if(index<0||index>=(zone==='bench'?8:21))throw err('Invalid board slot.');
    const old={zone:die.zone,index:die.index};
    if(old.zone===zone&&old.index===index)return;
    const occupying=p.dice.find(d=>d.zone===zone&&d.index===index&&d.id!==die.id);
    if(occupying){occupying.zone=old.zone;occupying.index=old.index;}
    die.zone=zone;die.index=index;
    record(m,p,'move',{dieId:die.id,zone,index,swapId:occupying?.id||null});return;
  }
  if(type==='sell'){
    assertPreparation(m);
    const i=p.dice.findIndex(d=>d.id===a.dieId);
    if(i<0)throw err('You can only sell your own dice.');
    const [d]=p.dice.splice(i,1);
    const refund=Math.ceil(d.price/2);p.gold+=refund;
    record(m,p,'sell',{dieId:d.id,refund});return;
  }
  if(type==='ready'){
    p.ready=!!a.ready;record(m,p,'ready',{ready:p.ready});return;
  }
  if(type==='emote'){
    const emote=String(a.emote||'');
    if(!/^[a-z0-9_-]{1,24}$/i.test(emote))throw err('Invalid emote.');
    if(Date.now()-p.lastEmoteAt<3000)throw err('Emote cooldown active.');
    p.lastEmoteAt=Date.now();record(m,p,'emote',{emote});return;
  }
  if(type==='forfeit'){
    p.eliminated=true;record(m,p,'forfeit',{});
    const survivors=m.players.filter(x=>!x.eliminated);
    if(survivors.length<=1)finishMatch(m,'last-player-standing',survivors[0]?.id||null);
    return;
  }
  if(type==='phase'){
    if(m.players[0].id!==p.id)throw err('Only the test host may change the phase.',403);
    if(!['preparation','combat','results'].includes(a.phase))throw err('Invalid phase.');
    m.phase=a.phase;
    if(a.phase==='preparation'&&m.round<100)m.round++;
    record(m,p,'phase',{phase:m.phase,round:m.round});return;
  }
  if(type==='finish'){
    if(m.players[0].id!==p.id)throw err('Only the test host may end the test instance.',403);
    finishMatch(m,'host-ended-test');return;
  }
  throw err('Unknown or unsupported match action.');
}
function matchResponse(id,token,since){
  const done=completedMatches.get(String(id||''));
  if(done){
    if(!done.tokens.has(token))throw err('Not a participant in this match.',403);
    return {finished:true,result:done.summary,events:[]};
  }
  const {m,p}=accessibleMatch(id,token);
  return {...shareMatch(m,since),meId:p.id};
}
function startSolo(p){
  const id=crypto.randomUUID();
  const ticket={id,token:p.token,mode:p.mode,player:p,createdAt:Date.now(),matchId:null};
  let opponent=null;
  for(const t of soloTickets.values()){
    if(!t.matchId&&t.mode===p.mode&&Math.abs(t.player.mmr-p.mmr)<=400){opponent=t;break;}
  }
  soloTickets.set(id,ticket);
  if(opponent){
    const m=createMatch([opponent.player,p],p.mode);
    opponent.matchId=m.id;ticket.matchId=m.id;
  }
  return {ticketId:id,token:ticket.token,matchId:ticket.matchId,waiting:!ticket.matchId};
}

const MODES=new Set(['normalTournament','rankedTournament','normal1v1']);
const MAX_BODY=5000;
const safeName=x=>String(x||'Player').trim().replace(/[^\p{L}\p{N} ]/gu,'').slice(0,24)||'Player';
const clamp=(x,lo,hi,def)=>Number.isFinite(Number(x))?Math.max(lo,Math.min(hi,Math.floor(Number(x)))):def;
const send=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});res.end(JSON.stringify(obj));};
const publicPlayer=p=>({id:p.id,name:p.name,ready:p.ready,rankTier:p.rankTier,mmr:p.mmr});
const publicRoom=r=>({code:r.code,mode:r.mode,queued:r.queued,matchId:r.matchId||null,players:r.players.map(publicPlayer),created:r.created});
const err=(message,status=400)=>Object.assign(new Error(message),{status});
function room(code){const r=rooms.get(String(code||''));if(!r)throw err('Lobby not found or expired.',404);r.lastActive=Date.now();return r;}
function currentPlayer(r,token){const p=r.players.find(p=>p.token===token);if(!p)throw err('You are not a member of this lobby.',403);return p;}
setInterval(()=>{
  const now=Date.now();
  for(const m of matches.values())if(now-m.updatedAt>MATCH_TTL_MS)finishMatch(m,'inactive-timeout');
  for(const [id,f] of completedMatches)if(now>f.expiresAt)completedMatches.delete(id);
  for(const [id,t] of soloTickets)if(now-t.createdAt>10*60*1000&&!t.matchId)soloTickets.delete(id);
  for(const [code,r] of rooms)if(now-r.lastActive>2*60*60*1000&&!r.matchId)rooms.delete(code);
},60*1000).unref();
async function receive(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>MAX_BODY)throw err('Request too long.',413);}try{return JSON.parse(body||'{}');}catch{throw err('Invalid request.');}}
async function api(req,res,url){
 if(req.method==='GET'&&url.pathname.startsWith('/api/lobby/'))return send(res,200,publicRoom(room(url.pathname.split('/').pop())));
 if(req.method!=='POST')return send(res,405,{error:'Use POST.'});
 const d=await receive(req),a=url.pathname.slice('/api/'.length);
 
 if(a==='matchState')return send(res,200,matchResponse(d.matchId,d.token,d.since||0));
 if(a==='matchAction'){
   const {m,p}=accessibleMatch(d.matchId,d.token);
   takeAction(m,p,d.action||{});
   return send(res,200,matchResponse(d.matchId,d.token,d.since||0));
 }
 if(a==='soloQueue'){
   const p={id:crypto.randomUUID(),token:crypto.randomBytes(24).toString('hex'),
     name:safeName(d.name),mode:d.mode==='normal1v1'?'normal1v1':'ranked1v1',rankTier:clamp(d.rankTier,0,5,0),mmr:clamp(d.mmr,100,5000,1000)};
   return send(res,200,startSolo(p));
 }
 if(a==='soloStatus'){
   const t=soloTickets.get(String(d.ticketId||''));
   if(!t||t.token!==d.token)throw err('Solo queue ticket expired.',404);
   return send(res,200,{waiting:!t.matchId,matchId:t.matchId,token:t.token});
 }
 if(a==='soloCancel'){
   const t=soloTickets.get(String(d.ticketId||''));
   if(!t||t.token!==d.token)throw err('Solo queue ticket expired.',404);
   if(t.matchId)throw err('Match already found. Use match forfeit to leave.');
   soloTickets.delete(t.id);return send(res,200,{cancelled:true});
 }
 
 if(a==='create'){
  if(!MODES.has(d.mode))throw err('Choose Normal 1v1 or a tournament mode.');
  let code;do{code=String(crypto.randomInt(100000,1000000));}while(rooms.has(code));
  const p={id:crypto.randomUUID(),token:crypto.randomBytes(24).toString('hex'),name:safeName(d.name),ready:false,mmr:clamp(d.mmr,100,5000,1000),rankTier:clamp(d.rankTier,0,5,0)};
  const r={code,mode:d.mode,queued:false,players:[p],created:Date.now(),lastActive:Date.now()};
  rooms.set(code,r);
  return send(res,200,{...publicRoom(r),meId:p.id,token:p.token});
 }
 const r=room(d.code);
 if(a==='join'){
  if(r.queued)throw err('This lobby is already in queue.');
  if(r.players.length>=(r.mode==='normal1v1'?2:8))throw err('This lobby is full.');
  const tier=clamp(d.rankTier,0,5,0);
  if(r.mode==='rankedTournament'&&r.players.some(p=>Math.abs(p.rankTier-tier)>1))throw err('Ranked party members must be within one rank tier.');
  const p={id:crypto.randomUUID(),token:crypto.randomBytes(24).toString('hex'),name:safeName(d.name),ready:false,mmr:clamp(d.mmr,100,5000,1000),rankTier:tier};
  r.players.push(p);
  return send(res,200,{...publicRoom(r),meId:p.id,token:p.token});
 }
 const p=currentPlayer(r,d.token),host=r.players[0].id===p.id;
 if(a==='ready'){p.ready=!!d.ready;return send(res,200,publicRoom(r));}
 if(a==='queue'){
  if(!host)throw err('Only the lobby host can start matchmaking.',403);
  if(r.mode==='normal1v1'&&r.players.length!==2)throw err('Normal 1v1 requires two players.');
  if(r.players.length>1&&!r.players.every(p=>p.ready))throw err('All players must be Ready.');
  r.queued=true;
  const m=createMatch(r.players,r.mode,r.code);
  r.matchId=m.id;
  return send(res,200,publicRoom(r));
 }
 if(a==='cancel'){
  if(!host)throw err('Only the lobby host can cancel matchmaking.',403);
  if(r.matchId){
    const m=matches.get(r.matchId);if(m)finishMatch(m,'queue-cancelled');
    r.matchId=null;
  }
  r.queued=false;
  return send(res,200,publicRoom(r));
 }
 if(a==='kick'){
  if(!host)throw err('Only the lobby host can remove a member.',403);
  if(d.kickId===p.id)throw err('Host cannot kick themselves.');
  r.players=r.players.filter(member=>member.id!==d.kickId);
  return send(res,200,publicRoom(r));
 }
 if(a==='leave'){
  if(r.matchId){
    const m=matches.get(r.matchId);
    const inMatch=m?.players.find(member=>member.id===p.id);
    if(m&&inMatch&&!inMatch.eliminated)takeAction(m,inMatch,{type:'forfeit'});
  }
  r.players=r.players.filter(member=>member.id!==p.id);
  if(!r.players.length)rooms.delete(r.code);
  else if(host){r.queued=false;r.players.forEach(member=>member.ready=false);}
  return send(res,200,{ok:true});
 }
 return send(res,404,{error:'Unknown API endpoint.'});
}
http.createServer(async(req,res)=>{
 try{
  if(req.method==='OPTIONS')return send(res,204,{});
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{ok:true,service:'Thrice Autochess shared action server',sharedActionState:true,activeMatchCount:matches.size,battlesSynchronized:false});
  if(url.pathname.startsWith('/api/'))return await api(req,res,url);
  if(!['GET','HEAD'].includes(req.method))return send(res,405,{error:'Method not allowed.'});
  let requested;
  try{requested=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);}catch{throw err('Invalid URL.');}
  const abs=path.resolve(root,'.'+requested);
  if(!(abs===root||abs.startsWith(root+path.sep)))throw err('Forbidden.',403);
  const stat=fs.statSync(abs);if(!stat.isFile())throw err('Not found.',404);
  res.writeHead(200,{'Content-Type':path.extname(abs)==='.html'?'text/html; charset=utf-8':'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
  if(req.method==='HEAD')res.end();else fs.createReadStream(abs).pipe(res);
 }catch(e){send(res,e.status||404,{error:e.message||'Not found.'});}
}).listen(port,'0.0.0.0',()=>console.log('Thrice lobby test listening on port '+port));


// ===== Thrice Autochess v0.23.0 server-side phase synchronization =====
// Appended to existing server.js. Preserves existing lobby and test-action APIs.
const V230_SYNC_PROTOCOL=2;
const V230_ACCEPT_MS=15000;
const V230_SYNC_TIMEOUT_MS=20000;
const V230_PHASE_DURATIONS={preparation:45,combat:35,results:10};
const v230NativeCreateMatch=createMatch;
createMatch=function(players,mode,roomCode=''){
 const m=v230NativeCreateMatch(players,mode,roomCode);
 m.protocol=V230_SYNC_PROTOCOL;
 m.phase='awaiting_acceptance';m.phaseRevision=0;
 m.phaseStartsAt=0;m.phaseEndsAt=0;
 m.acceptDeadline=Date.now()+V230_ACCEPT_MS;
 m.phaseReady=new Set();
 for(const p of m.players){p.accepted=false;p.lastSeenAt=Date.now();}
 return m;
};
const v230NativePublicMatch=publicMatch;
publicMatch=function(m){const data=v230NativePublicMatch(m);
 if(m.protocol!==V230_SYNC_PROTOCOL)return data;
 return {...data,protocol:V230_SYNC_PROTOCOL,phaseRevision:m.phaseRevision,
  phaseStartsAt:m.phaseStartsAt,phaseEndsAt:m.phaseEndsAt,acceptDeadline:m.acceptDeadline,
  readyCount:m.phaseReady.size,
  players:data.players.map(p=>({...p,accepted:!!m.players.find(x=>x.id===p.id)?.accepted}))};
};
const v230NativeMatchResponse=matchResponse;
matchResponse=function(id,token,since){
 const m=matches.get(String(id||''));const p=m?.players.find(x=>x.token===token);
 if(p)p.lastSeenAt=Date.now();
 return {...v230NativeMatchResponse(id,token,since),serverNow:Date.now(),protocol:V230_SYNC_PROTOCOL};
};
const v230NativeTakeAction=takeAction;
takeAction=function(m,p,a){if(m.protocol===V230_SYNC_PROTOCOL&&a?.type==='phase')throw err('Phase changes are server-controlled in v0.23.',403);
 return v230NativeTakeAction(m,p,a);};
function v230PhaseChange(m,next){
 if(!matches.has(m.id))return;
 const now=Date.now();m.phase=next;if(next==='preparation'&&m.phaseRevision>0)m.round++;
 m.phaseRevision++;m.phaseStartsAt=now+1500;
 m.phaseEndsAt=m.phaseStartsAt+(next==='preparation'&&m.round>1?35:V230_PHASE_DURATIONS[next])*1000;
 m.phaseReady.clear();m.players.forEach(p=>p.ready=false);
 record(m,null,'phase_start',{phase:next,round:m.round,phaseRevision:m.phaseRevision,phaseStartsAt:m.phaseStartsAt,phaseEndsAt:m.phaseEndsAt});
}
function v230BeginAfterAccept(m){if(m.phase!=='awaiting_acceptance')return;
 if(m.players.some(p=>!p.accepted))return;
 v230PhaseChange(m,'preparation');
}
function v230TryPhaseAdvance(m,now=Date.now()){
 if(m.protocol!==V230_SYNC_PROTOCOL||!matches.has(m.id))return;
 if(m.phase==='awaiting_acceptance'){
  if(now>=m.acceptDeadline)finishMatch(m,'acceptance-timeout');
  return;
 }
 const live=m.players.filter(p=>!p.eliminated),allReady=live.every(p=>m.phaseReady.has(p.id));
 if(allReady&&now>=m.phaseStartsAt){
  const next=m.phase==='preparation'?'combat':m.phase==='combat'?'results':'preparation';
  v230PhaseChange(m,next);return;
 }
 if(now>=m.phaseEndsAt+V230_SYNC_TIMEOUT_MS){
  finishMatch(m,'phase-sync-timeout');
 }
}
const v230ServerApi=api;
api=async function(req,res,url){
 if(req.method==='GET'&&url.pathname==='/api/syncCapabilities')
  return send(res,200,{protocol:V230_SYNC_PROTOCOL,serverNow:Date.now(),phases:['awaiting_acceptance','preparation','combat','results'],battleStateSynchronized:false});
 if(url.pathname==='/api/matchAccept'||url.pathname==='/api/matchReady'){
  if(req.method!=='POST')return send(res,405,{error:'Use POST.'});
  const d=await receive(req),{m,p}=accessibleMatch(d.matchId,d.token);
  if(m.protocol!==V230_SYNC_PROTOCOL)throw err('Unsupported match protocol.',409);
  p.lastSeenAt=Date.now();
  if(url.pathname==='/api/matchAccept'){
   if(m.phase!=='awaiting_acceptance'&&!p.accepted)throw err('Acceptance is closed.',409);
   if(m.phase==='awaiting_acceptance'&&Date.now()>m.acceptDeadline)throw err('Acceptance expired.',410);
   if(!p.accepted){p.accepted=true;record(m,p,'accept',{});v230BeginAfterAccept(m);}
   return send(res,200,matchResponse(m.id,p.token,d.since||0));
  }
  if(!p.accepted)throw err('Accept your match first.',403);
  if(m.phase==='awaiting_acceptance')throw err('Waiting for other players.',409);
  if(d.phase!==m.phase||Number(d.round)!==m.round||Number(d.phaseRevision)!==m.phaseRevision)
   throw err('Phase already moved; fetch fresh match state.',409);
  if(!m.phaseReady.has(p.id)){m.phaseReady.add(p.id);record(m,p,'phase_ready',{phase:m.phase,round:m.round,revision:m.phaseRevision});}
  v230TryPhaseAdvance(m);
  return send(res,200,matchResponse(m.id,p.token,d.since||0));
 }
 return v230ServerApi(req,res,url);
};
setInterval(()=>{const now=Date.now();for(const m of [...matches.values()])v230TryPhaseAdvance(m,now);},500).unref();
