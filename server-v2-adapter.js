'use strict';
/** Append this file as a require() AFTER the current Thrice-Autochess-Lobby
 * server.js wrappers. It changes new matches to protocol 3. It does not
 * claim server-authoritative dice combat or implement ranked RP persistence.
 */
module.exports = function installV2(ctx){
 const {getCreateMatch,setCreateMatch,getPublicMatch,setPublicMatch,
   getMatchResponse,setMatchResponse,getTakeAction,setTakeAction,
   getApi,setApi,matches,record,finishMatch,accessibleMatch,send,receive,err}=ctx;
 const manager=require('./coordinator-v2').create({record,finishMatch});
 const oldCreate=getCreateMatch();
 setCreateMatch(function(...args){const m=oldCreate(...args);manager.init(m);return m;});
 const oldPublic=getPublicMatch();
 setPublicMatch(function(m){return manager.publicState(m,oldPublic(m));});
 const oldResponse=getMatchResponse();
 setMatchResponse(function(id,token,since){
   const m=matches.get(String(id||'')),p=m?.players.find(p=>p.token===token);
   if(m?.protocol===3&&p)manager.seen(m,p);
   const data=oldResponse(id,token,since);
   if(m?.protocol===3){data.protocol=3;data.serverNow=Date.now();}
   return data;
 });
 const oldAction=getTakeAction();
 setTakeAction(function(m,p,a){
   if(m.protocol===3){
     if(a?.type==='phase'||a?.type==='finish')throw err('Match phases are server-controlled.',403);
     if(a?.type==='ready')throw err('Use matchReady for phase readiness.',409);
   }
   return oldAction(m,p,a);
 });
 const oldApi=getApi();
 setApi(async function(req,res,url){
   const route=url.pathname;
   if(req.method==='GET'&&route==='/api/syncCapabilities')
     return send(res,200,{protocol:3,serverNow:Date.now(),
       phases:['awaiting_acceptance','connection_check','preparation','prep_sync','combat','results','boss_results','special_shop'],
       initialConnectionCheckOnce:true,serverOwnedPhaseClock:true,
       serverTrackedBattleStatus:true,serverConfirmedLeave:true,authoritativeCombatSimulation:false,
       battleStatusPollingMs:1000,clientBattleOutcomes:true,battlefieldAcknowledgments:true,matchDiagnosticsVersion:28});
   if(req.method!=='POST'||!['/api/matchAccept','/api/matchReady','/api/matchBattleCheck','/api/matchBattleState','/api/matchLeave'].includes(route))
     return oldApi(req,res,url);
   const d=await receive(req);
   const {m,p}=accessibleMatch(d.matchId,d.token);
   if(m.protocol!==3)throw err('Match protocol 3 required.',409);
   try{
     if(route==='/api/matchAccept')manager.accept(m,p);
     else if(route==='/api/matchReady')manager.ready(m,p,d);
     else if(route==='/api/matchBattleCheck')manager.confirmBattlefield(m,p,d);
     else if(route==='/api/matchLeave'){
       const result=manager.forfeit(m,p);
       return send(res,200,{ok:true,forfeited:true,already:result.already,matchId:m.id,serverNow:Date.now()});
     } else manager.battleReport(m,p,d);
   }catch(error){throw err(error.message,409);}
   const response=getMatchResponse()(m.id,p.token,d.since||0);
   return send(res,200,response);
 });
 const timer=setInterval(()=>{
   for(const m of [...matches.values()])if(m.protocol===3)manager.tick(m);
 },250);
 timer.unref?.();
 return manager;
};