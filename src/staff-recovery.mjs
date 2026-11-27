import brand from './brand.json' with { type: 'json' };
import {createHash,randomBytes,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {audit,requireValue,text,transaction} from './database.mjs';

const derive=promisify(scrypt);
const digest=value=>createHash('sha256').update(value).digest('hex');

export function staffRecovery({db,mail,origin,rate,readBody,send,localMail}) {
  return async (req,res,path)=>{
    if(req.method!=='POST'||!['/api/admin/recover','/api/admin/reset'].includes(path))return false;
    rate(req,path);
    const data=await readBody(req);
    if(path.endsWith('/recover')){
      requireValue(mail,'Email is temporarily unavailable. Try again later.',503);
      const email=text(data.email,120).toLowerCase();
      requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Enter a valid email address.');
      const code=randomBytes(32).toString('hex'),token_hash=digest(code);
      const issue=await transaction(db,async()=>{
        const staff=await db.get('staff_users',{email,active:1});
        if(!staff)return false;
        const filter={staff_id:staff.id};
        const previous=await db.get('staff_recovery',filter);
        if(previous&&Date.now()-previous.created_at<60_000)return false;
        await db.put('staff_recovery',filter,{...filter,token_hash,created_at:Date.now(),expires:new Date(Date.now()+30*60_000)});
        return true;
      });
      if(issue){
        const link=new URL('/admin/reset',origin||`http://${req.headers.host}`);
        link.hash='code='+code;
        try{await mail({to:email,subject:`Reset your ${brand.name} staff password`,link:link.href});}
        catch{
          await db.remove('staff_recovery',{token_hash});
          console.error('Staff account email could not be delivered.');
        }
      }
      send(res,202,{ok:true,localInbox:localMail});
      return true;
    }
    requireValue(typeof data.code==='string'&&/^[a-f0-9]{64}$/.test(data.code),'This link is invalid or has expired.');
    requireValue(typeof data.password==='string'&&data.password.length>=12&&data.password.length<=200,'Use a password between 12 and 200 characters.');
    const filter={token_hash:digest(data.code),expires:{$gt:new Date()}};
    requireValue(await db.get('staff_recovery',filter),'This link is invalid or has expired.');
    const salt=randomBytes(16).toString('hex'),password_hash=(await derive(data.password,salt,64)).toString('hex');
    await transaction(db,async()=>{
      const recovery=await db.get('staff_recovery',filter);
      requireValue(recovery&&await db.get('staff_users',{id:recovery.staff_id,active:1}),'This link is invalid or has expired.');
      const staffId=recovery.staff_id;
      await db.put('staff_users',{id:staffId},{salt,password_hash});
      await db.remove('staff_recovery',{staff_id:staffId});
      await db.remove('sessions',{user_id:staffId});
      await audit(db,{id:staffId},staffId,'staff.password.reset');
    });
    send(res,200,{ok:true});
    return true;
  };
}
