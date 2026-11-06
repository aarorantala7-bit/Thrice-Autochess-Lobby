const BASE=process.env.LOBBY_URL||'https://thrice-autochess-lobby-test.onrender.com';
async function req(path,body,expectError=false){
 const response=await fetch(BASE+path,{
  method:body?'POST':'GET',
  headers:body?{'Content-Type':'application/json'}:{},
  body:body?JSON.stringify(body):undefined,
  signal:AbortSignal.timeout(30000)
 });
 const text=await response.text();let data;
 try{data=JSON.parse(text)}catch{throw Error('Non-JSON response for '+path+': '+text.slice(0,180));}
 if(expectError){if(response.ok)throw Error('Unexpected success on '+path);return data;}
 if(!response.ok)throw Error(path+' '+response.status+': '+JSON.stringify(data));
 return data;
}
function assert(value,msg){if(!value)throw Error(msg);}
async function readyServer(){
 for(let i=0;i<18;i++){
  try{const r=await req('/health');if(r.ok&&r.sharedActionState)return r;}
  catch(e){if(i===17)throw e;}
  await new Promise(resolve=>setTimeout(resolve,5000));
 }
 throw Error('Updated shared-action server not live.');
}
const checks=[];let a,b;
try{
 const health=await readyServer();checks.push('Updated public server healthy');
 a=await req('/api/create',{name:'TestHost',mode:'normal1v1',mmr:1000,rankTier:0});
 assert(/^\d{6}$/.test(a.code),'Six-digit friend code invalid');
 checks.push('Normal 1v1 friendly lobby created');
 b=await req('/api/join',{code:a.code,name:'TestGuest',mmr:1020,rankTier:0});
 assert(b.players.length===2,'Friend did not join lobby');
 await req('/api/join',{code:a.code,name:'Third',mmr:1100},true);
 checks.push('Exactly two players in friendly 1v1');
 await req('/api/ready',{code:a.code,token:a.token,ready:true});
 await req('/api/ready',{code:a.code,token:b.token,ready:true});
 const queued=await req('/api/queue',{code:a.code,token:a.token});
 assert(queued.queued&&queued.matchId,'Did not create match instance');
 const id=queued.matchId;
 checks.push('Created online match instance');
 let hostState=await req('/api/matchState',{matchId:id,token:a.token});
 let guestState=await req('/api/matchState',{matchId:id,token:b.token});
 assert(hostState.meId!==guestState.meId,'Separate players not identified');
 assert(hostState.state.players.length===2,'Wrong match roster');
 const bought=await req('/api/matchAction',{matchId:id,token:a.token,action:{type:'buy',kind:'flare'}});
 const host=bought.state.players.find(p=>p.id===hostState.meId);
 assert(host.dice.length===1&&host.gold===10,'Host purchase not stored');
 const item=host.dice[0];
 guestState=await req('/api/matchState',{matchId:id,token:b.token,since:guestState.state.revision});
 assert(guestState.state.players.find(p=>p.id===host.id).dice.some(x=>x.id===item.id),'Guest did not receive purchase');
 checks.push('Buy action replicated to opponent');
 await req('/api/matchAction',{matchId:id,token:b.token,action:{type:'move',dieId:item.id,zone:'board',index:2}},true);
 await req('/api/matchAction',{matchId:id,token:a.token,action:{type:'move',dieId:item.id,zone:'board',index:3}});
 guestState=await req('/api/matchState',{matchId:id,token:b.token});
 assert(guestState.state.players.find(p=>p.id===host.id).dice.some(d=>d.id===item.id&&d.zone==='board'&&d.index===3),'Move not replicated');
 checks.push('Moves replicated; opponent cannot manipulate your dice');
 await req('/api/matchAction',{matchId:id,token:a.token,action:{type:'sell',dieId:item.id}});
 guestState=await req('/api/matchState',{matchId:id,token:b.token});
 assert(!guestState.state.players.find(p=>p.id===host.id).dice.length,'Sell not replicated');
 checks.push('Sell action replicated');
 await req('/api/matchAction',{matchId:id,token:b.token,action:{type:'finish'}},true);
 const finish=await req('/api/matchAction',{matchId:id,token:a.token,action:{type:'finish'}});
 assert(finish.finished,'Match did not finish');
 const receipt=await req('/api/matchState',{matchId:id,token:b.token});
 assert(receipt.finished&&receipt.result.matchId===id,'Opponent cannot see completion receipt');
 checks.push('Instance deleted after match; both players receive result');
 await req('/api/matchAction',{matchId:id,token:a.token,action:{type:'buy',kind:'flare'}},true);
 checks.push('Finished match no longer accepts game actions');
 await req('/api/create',{name:'InvalidParty',mode:'ranked1v1',mmr:1000},true);
 checks.push('Ranked 1v1 friend lobby prohibited');
 const normalA=await req('/api/soloQueue',{name:'SoloNormalA',mode:'normal1v1',rankTier:0,mmr:1150});
 const normalB=await req('/api/soloQueue',{name:'SoloNormalB',mode:'normal1v1',rankTier:0,mmr:1200});
 const normalCheck=await req('/api/soloStatus',{ticketId:normalA.ticketId,token:normalA.token});
 assert(normalCheck.matchId===normalB.matchId&&!!normalCheck.matchId,'Normal 1v1 solo pairing failed');
 await req('/api/matchAction',{matchId:normalCheck.matchId,token:normalA.token,action:{type:'finish'}});
 checks.push('Normal 1v1 solo option works');

 const soloA=await req('/api/soloQueue',{name:'RankedOne',rankTier:2,mmr:1450});
 const soloB=await req('/api/soloQueue',{name:'RankedTwo',rankTier:2,mmr:1500});
 const checkA=await req('/api/soloStatus',{ticketId:soloA.ticketId,token:soloA.token});
 assert(checkA.matchId&&checkA.matchId===soloB.matchId,'Ranked solo matchmaking failed');
 checks.push('Ranked 1v1 solo players matched');
 const soloState=await req('/api/matchState',{matchId:checkA.matchId,token:soloA.token});
 await req('/api/matchAction',{matchId:checkA.matchId,token:soloA.token,action:{type:'finish'}});
 console.log('PASS '+checks.join(' | '));
}finally{
 if(b?.token)try{await req('/api/leave',{code:a.code,token:b.token});}catch{}
 if(a?.token)try{await req('/api/leave',{code:a.code,token:a.token});}catch{}
}
