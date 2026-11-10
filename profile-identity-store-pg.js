'use strict';
/** Thrice test-profile registry backed by Render Postgres.
 * Server-side only: hashes credentials; never logs or returns stored hashes.
 * On a free DB, data expires with the database unless it is upgraded.
 */
const crypto=require('node:crypto');
function create({pool,connectionString,randomBytes=crypto.randomBytes,clock=Date.now}={}){
 if(!pool){
   if(!connectionString||!/^postgres(ql)?:\/\//.test(connectionString))
     throw new Error('DATABASE_URL is required for the persistent profile registry');
   const {Pool}=require('pg');
   pool=new Pool({connectionString,max:5,idleTimeoutMillis:15000,connectionTimeoutMillis:8000});
 }
 const ready=pool.query(`CREATE TABLE IF NOT EXISTS thrice_profile_ids (
    profile_id TEXT PRIMARY KEY,
    credential_hash CHAR(64) NOT NULL,
    created_at_ms BIGINT NOT NULL
  )`).then(()=>true);
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 const validId=id=>typeof id==='string'&&/^PRF-[A-F0-9]{32}$/.test(id);
 async function register(){
   await ready;
   for(let attempts=0;attempts<4;attempts++){
     const profileId='PRF-'+randomBytes(16).toString('hex').toUpperCase();
     const profileSecret=randomBytes(32).toString('base64url');
     try{
       await pool.query('INSERT INTO thrice_profile_ids (profile_id, credential_hash, created_at_ms) VALUES ($1,$2,$3)',
         [profileId,hash(profileSecret),clock()]);
       return {profileId,profileSecret};
     }catch(error){if(error?.code!=='23505')throw error;}
   }
   throw new Error('Could not allocate unique profile ID');
 }
 async function verify(profileId,profileSecret){
   await ready;
   if(!validId(profileId)||typeof profileSecret!=='string'||profileSecret.length<32||profileSecret.length>128)return false;
   const rows=await pool.query('SELECT credential_hash FROM thrice_profile_ids WHERE profile_id=$1 LIMIT 1',[profileId]);
   const stored=rows.rows?.[0]?.credential_hash;
   if(typeof stored!=='string'||!/^[a-f0-9]{64}$/.test(stored))return false;
   return crypto.timingSafeEqual(Buffer.from(stored,'hex'),Buffer.from(hash(profileSecret),'hex'));
 }
 async function health(){await ready;const r=await pool.query('SELECT 1 AS ok');return r.rows?.[0]?.ok===1;}
 return {register,verify,health,ready,pool};
}
module.exports={create};