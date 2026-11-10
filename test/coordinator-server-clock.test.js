'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{create}=require('../coordinator-v2');
function h(){
 let t=100000;const events=[];
 const ctrl=create({clock:()=>t,record:(m,p,type,detail)=>events.push({type,detail}),finishMatch:(m,r)=>{m.ended=true;m.endReason=r}});
 const m={id:'clock-test',round:1,phase:'',mode:'normal1v1',players:[{id:'a',token:'a'},{id:'b',token:'b'}]};ctrl.init(m);
 const next=ms=>{t+=ms;ctrl.tick(m)};const ready=()=>{for(const p of m.players)ctrl.ready(m,p,{phase:m.phase,round:m.round,phaseRevision:m.phaseRevision})};
 for(const p of m.players)ctrl.accept(m,p);next(1001);
 return {ctrl,m,next,ready,events};
}
test('protocol 3 server sends stable countdown deadline with authority flag',()=>{
 const a=h();let s=a.ctrl.publicState(a.m,{players:a.m.players.map(p=>({id:p.id}))});
 assert.equal(s.serverOwnedCountdowns,true);assert.equal(s.phase,'preparation');
 const deadline=s.phaseEndsAt,revision=s.phaseRevision;a.next(2000);
 s=a.ctrl.publicState(a.m,{players:a.m.players.map(p=>({id:p.id}))});
 assert.equal(s.phaseEndsAt,deadline);assert.equal(s.phaseRevision,revision);
});
test('server deadlines handle normal and boss->special_shop without repeating startup freeze',()=>{
 const a=h();for(let r=1;r<=4;r++){
   a.ready();a.next(a.m.phaseEndsAt-(a.m.phaseStartsAt)+(r===1?1:1)); // Countdown not bypassed by Ready
   a.ready();a.next(12001);a.next(35001);a.next(10001);
 }
 a.ready();a.next(35001);a.ready();a.next(12001);assert.equal(a.m.round,5);a.next(35001);assert.equal(a.m.phase,'boss_results');
 a.next(10001);assert.equal(a.m.phase,'special_shop');a.next(20001);
 assert.equal(a.m.phase,'preparation');assert.equal(a.m.round,6);
 assert.equal(a.events.filter(e=>e.type==='phase_start'&&e.detail.phase==='connection_check').length,1);
});
