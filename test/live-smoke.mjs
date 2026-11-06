const BASE='https://thrice-autochess-lobby-test.onrender.com';
async function req(path,body){
 const response=await fetch(BASE+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 const obj=await response.json();if(!response.ok)throw Error(path+' '+response.status+' '+JSON.stringify(obj));return obj;
}
let host,guest;
try{
 let health;
 for(let i=0;i<5;i++){try{health=await req('/health');break;}catch(e){if(i===4)throw e;await new Promise(r=>setTimeout(r,10000));}}
 if(!health.ok)throw Error('Health check failed');
 host=await req('/api/create',{name:'TestHost',mode:'normalTournament',rankTier:0,mmr:1000});
 if(!/^\\d{6}$/.test(host.code))throw Error('Invalid lobby code');
 guest=await req('/api/join',{code:host.code,name:'TestGuest',rankTier:0,mmr:1000});
 if(guest.players.length!==2)throw Error('Joining failed');
 let state=await req('/api/lobby/'+host.code);
 if(state.players.length!==2)throw Error('Shared lobby state wrong');
 await req('/api/ready',{code:host.code,token:host.token,ready:true});
 state=await req('/api/ready',{code:host.code,token:guest.token,ready:true});
 if(!state.players.every(p=>p.ready))throw Error('Ready state wrong');
 state=await req('/api/queue',{code:host.code,token:host.token});
 if(!state.queued)throw Error('Queue failed');
 state=await req('/api/cancel',{code:host.code,token:host.token});
 if(state.queued)throw Error('Cancel failed');
 console.log('PASS public health, create lobby, six-digit code, join second player, shared state, readiness, queue, cancel');
}finally{
 if(guest)try{await req('/api/leave',{code:host.code,token:guest.token});}catch(e){}
 if(host)try{await req('/api/leave',{code:host.code,token:host.token});}catch(e){}
}
