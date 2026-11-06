'use strict';
// Thrice Autochess online lobby prototype: shared party presence, not synchronized battles.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const port=Number(process.env.PORT)||8765;
const root=path.join(__dirname,'public');
const rooms=new Map();
const MODES=new Set(['normalTournament','rankedTournament']);
const MAX_BODY=5000;
const safeName=x=>String(x||'Player').trim().replace(/[^\p{L}\p{N} ]/gu,'').slice(0,24)||'Player';
const clamp=(x,lo,hi,def)=>Number.isFinite(Number(x))?Math.max(lo,Math.min(hi,Math.floor(Number(x)))):def;
const send=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});res.end(JSON.stringify(obj));};
const publicPlayer=p=>({id:p.id,name:p.name,ready:p.ready,rankTier:p.rankTier,mmr:p.mmr});
const publicRoom=r=>({code:r.code,mode:r.mode,queued:r.queued,players:r.players.map(publicPlayer),created:r.created});
const err=(message,status=400)=>Object.assign(new Error(message),{status});
function room(code){const r=rooms.get(String(code||''));if(!r)throw err('Lobby not found or expired.',404);r.lastActive=Date.now();return r;}
function currentPlayer(r,token){const p=r.players.find(p=>p.token===token);if(!p)throw err('You are not a member of this lobby.',403);return p;}
setInterval(()=>{const now=Date.now();for(const [code,r] of rooms)if(now-r.lastActive>2*60*60*1000)rooms.delete(code);},10*60*1000).unref();
async function receive(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>MAX_BODY)throw err('Request too long.',413);}try{return JSON.parse(body||'{}');}catch{throw err('Invalid request.');}}
async function api(req,res,url){
 if(req.method==='GET'&&url.pathname.startsWith('/api/lobby/'))return send(res,200,publicRoom(room(url.pathname.split('/').pop())));
 if(req.method!=='POST')return send(res,405,{error:'Use POST.'});
 const d=await receive(req),a=url.pathname.slice('/api/'.length);
 if(a==='create'){
  if(!MODES.has(d.mode))throw err('Choose a tournament mode.');
  let code;do{code=String(crypto.randomInt(100000,1000000));}while(rooms.has(code));
  const p={id:crypto.randomUUID(),token:crypto.randomBytes(24).toString('hex'),name:safeName(d.name),ready:false,mmr:clamp(d.mmr,100,5000,1000),rankTier:clamp(d.rankTier,0,5,0)};
  const r={code,mode:d.mode,queued:false,players:[p],created:Date.now(),lastActive:Date.now()};
  rooms.set(code,r);
  return send(res,200,{...publicRoom(r),meId:p.id,token:p.token});
 }
 const r=room(d.code);
 if(a==='join'){
  if(r.queued)throw err('This lobby is already in queue.');
  if(r.players.length>=8)throw err('This lobby is full.');
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
  if(r.players.length>1&&!r.players.every(p=>p.ready))throw err('All players must be Ready.');
  r.queued=true;
  return send(res,200,publicRoom(r));
 }
 if(a==='cancel'){
  if(!host)throw err('Only the lobby host can cancel matchmaking.',403);
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
  if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{ok:true,service:'Thrice Autochess test lobby',battlesSynchronized:false});
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
