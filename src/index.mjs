import brand from './brand.json' with { type: 'json' };
import { createApplication } from './app.mjs';
const app=await createApplication({serveStatic:process.argv.includes('--static'),worker:true});
const port=Number(process.env.PORT||process.env.FORMA_PORT||3001);
const host=process.env.HOST||(process.env.FORMA_DEPLOYMENT==='render'?'0.0.0.0':'127.0.0.1');
app.server.listen(port,host,()=>console.log(`${brand.name} API listening on ${host}:${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
