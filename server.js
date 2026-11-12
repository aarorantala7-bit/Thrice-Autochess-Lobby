'use strict';
// Thrice Autochess online lobby prototype: shared party presence, not synchronized battles.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const port=Number(process.env.PORT)||8765;
const root=path.join(__dirname,'public');
// Thrice v0.25.4.31 - permanent profile registry backed by Render PostgreSQL.
const v25430Identity=require('./profile-identity-store-pg').create({connectionString:process.env.DATABASE_URL});
const v25430ProfileRequired=new Set(['/api/create','/api/join','/api/soloQueue','/api/queue','/api/ready']);

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
      id:p.id,token:p.token,profileId:p.profileId||null,name:p.name,rankTier:p.rankTier,mmr:p.mmr,
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
function currentPlayer(r,token,profileId){const p=r.players.find(p=>p.token===token);if(!p)throw err('You are not a member of this lobby.',403);if(profileId&&p.profileId&&profileId!==p.profileId)throw err('Lobby token belongs to a different profile ID.',403);return p;}
setInterval(()=>{
  const now=Date.now();
  for(const m of matches.values())if(now-m.updatedAt>MATCH_TTL_MS)finishMatch(m,'inactive-timeout');
  for(const [id,f] of completedMatches)if(now>f.expiresAt)completedMatches.delete(id);
  for(const [id,t] of soloTickets)if(now-t.createdAt>10*60*1000&&!t.matchId)soloTickets.delete(id);
  for(const [code,r] of rooms)if(now-r.lastActive>2*60*60*1000&&!r.matchId)rooms.delete(code);
},60*1000).unref();
async function receive(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>MAX_BODY)throw err('Request too long.',413);}let d;try{d=JSON.parse(body||'{}');}catch{throw err('Invalid request.');}
 if(v25430ProfileRequired.has(new URL(req.url,'http://localhost').pathname)&&!(await v25430Identity.verify(d.profileId,d.profileSecret)))
  throw err('Profile ID is missing or not verified on this server. Register a profile before joining the queue.',403);
 return d;}
