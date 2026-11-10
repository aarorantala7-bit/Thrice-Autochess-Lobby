// Temporary smoke-test profiles and lobby are removed from matchmaking after verification.
const BASE = 'https://thrice-autochess-lobby-test.onrender.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(path, body, allowed = [200]) {
  const response = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json();
  if (!allowed.includes(response.status)) throw Error(path + ' returned HTTP ' + response.status);
  return {status: response.status, data};
}
function assert(condition, description) { if (!condition) throw Error(description); }
const auth = (profile, extra = {}) => ({...extra, profileId: profile.profileId, profileSecret: profile.profileSecret});
let hostProfile, guestProfile, lobby, guestToken;
let checks = [];
async function register() {
  const {data} = await request('/api/profileRegister', {});
  assert(/^PRF-[A-F0-9]{32}$/.test(data.profileId), 'invalid profile ID');
  assert(typeof data.profileSecret === 'string' && data.profileSecret.length > 32, 'invalid secret');
  const verified = await request('/api/profileVerify', data);
  assert(verified.data.ok === true, 'profile verification failed');
  return data;
}
try {
  let health;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {health = (await request('/health')).data; break;}
    catch (error) {if (attempt === 5) throw error; await sleep(5000);}
  }
  assert(health.ok && health.protocol === 3 && health.profileDatabase === true, 'health/database/protocol mismatch');
  checks.push('health and database');
  const capabilities = (await request('/api/syncCapabilities')).data;
  assert(capabilities.protocol === 3 && capabilities.serverOwnedPhaseClock && capabilities.battlefieldAcknowledgments, 'capabilities mismatch');
  checks.push('protocol and server-owned clock');

  hostProfile = await register();
  guestProfile = await register();
  const invalid = await request('/api/profileVerify', {profileId: hostProfile.profileId, profileSecret: guestProfile.profileSecret}, [403]);
  assert(invalid.status === 403, 'incorrect profile credential accepted');
  checks.push('profile registration and verification');

  lobby = (await request('/api/create', auth(hostProfile, {name:'ThriceSmokeHost',mode:'normal1v1',rankTier:0,mmr:1000}))).data;
  assert(/^\d{6}$/.test(lobby.code) && lobby.token, 'lobby creation failed');
  const joined = (await request('/api/join', auth(guestProfile, {name:'ThriceSmokeGuest',code:lobby.code,rankTier:0,mmr:1000}))).data;
  guestToken = joined.token;
  assert(guestToken && joined.players.length === 2, 'lobby join failed');
  checks.push('create and join lobby');

  const denied = await request('/api/queue', auth(hostProfile, {code:lobby.code,token:lobby.token}), [400,403,404,409]);
  assert(denied.status >= 400, 'queue accepted before all players ready');
  await request('/api/ready', auth(hostProfile, {code:lobby.code,token:lobby.token,ready:true}));
  const ready = (await request('/api/ready', auth(guestProfile, {code:lobby.code,token:guestToken,ready:true}))).data;
  assert(ready.players.every(player => player.ready), 'ready acknowledgement mismatch');
  checks.push('ready acknowledgement and queue gate');

  const queued = (await request('/api/queue', auth(hostProfile, {code:lobby.code,token:lobby.token}))).data;
  assert(queued.matchId, 'two-player match not created');
  const matchId = queued.matchId;
  const before = (await request('/api/matchState',{matchId,token:lobby.token})).data;
  assert(before.protocol === 3 && before.state.id === matchId && before.state.phase === 'awaiting_acceptance', 'wrong match instance or phase');
  await request('/api/matchAccept', {matchId,token:lobby.token});
  const accepted = (await request('/api/matchAccept',{matchId,token:guestToken})).data;
  assert(accepted.state.phase === 'connection_check' && accepted.protocol === 3, 'acceptance handshake stuck');
  assert(accepted.state.phaseEndsAt > accepted.serverNow && accepted.state.phaseRevision >= 1, 'missing authoritative deadline');
  checks.push('match acceptance and server countdown');

  console.log(JSON.stringify({result:'passed',checks,phase:accepted.state.phase,credentialsLogged:false}));
} catch (error) {
  console.error(JSON.stringify({result:'failed',completed:checks,error:error.message}));
  process.exitCode = 1;
} finally {
  if (lobby?.code && hostProfile) {
    try {await request('/api/cancel',auth(hostProfile,{code:lobby.code,token:lobby.token}));} catch {}
    if (guestToken) try {await request('/api/leave',auth(guestProfile,{code:lobby.code,token:guestToken}));} catch {}
    try {await request('/api/leave',auth(hostProfile,{code:lobby.code,token:lobby.token}));} catch {}
  }
}