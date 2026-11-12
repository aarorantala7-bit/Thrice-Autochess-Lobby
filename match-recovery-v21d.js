'use strict';
/** Server-owned 180-second rejoin grace and profile-scoped test match cleanup. */
module.exports=function installRecovery(ctx){
 const {getApi,setApi,getMatchResponse,setMatchResponse,getPublicMatch,setPublicMatch,matches,rooms,soloTickets,record,finishMatch,receive,send,err,verifyProfile,manager}=ctx;
 const OFFLINE_MS=8000,REJOIN_MS=180000,now=()=>Date.now();
 const liveHumans=m=>m.players.filter(p=>!p.bot&&!p.eliminated);
 function aiOnly(m){if(matches.has(m.id)&&!liveHumans(m).length){finishMatch(m,'ai-only-after-permanent-departure');return true;}return false;}
 function disconnect(m,p,at){
   if(p.bot||p.eliminated||p.rejoinDeadlineAt)return;
   p.connected=false;p.rejoinDeadlineAt=at+REJOIN_MS;
   record(m,p,'player_disconnected',{playerId:p.id,rejoinDeadlineAt:p.rejoinDeadlineAt,graceMs:REJOIN_MS});
 }
 function expire(m,p){
   if(!matches.has(m.id)||p.eliminated)return;
   record(m,p,'player_rejoin_expired',{playerId:p.id,deadline:p.rejoinDeadlineAt});
   p.rejoinDeadlineAt=0;
   if(m.protocol===3&&manager?.forfeit)manager.forfeit(m,p);
   else {p.eliminated=true;record(m,p,'player_permanently_left',{playerId:p.id});}
   aiOnly(m);
 }
 function sweep(){
   const time=now();
   for(const m of [...matches.values()]){
     if(!m.players||m.ended)continue;
     for(const p of m.players){
       if(p.bot||p.eliminated||!p.accepted||!p.lastSeenAt)continue;
       if(!p.rejoinDeadlineAt&&time-p.lastSeenAt>OFFLINE_MS)disconnect(m,p,p.lastSeenAt+OFFLINE_MS);
       if(p.rejoinDeadlineAt&&time>=p.rejoinDeadlineAt){expire(m,p);if(!matches.has(m.id))break;}
     }
     if(matches.has(m.id))aiOnly(m);
   }
 }
 const beforeResponse=getMatchResponse();
 setMatchResponse(function(id,token,since){
   const m=matches.get(String(id||'')),p=m?.players.find(p=>p.token===token);
   if(p&&!p.bot&&!p.eliminated){
     if(p.rejoinDeadlineAt&&now()>=p.rejoinDeadlineAt)expire(m,p);
     else if(p.rejoinDeadlineAt){
       const old=p.rejoinDeadlineAt;p.rejoinDeadlineAt=0;p.connected=true;
       record(m,p,'player_rejoined',{playerId:p.id,cancelledDeadline:old});
     }
   }
   return beforeResponse(id,token,since);
 });
 const beforePublic=getPublicMatch();
 setPublicMatch(function(m){
   const data=beforePublic(m),time=now();
   return {...data,players:data.players.map(sp=>{
     const p=m.players.find(x=>x.id===sp.id);
     return {...sp,rejoinDeadlineAt:p?.rejoinDeadlineAt||null,
       rejoinRemainingMs:p?.rejoinDeadlineAt?Math.max(0,p.rejoinDeadlineAt-time):null,
       permanentlyDeparted:!!p?.eliminated};
   })};
 });
 const beforeApi=getApi();
 setApi(async function(req,res,url){
   const route=url.pathname;
   if(req.method==='GET'&&route==='/api/rejoinCapabilities')
     return send(res,200,{version:1,serverNow:now(),serverOwnedRejoin:true,rejoinWindowMs:REJOIN_MS,disconnectThresholdMs:OFFLINE_MS,profileScopedTermination:true,aiOnlyAutoEnd:true});
   if(req.method==='POST'&&route==='/api/admin/forceTerminateMyMatches'){
     const d=await receive(req);
     if(!await verifyProfile(d.profileId,d.profileSecret))throw err('Profile credentials not verified.',403);
     const affected=[];
     for(const m of [...matches.values()]){
       if(!m.players.some(p=>p.profileId===d.profileId&&!p.bot))continue;
       affected.push(m.id);finishMatch(m,'admin-terminated-by-profile-owner');
     }
     let clearedTickets=0;
     for(const [key,t] of soloTickets)if(t.player?.profileId===d.profileId){soloTickets.delete(key);clearedTickets++;}
     for(const r of rooms.values())if(r.players?.some(p=>p.profileId===d.profileId)&&!r.matchId){
       r.queued=false;r.queuedAt=null;r.players.forEach(p=>p.ready=false);
     }
     return send(res,200,{ok:true,terminatedMatchIds:affected,clearedTickets,serverNow:now()});
   }
   if(req.method==='POST'&&(route==='/api/matchSuspend'||route==='/api/matchRejoin')){
     const d=await receive(req),m=matches.get(String(d.matchId||''));
     if(!m)throw err('Match ended or expired.',404);
     const p=m.players.find(x=>x.token===d.token);
     if(!p||p.bot||p.eliminated)throw err('Not an active human participant.',403);
     if(route==='/api/matchSuspend'){
       if(!p.rejoinDeadlineAt)disconnect(m,p,now());
       return send(res,200,{ok:true,matchId:m.id,rejoinDeadlineAt:p.rejoinDeadlineAt,serverNow:now()});
     }
     if(p.rejoinDeadlineAt&&now()>=p.rejoinDeadlineAt){expire(m,p);throw err('Rejoin time expired.',410);}
     return send(res,200,{ok:true,state:getMatchResponse()(m.id,p.token,0),serverNow:now()});
   }
   return beforeApi(req,res,url);
 });
 const timer=setInterval(sweep,1000);timer.unref?.();
 return {sweep,REJOIN_MS,finishIfAiOnly:aiOnly};
};