async function api(req,res,url){
 if(req.method==='POST'&&url.pathname==='/api/profileRegister'){
  const record=await v25430Identity.register();
  return send(res,200,{...record,serverNow:Date.now()});
 }
 if(req.method==='POST'&&url.pathname==='/api/profileVerify'){
  const d=await receive(req);const ok=await v25430Identity.verify(d.profileId,d.profileSecret);
  return send(res,ok?200:403,ok?{ok:true,profileId:d.profileId}:{error:'Unrecognized profile ID or credential'});
 }
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
   const p={id:crypto.randomUUID(),profileId:d.profileId,token:crypto.randomBytes(24).toString('hex'),
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
  const p={id:crypto.randomUUID(),profileId:d.profileId,token:crypto.randomBytes(24).toString('hex'),name:safeName(d.name),ready:false,mmr:clamp(d.mmr,100,5000,1000),rankTier:clamp(d.rankTier,0,5,0)};
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
  const p={id:crypto.randomUUID(),profileId:d.profileId,token:crypto.randomBytes(24).toString('hex'),name:safeName(d.name),ready:false,mmr:clamp(d.mmr,100,5000,1000),rankTier:tier};
  if(r.players.some(member=>member.profileId===d.profileId))throw err('This profile is already in the lobby.',409);
    r.players.push(p);
  return send(res,200,{...publicRoom(r),meId:p.id,token:p.token});
 }
 const p=currentPlayer(r,d.token,d.profileId),host=r.players[0].id===p.id;
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
  if(req.method==='GET'&&url.pathname==='/health'){
   try{if(!(await v25430Identity.health()))throw Error('Profile identity database unavailable');
    return send(res,200,{ok:true,service:'Thrice Autochess protocol-3 test server',protocol:3,profileDatabase:true,serverOwnedPhaseClock:true,activeMatchCount:matches.size});
   }catch{return send(res,503,{ok:false,error:'Profile identity database unavailable'});}
  }
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
 // Initial preparation is round 1; change handler increments rounds only later.
 v230PhaseChange(m,'preparation');
}
function v230TryPhaseAdvance(m,now=Date.now()){
 if(m.protocol!==V230_SYNC_PROTOCOL||!matches.has(m.id))return;
 if(m.phase==='awaiting_acceptance'){
  if(now>=m.acceptDeadline)finishMatch(m,'acceptance-timeout');
  return;
 }
 const live=m.players.filter(p=>!p.eliminated),allReady=live.every(p=>m.phaseReady.has(p.id));
 if(allReady&&now>=m.phaseEndsAt){
  const next=m.phase==='preparation'?'combat':m.phase==='combat'?'results':'preparation';
  v230PhaseChange(m,next);return;
 }
 // Never silently continue when a participant is out of sync. End a stalled test
 // instead of letting one device advance independently forever.
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

// ===== Thrice Autochess v0.23.0b: solo and party matchmaking =====
// Adds server-authoritative queue membership, party caps and matchmaking.
// Ranked 1v1 is strictly solo-only (no joining a friend's lobby).
// Normal Tournament may use local AI fillers in the gameplay prototype;
// Ranked Tournament waits for 8 real online queue participants.
const V230B_MATCHMAKER_VERSION = 1;
const V230B_PARTY_LIMITS = Object.freeze({normal1v1:2, ranked1v1:1, normalTournament:8, rankedTournament:4});
const V230B_GAME_SIZES = Object.freeze({normal1v1:2, ranked1v1:2, normalTournament:8, rankedTournament:8});
const V230B_WAIT_LIMIT_MS = 10*60*1000;
MODES.add('ranked1v1');

function v230bValidParty(r){
  const max=V230B_PARTY_LIMITS[r.mode];
  if(!max || !r.players.length || r.players.length>max)return false;
  if(r.mode==='rankedTournament'){
    const tiers=r.players.map(p=>p.rankTier);
    if(Math.max(...tiers)-Math.min(...tiers)>1)return false;
  }
  return true;
}
function v230bCompatible(group,next,mode){
  const all=group.flatMap(r=>r.players).concat(next.players);
  if(all.length>V230B_GAME_SIZES[mode])return false;
  if(mode.startsWith('ranked')){
    const tiers=all.map(p=>Number(p.rankTier)||0);
    if(Math.max(...tiers)-Math.min(...tiers)>1)return false;
  }
  if(mode.endsWith('1v1')){
    const mmrs=all.map(p=>Number(p.mmr)||1000);
    if(Math.max(...mmrs)-Math.min(...mmrs)>500)return false;
  }
  return true;
}
function v230bFindMatchGroup(mode){
  const all=[...rooms.values()].filter(r=>r.mode===mode&&r.queued&&!r.matchId&&v230bValidParty(r))
    .sort((a,b)=>(a.queuedAt||a.created)-(b.queuedAt||b.created));
  if(!all.length)return null;
  const seats=V230B_GAME_SIZES[mode];
  const min=mode==='normalTournament'?2:seats;
  const first=all[0];
  let best=null,bestCount=0;
  function search(index,selected,total){
    if(total>bestCount){best=selected;bestCount=total;}
    if(total>=seats)return;
    for(let i=index;i<all.length;i++){
      const candidate=all[i];
      if(!v230bCompatible(selected,candidate,mode))continue;
      search(i+1,[...selected,candidate],total+candidate.players.length);
      if(bestCount===seats)return;
    }
  }
  search(1,[first],first.players.length);
  if(bestCount===seats)return best;
  // Normal Tournament can backfill with local AI, but briefly wait for more real players.
  if(mode==='normalTournament'&&bestCount>=min&&Date.now()-(first.queuedAt||first.created)>=6000)return best;
  return null;
}
function v230bMatchQueue(mode){
  let count=0;
  while(count++<20){
    const group=v230bFindMatchGroup(mode);
    if(!group)break;
    const participants=group.flatMap(r=>r.players);
    const m=createMatch(participants,mode,group[0].code);
    m.roomCodes=group.map(r=>r.code);
    // Preserve the composition at matchmaking time: only 5-8 member friend parties are MMR protected.
    m.mmrFrozenIds=new Set(group.filter(r=>mode==='normalTournament'&&r.players.length>4)
      .flatMap(r=>r.players.map(p=>p.id)));
    m.partySizeByPlayerId=Object.fromEntries(group.flatMap(r=>r.players.map(p=>[p.id,r.players.length])));
    for(const r of group){r.matchId=m.id;r.queued=true;r.lastActive=Date.now();}
  }
}
const v230bOriginalPublicMatch=publicMatch;
publicMatch=function(m){
  const state=v230bOriginalPublicMatch(m);
  state.players=state.players.map(p=>({...p,
    mmrFrozen:!!m.mmrFrozenIds?.has(p.id),
    partySizeAtQueue:m.partySizeByPlayerId?.[p.id]||1
  }));
  return state;
};
const v230bOriginalFinishMatch=finishMatch;
finishMatch=function(m,...args){
  const codes=m?.roomCodes||[];
  const result=v230bOriginalFinishMatch(m,...args);
  for(const code of codes){const r=rooms.get(code);
    if(r?.matchId===m.id){r.matchId=null;r.queued=false;r.queuedAt=null;r.players.forEach(p=>p.ready=false);}
  }
  return result;
};
const v230bOriginalApi=api;
api=async function(req,res,url){
  const pathname=url.pathname;
  if(req.method==='GET'&&pathname==='/api/matchmakerCapabilities')
    return send(res,200,{version:V230B_MATCHMAKER_VERSION,protocol:V230_SYNC_PROTOCOL,
      partyLimits:V230B_PARTY_LIMITS,ranked1v1SoloOnly:true,
      normalTournamentBotFill:true,normalTournamentMmrProtectionPartySize:5,rankedTournamentPlayers:8});
  if(req.method==='GET'&&pathname.startsWith('/api/lobby/')){
    const r=room(pathname.split('/').pop());
    return send(res,200,{...publicRoom(r),searching:!!r.queued&&!r.matchId,
      requiredPlayers:V230B_GAME_SIZES[r.mode],currentPartySize:r.players.length});
  }
  if(req.method!=='POST'||!['join','queue','cancel','leave','kick','ready'].includes(pathname.slice(5)))
    return v230bOriginalApi(req,res,url);
  const d=await receive(req),action=pathname.slice(5),r=room(d.code);
  if(action==='join'){
    if(r.queued)throw err('This party is already searching for a match.');
    if(r.mode==='ranked1v1')throw err('Ranked 1v1 is solo queue only. Friend invitations are disabled.',403);
    const max=V230B_PARTY_LIMITS[r.mode]||1;
    if(r.players.length>=max)throw err(r.mode==='rankedTournament'?'Ranked Tournament parties allow you plus three friends (4 total).':'This party is full.');
    const tier=clamp(d.rankTier,0,5,0);
    if(r.mode==='rankedTournament'&&r.players.some(p=>Math.abs(p.rankTier-tier)>1))
      throw err('Ranked Tournament party members must be within one rank tier.');
    const p={id:crypto.randomUUID(),profileId:d.profileId,token:crypto.randomBytes(24).toString('hex'),
      name:safeName(d.name),ready:false,mmr:clamp(d.mmr,100,5000,1000),rankTier:tier};
    if(r.players.some(member=>member.profileId===d.profileId))throw err('This profile is already in the lobby.',409);
    r.players.push(p);r.lastActive=Date.now();
    return send(res,200,{...publicRoom(r),meId:p.id,token:p.token});
  }
  const p=currentPlayer(r,d.token,d.profileId),host=r.players[0]?.id===p.id;
  if(action==='ready'){
    if(r.queued)throw err('Cancel matchmaking before changing readiness.');
    p.ready=!!d.ready;return send(res,200,publicRoom(r));
  }
  if(action==='queue'){
    if(!host)throw err('Only the host can queue this party.',403);
    if(!v230bValidParty(r))throw err('Party size or rank difference is invalid for this mode.');
    if(r.queued)return send(res,200,{...publicRoom(r),waiting:!r.matchId});
    if(!r.players.length||!r.players.every(x=>x.ready))throw err('Every party member, including a solo host, must select Ready.');
    r.queued=true;r.queuedAt=Date.now();r.matchId=null;r.lastActive=Date.now();
    v230bMatchQueue(r.mode);
    return send(res,200,{...publicRoom(r),waiting:!r.matchId});
  }
  if(action==='cancel'){
    if(!host)throw err('Only the host can cancel a party search.',403);
    if(r.matchId){const m=matches.get(r.matchId);if(m)finishMatch(m,'queue-cancelled');}
    r.queued=false;r.queuedAt=null;r.matchId=null;
    r.players.forEach(x=>x.ready=false);
    return send(res,200,publicRoom(r));
  }
  if(action==='kick'){
    if(!host)throw err('Only the host can remove a member.',403);
    if(r.queued)throw err('Cancel matchmaking before changing party members.');
    if(d.kickId===p.id)throw err('Host cannot kick themselves.');
    r.players=r.players.filter(x=>x.id!==d.kickId);
    return send(res,200,publicRoom(r));
  }
  if(action==='leave'){
    if(r.matchId){const m=matches.get(r.matchId);const participant=m?.players.find(x=>x.id===p.id);
      if(m&&participant&&!participant.eliminated)takeAction(m,participant,{type:'forfeit'});
    }
    r.players=r.players.filter(x=>x.id!==p.id);
    if(r.queued&&!r.matchId){r.queued=false;r.queuedAt=null;r.players.forEach(x=>x.ready=false);}
    if(!r.players.length)rooms.delete(r.code);
    else if(host){r.queued=false;r.queuedAt=null;r.players.forEach(x=>x.ready=false);}
    return send(res,200,{ok:true});
  }
  throw err('Unsupported action.',404);
};
setInterval(()=>{const now=Date.now();for(const r of rooms.values()){
  if(r.queued&&!r.matchId&&now-(r.queuedAt||now)>V230B_WAIT_LIMIT_MS){r.queued=false;r.queuedAt=null;r.players.forEach(p=>p.ready=false);}
}
// Re-evaluate normal tournament queues after the short human matchmaking window.
v230bMatchQueue('normalTournament');
},1000).unref();

// ===== Thrice Autochess v0.23.0d: Normal queue AI backfill =====
// Append AFTER the v0.23.0 phase sync and v0.23.0b matchmaker patches.
// Ranked matches NEVER receive AI players. This is a test-match feature;
// server-managed acceptance/phase gates remain authoritative.
const V230D_BOT_FILL_VERSION=1;
const V230D_BOT_WAIT_MS=8000;
const V230D_BOT_NAMES=['FrostMoth','StoneBasilisk','EmberFox','NightOrchid','SilverSalmon',
 'IronBadger','DuskFalcon','Tidekeeper','CinderWisp','DawnSeeker','MossViper','CopperOwl',
 'MoonRaven','BrightStone','ShadowPip','AuroraKnight','StormHare','AshHollow'];
const V230D_BOT_BADGES=['','beta','vip_silver','vip_gold','vip_super'];
const v230dOriginalFindMatchGroup=v230bFindMatchGroup;
v230bFindMatchGroup=function(mode){
  const original=v230dOriginalFindMatchGroup(mode);
  if(mode!=='normal1v1'&&mode!=='normalTournament')return original;
  const seats=V230B_GAME_SIZES[mode];
  if(original&&original.reduce((n,r)=>n+r.players.length,0)>=seats)return original;
  const waiting=[...rooms.values()].filter(r=>r.mode===mode&&r.queued&&!r.matchId&&v230bValidParty(r))
    .sort((a,b)=>(a.queuedAt||a.created)-(b.queuedAt||b.created));
  if(!waiting.length)return null;
  // Give real players time to join. Only backfill after this shared queue deadline.
  if(Date.now()-(waiting[0].queuedAt||waiting[0].created)<V230D_BOT_WAIT_MS)return null;
  // The original matchmaker has already chosen the best compatible human group.
  return original||[waiting[0]];
};
const v230dOriginalCreateMatch=createMatch;
createMatch=function(players,mode,roomCode=''){
  const humans=players.filter(p=>!p.bot);
  const seats=(mode==='normal1v1'||mode==='normalTournament')?V230B_GAME_SIZES[mode]:players.length;
  const count=Math.max(0,seats-players.length);
  const bots=[];
  if((mode==='normal1v1'||mode==='normalTournament')&&count){
    const average=humans.length?Math.round(humans.reduce((n,p)=>n+(Number(p.mmr)||1000),0)/humans.length):1000;
    const names=[...V230D_BOT_NAMES].sort(()=>Math.random()-.5);
    const used=new Set(players.map(p=>p.name));
    for(let i=0;i<count;i++){
      let name=names[i%names.length];let suffix=2;
      while(used.has(name))name=names[i%names.length]+suffix++;
      used.add(name);
      bots.push({id:crypto.randomUUID(),token:crypto.randomBytes(24).toString('hex'),
        name,bot:true,botBadge:V230D_BOT_BADGES[crypto.randomInt(V230D_BOT_BADGES.length)],
        mmr:Math.max(100,average+crypto.randomInt(-150,151)),rankTier:humans[0]?.rankTier||0,
        ready:true});
    }
  }
  const all=players.concat(bots),m=v230dOriginalCreateMatch(all,mode,roomCode);
  for(const p of m.players){const src=all.find(x=>x.id===p.id);
    if(src?.bot){p.bot=true;p.botBadge=src.botBadge;p.accepted=true;p.ready=true;}
  }
  m.botFillCount=bots.length;
  m.humanPlayerCount=humans.length;
  return m;
};
const v230dOriginalPublicMatch=publicMatch;
publicMatch=function(m){
  const state=v230dOriginalPublicMatch(m);
  if(m.protocol!==V230_SYNC_PROTOCOL)return state;
  return {...state,botFillCount:m.botFillCount||0,
    players:state.players.map(p=>{const src=m.players.find(x=>x.id===p.id);
      return {...p,bot:!!src?.bot,botBadge:src?.bot?src.botBadge:null};})};
};
const v230dOriginalPhaseChange=v230PhaseChange;
v230PhaseChange=function(m,next){
  v230dOriginalPhaseChange(m,next);
  // The phase gate waits for everyone. Bots must be ready each new phase,
  // so real players are never blocked waiting for an AI client that cannot connect.
  if(m.protocol===V230_SYNC_PROTOCOL&&matches.has(m.id)){
    for(const p of m.players)if(p.bot){p.ready=true;m.phaseReady.add(p.id);}
  }
};
const v230dOriginalApi=api;
api=async function(req,res,url){
  if(req.method==='GET'&&url.pathname==='/api/botMatchmakingCapabilities')
    return send(res,200,{version:V230D_BOT_FILL_VERSION,waitMs:V230D_BOT_WAIT_MS,
      allowedModes:['normal1v1','normalTournament'],rankedBots:false,
      botsAutoAccept:true,botsAutoReady:true});
  return v230dOriginalApi(req,res,url);
};
// The earlier 0.23.0b periodic matcher only checked Normal Tournament.
// A lone Normal 1v1 queue needs its own periodic check after the bot wait window.
setInterval(()=>v230bMatchQueue('normal1v1'),1000).unref();

// ===== Thrice Autochess v0.23.0e: atomic pre-match decline =====
// Append AFTER v0.23.0, v0.23.0b, and v0.23.0d server patches.
// Declining a match removes the declining party from matchmaking; other parties
// resume searching. No pre-match decline is counted as a forfeit or ranked result.
const V230E_DECLINE_VERSION=1;
const v230ePreviousApi=api;
api=async function(req,res,url){
 if(req.method==='GET'&&url.pathname==='/api/declineCapabilities')
   return send(res,200,{version:V230E_DECLINE_VERSION,preMatchDecline:true,stopsQueue:true,othersRemainQueued:true});
 if(url.pathname!=='/api/matchDecline')return v230ePreviousApi(req,res,url);
 if(req.method!=='POST')return send(res,405,{error:'Use POST.'});
 const d=await receive(req);
 const {m,p}=accessibleMatch(d.matchId,d.token);
 if(m.protocol!==V230_SYNC_PROTOCOL)throw err('Unsupported match protocol.',409);
 if(m.phase!=='awaiting_acceptance')throw err('This match already started; use the in-game Forfeit button.',409);
 const codes=(m.roomCodes?.length?m.roomCodes:[m.roomCode]).filter(Boolean);
 const decliningCode=codes.find(code=>rooms.get(code)?.players.some(member=>member.id===p.id&&member.token===d.token));
 if(!decliningCode)throw err('Your queue party was not found.',409);
 const decliningPlayerIds=rooms.get(decliningCode).players.map(member=>member.id);
 const keepQueued=codes.filter(code=>code!==decliningCode)
  .map(code=>rooms.get(code)).filter(r=>r?.matchId===m.id);
 finishMatch(m,'match-declined');
 const receipt=completedMatches.get(m.id);
 if(receipt?.summary)receipt.summary.decliningPlayerIds=decliningPlayerIds;
 // Other human parties never chose Decline; let them resume finding opponents.
 for(const r of keepQueued){
   if(!rooms.has(r.code)||r.matchId)continue;
   r.queued=true;r.queuedAt=Date.now();r.lastActive=Date.now();
   r.players.forEach(member=>member.ready=true);
 }
 return send(res,200,{ok:true,queued:false,matchId:null,code:decliningCode,reason:'match-declined'});
};


// ===== Thrice Autochess Multiplayer Coordinator v2 (protocol 3) =====
// The startup connection check belongs ONLY to the initial match handshake.
// After Round 1, preparation uses the short prep_sync barrier, not a one-minute wait.
// The old v0.23 coordinator remains in the file for historical compatibility;
// its tick skips protocol 3 instances. This integration affects new matches.
const v2Coordinator=require('./server-v2-adapter')({
 getCreateMatch:()=>createMatch,setCreateMatch:fn=>{createMatch=fn;},
 getPublicMatch:()=>publicMatch,setPublicMatch:fn=>{publicMatch=fn;},
 getMatchResponse:()=>matchResponse,setMatchResponse:fn=>{matchResponse=fn;},
 getTakeAction:()=>takeAction,setTakeAction:fn=>{takeAction=fn;},
 getApi:()=>api,setApi:fn=>{api=fn;},
 matches,record,finishMatch,accessibleMatch,send,receive,err
});


// ===== v00.30.00.21d: server-owned rejoin window and profile-scoped match recovery =====
// All deadlines and match deletions are determined on the server, never by device clocks.
const V21D_REJOIN_WINDOW_MS=180000;
const V21D_OFFLINE_MS=8000;
const v21dEarlierPublicMatch=publicMatch;
publicMatch=function(m){
  const value=v21dEarlierPublicMatch(m);
  if(m.protocol!==3)return value;
  return {...value,players:value.players.map(player=>{
    const p=m.players.find(x=>x.id===player.id);
    return {...player,rejoinDeadlineAt:p?.rejoinDeadlineAt||null,
      connectionState:p?.eliminated?'departed':p?.rejoinDeadlineAt?'rejoining':'connected'};
  })};
};
const v21dEarlierMatchResponse=matchResponse;
matchResponse=function(id,token,since){
  const m=matches.get(String(id||''));
  const p=m?.players.find(x=>x.token===token&&!x.eliminated&&!x.bot);
  if(p&&p.rejoinDeadlineAt){
    p.rejoinDeadlineAt=null;
    p.temporarilyAway=false;
    record(m,p,'player_rejoined',{});
  }
  return v21dEarlierMatchResponse(id,token,since);
};
const v21dEarlierApi=api;
api=async function(req,res,url){
  const route=url.pathname;
  if(route==='/api/admin/forceTerminateMyMatches'){
    if(req.method!=='POST')return send(res,405,{error:'Use POST.'});
    const d=await receive(req);
    if(!(await v25430Identity.verify(d.profileId,d.profileSecret)))
      throw err('Verified player identity required for match cleanup.',403);
    const terminated=[];
    for(const m of [...matches.values()]){
      if(!m.players.some(p=>p.profileId===d.profileId))continue;
      terminated.push(m.id);
      finishMatch(m,'admin-terminated');
      const receipt=completedMatches.get(m.id);
      if(receipt?.summary){
        receipt.summary.status='admin_terminated';
        receipt.summary.reason='admin-terminated';
      }
    }
    let clearedTickets=0,clearedQueues=0;
    for(const [id,t] of [...soloTickets]){
      if(t.player?.profileId===d.profileId){soloTickets.delete(id);clearedTickets++;}
    }
    for(const r of rooms.values()){
      if(!r.players.some(p=>p.profileId===d.profileId))continue;
      if(r.queued&&!r.matchId){r.queued=false;r.queuedAt=null;clearedQueues++;}
      if(r.matchId&&!matches.has(r.matchId)){r.matchId=null;r.queued=false;r.queuedAt=null;clearedQueues++;}
      r.players.forEach(p=>p.ready=false);
      r.lastActive=Date.now();
    }
    return send(res,200,{ok:true,status:'admin_terminated',terminatedMatchIds:terminated,
      clearedTickets,clearedQueues,activeMatchesRemainingForProfile:0,serverNow:Date.now(),
      historyReconciliation:'Mark local in_progress entries for this verified profile admin_terminated; preserve their diagnostic records.'});
  }
  if(route==='/api/matchPause'||route==='/api/matchRejoin'){
    if(req.method!=='POST')return send(res,405,{error:'Use POST.'});
    const d=await receive(req),{m,p}=accessibleMatch(d.matchId,d.token);
    if(m.protocol!==3||p.bot||p.eliminated)throw err('An active human protocol-3 match is required.',409);
    if(route==='/api/matchPause'){
      p.rejoinDeadlineAt=Date.now()+V21D_REJOIN_WINDOW_MS;
      p.lastSeenAt=Date.now()-V21D_OFFLINE_MS-1;
      p.connected=false;p.temporarilyAway=true;
      record(m,p,'player_temporarily_left',{rejoinDeadlineAt:p.rejoinDeadlineAt});
      return send(res,200,{ok:true,matchId:m.id,rejoinDeadlineAt:p.rejoinDeadlineAt,
        rejoinWindowMs:V21D_REJOIN_WINDOW_MS,serverNow:Date.now()});
    }
    v2Coordinator.seen(m,p);
    p.rejoinDeadlineAt=null;p.temporarilyAway=false;
    record(m,p,'player_rejoined',{});
    return send(res,200,matchResponse(m.id,p.token,d.since||0));
  }
  return v21dEarlierApi(req,res,url);
};
// Prevent the initial connection-check gate from forfeiting an accepted player
// while their server-owned rejoin window is still open.
const v21dOriginalTick=v2Coordinator.tick;
v2Coordinator.tick=function(m){
  if(m.protocol===3&&m.phase==='connection_check'&&m.phaseEndsAt<=Date.now()){
    const pending=m.players.filter(p=>!p.bot&&!p.eliminated&&p.accepted&&p.rejoinDeadlineAt>Date.now());
    if(pending.length)m.phaseEndsAt=Math.max(m.phaseEndsAt,...pending.map(p=>p.rejoinDeadlineAt));
  }
  return v21dOriginalTick(m);
};
setInterval(()=>{
  const now=Date.now();
  for(const m of [...matches.values()]){
    if(m.protocol!==3)continue;
    if(!m.players.some(p=>!p.bot&&!p.eliminated)){
      finishMatch(m,'ai-only-after-permanent-leave');continue;
    }
    for(const p of m.players){
      if(p.bot||p.eliminated||!p.accepted)continue;
      if(p.rejoinDeadlineAt&&now>=p.rejoinDeadlineAt){
        record(m,p,'rejoin_window_expired',{deadline:p.rejoinDeadlineAt});
        v2Coordinator.forfeit(m,p);
        if(matches.has(m.id)&&!m.players.some(x=>!x.bot&&!x.eliminated))
          finishMatch(m,'ai-only-after-permanent-leave');
        break;
      }
      if(!p.rejoinDeadlineAt&&now-p.lastSeenAt>V21D_OFFLINE_MS){
        p.rejoinDeadlineAt=now+V21D_REJOIN_WINDOW_MS;p.connected=false;
        record(m,p,'rejoin_window_started',{rejoinDeadlineAt:p.rejoinDeadlineAt});
      }
    }
  }
},500).unref();
